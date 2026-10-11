/*
 * Smoke test for the extracted portable download, used by CI on Linux, macOS and Windows.
 *
 *   node tools/smoke-portable.js <extracted-folder> [port]
 *
 * Starts the real launcher (start.sh or start.bat) in mock mode, then checks that the editor, the API and
 * the access rules work and that the first start created server/.env. Exits non-zero on any failure.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const dir = path.resolve(process.argv[2] || '');
const port = parseInt(process.argv[3] || '8123', 10);
const base = `http://127.0.0.1:${port}`;
const win = process.platform === 'win32';

if (!dir || !fs.existsSync(path.join(dir, win ? 'start.bat' : 'start.sh'))) {
	console.error('Usage: node tools/smoke-portable.js <extracted portable folder> [port]');
	process.exit(2);
}

let failures = 0;
function check(name, ok, detail) {
	console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' (' + detail + ')' : ''));
	if (!ok) failures++;
}

async function status(url, options) {
	const res = await fetch(base + url, options);
	return res;
}

async function waitFor(url, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			const res = await fetch(base + url);
			if (res.ok) return true;
		} catch (e) {}
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

function stop(child) {
	try {
		if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
		else process.kill(-child.pid, 'SIGTERM');
	} catch (e) {}
}

(async () => {
	const envFile = path.join(dir, 'server', '.env');
	fs.rmSync(envFile, { force: true });

	const cmd = win ? 'cmd.exe' : 'bash';
	const args = win ? ['/c', path.join(dir, 'start.bat'), '--mock', '--port', String(port)] : [path.join(dir, 'start.sh'), '--mock', '--port', String(port)];
	let output = '';
	const child = spawn(cmd, args, { cwd: dir, detached: !win, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } });
	child.stdout.on('data', (d) => (output += d));
	child.stderr.on('data', (d) => (output += d));

	const up = await waitFor('/api/health', 30000);
	check('launcher starts the server', up);
	if (up) {
		check('first start created server/.env', fs.existsSync(envFile));
		check('first start explained the key', /RUNWARE_API_KEY/.test(output));

		const health = await (await status('/api/health')).json();
		check('health says mock mode, no key', health.ok === true && health.mock === true && health.hasKey === false, JSON.stringify(health));

		const page = await status('/');
		const html = await page.text();
		check('editor page served', page.status === 200 && /miniPaint/.test(html));
		const bundle = await status('/dist/bundle.js');
		check('bundle served', bundle.status === 200 && (await bundle.text()).length > 100000);
		check('icons served', (await status('/images/icons-studio/brush.svg')).status === 200);

		for (const p of ['/server/index.js', '/server/.env', '/.env', '/package.json', '/node_modules/express/package.json', '/README.txt']) {
			const code = (await status(p)).status;
			check('private path hidden: ' + p, code === 404, 'HTTP ' + code);
		}

		const task = [{ taskType: 'imageInference', taskUUID: '11111111-1111-4111-8111-111111111111', model: 'runware:400@4', positivePrompt: 'smoke', width: 512, height: 512, outputType: 'dataURI' }];
		const gen = await status('/api/runware', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task) });
		const body = await gen.json();
		check('mock Generate returns an image', gen.status === 200 && Array.isArray(body.data) && body.data.length === 1);
	} else {
		console.log('--- launcher output ---\n' + output);
	}

	stop(child);
	await new Promise((r) => setTimeout(r, 500));
	console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
	process.exit(failures ? 1 : 0);
})();
