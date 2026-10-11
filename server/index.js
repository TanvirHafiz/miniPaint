/*
 * miniPaint AI: local Runware proxy.
 *
 * Keeps the Runware API key on the server. The browser calls /api/runware with a task array,
 * this proxy adds "Authorization: Bearer <key>" and forwards it to https://api.runware.ai/v1.
 *
 * Key lookup order: process.env.RUNWARE_API_KEY, then server/.env (RUNWARE_API_KEY=...).
 * Mock mode: RUNWARE_MOCK=1 returns placeholder PNGs with cost 0 and never calls Runware.
 *
 * Logging rule: never log the key, headers, prompts or image data. Only task types, models,
 * timings, result counts and cost.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { mockHandle } = require('./mock.js');

const RUNWARE_URL = 'https://api.runware.ai/v1';
const PORT = parseInt(process.env.AI_PROXY_PORT || '8787', 10);
const HOST = process.env.AI_PROXY_HOST || '127.0.0.1';
const UPSTREAM_TIMEOUT_MS = 180000;

/**
 * Minimal .env loader (no dependency). Only sets keys that are not already in process.env.
 */
function load_env_file(file) {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (e) {
		return;
	}
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined || process.env[key] === '') {
			process.env[key] = value;
		}
	}
}

load_env_file(path.join(__dirname, '.env'));
if (process.argv.includes('--mock')) {
	process.env.RUNWARE_MOCK = '1';
}

function get_key() {
	const key = (process.env.RUNWARE_API_KEY || '').trim();
	return key.length > 0 ? key : null;
}

function is_mock() {
	return process.env.RUNWARE_MOCK === '1' || process.env.RUNWARE_MOCK === 'true';
}

/** Short, safe summary of a task array for logs (no prompts, no images). */
function summarize_tasks(tasks) {
	return tasks.map((t) => {
		const parts = [t.taskType || '?', t.model || '-'];
		if (t.width && t.height) parts.push(t.width + 'x' + t.height);
		if (t.numberResults) parts.push('n=' + t.numberResults);
		return parts.join(' ');
	}).join(', ');
}

function total_cost(data) {
	let cost = 0;
	if (Array.isArray(data)) {
		for (const item of data) {
			if (typeof item.cost === 'number') cost += item.cost;
		}
	}
	return cost;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (req, res) => {
	res.json({ ok: true, hasKey: get_key() !== null, mock: is_mock() });
});

app.post('/api/runware', async (req, res) => {
	const started = Date.now();
	const tasks = req.body;

	if (!Array.isArray(tasks) || tasks.length === 0) {
		return res.status(400).json({ errors: [{ code: 'badRequest', message: 'Request body must be a non-empty JSON array of Runware tasks.' }] });
	}
	for (const t of tasks) {
		if (!t || typeof t !== 'object' || typeof t.taskType !== 'string' || typeof t.taskUUID !== 'string') {
			return res.status(400).json({ errors: [{ code: 'badRequest', message: 'Every task needs a string taskType and taskUUID.' }] });
		}
	}
	const summary = summarize_tasks(tasks);

	if (is_mock()) {
		// Optional artificial latency to exercise the UI loading and cancel paths.
		const delay = Math.min(60000, parseInt(process.env.RUNWARE_MOCK_DELAY_MS || '0', 10) || 0);
		if (delay > 0) {
			let client_gone = false;
			res.on('close', () => {
				if (!res.writableEnded) client_gone = true;
			});
			await new Promise((resolve) => setTimeout(resolve, delay));
			if (client_gone) {
				console.log(`[runware] MOCK ${summary} -> client cancelled during ${delay} ms delay`);
				return;
			}
		}
		let out;
		try {
			out = mockHandle(tasks);
		} catch (error) {
			console.log(`[runware] MOCK ${summary} -> mock error: ${error && error.message}`);
			return res.status(500).json({ errors: [{ code: 'mockError', message: 'Mock failed: ' + (error && error.message) }] });
		}
		const count = out.body.data ? out.body.data.length : 0;
		console.log(`[runware] MOCK ${summary} -> HTTP ${out.status}, ${count} result(s), ${Date.now() - started} ms, cost $0.0000`);
		return res.status(out.status).json(out.body);
	}

	const key = get_key();
	if (!key) {
		console.log(`[runware] rejected ${summary}: no API key configured`);
		return res.status(500).json({ errors: [{ code: 'missingApiKey', message: 'RUNWARE_API_KEY is not set on the proxy. Set it as an environment variable (or Codespaces secret), or in server/.env, then restart the proxy. Or run with RUNWARE_MOCK=1.' }] });
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
	// If the browser cancels (AbortController on the client), stop the upstream request too.
	res.on('close', () => {
		if (!res.writableEnded) controller.abort();
	});

	try {
		const upstream = await fetch(RUNWARE_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Bearer ' + key,
			},
			body: JSON.stringify(tasks),
			signal: controller.signal,
		});
		const text = await upstream.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch (e) {
			json = { errors: [{ code: 'badUpstreamResponse', message: 'Runware returned a non-JSON response (HTTP ' + upstream.status + ').' }] };
		}
		const ms = Date.now() - started;
		const count = Array.isArray(json.data) ? json.data.length : 0;
		const errCount = Array.isArray(json.errors) ? json.errors.length : 0;
		console.log(`[runware] ${summary} -> HTTP ${upstream.status}, ${count} result(s), ${errCount} error(s), ${ms} ms, cost $${total_cost(json.data).toFixed(4)}`);
		res.status(upstream.status).json(json);
	} catch (error) {
		const ms = Date.now() - started;
		if (controller.signal.aborted) {
			console.log(`[runware] ${summary} -> aborted after ${ms} ms`);
			if (!res.headersSent && !res.writableEnded) {
				res.status(504).json({ errors: [{ code: 'timeout', message: 'Request to Runware was cancelled or timed out.' }] });
			}
			return;
		}
		// error.message from fetch does not include the key or the body.
		console.log(`[runware] ${summary} -> network error after ${ms} ms: ${error && error.message}`);
		res.status(502).json({ errors: [{ code: 'upstreamUnreachable', message: 'Could not reach api.runware.ai: ' + (error && error.message) }] });
	} finally {
		clearTimeout(timer);
	}
});

// JSON errors (including body too large) instead of HTML stack traces.
app.use((err, req, res, next) => {
	const status = err.status || err.statusCode || 500;
	const message = err.type === 'entity.too.large' ? 'Request body too large (limit 50mb).'
		: err.type === 'entity.parse.failed' ? 'Request body is not valid JSON.'
		: 'Proxy error.';
	console.log(`[proxy] ${req.method} ${req.path} -> ${status} ${err.type || ''}`);
	res.status(status).json({ errors: [{ code: err.type || 'proxyError', message }] });
});

if (require.main === module) {
	app.listen(PORT, HOST, () => {
		console.log(`[proxy] miniPaint AI proxy on http://${HOST}:${PORT} (key: ${get_key() ? 'present' : 'missing'}, mock: ${is_mock() ? 'on' : 'off'})`);
	});
}

module.exports = { app };
