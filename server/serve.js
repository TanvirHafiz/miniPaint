/*
 * miniPaint AI: single-process production server for the portable download.
 * Serves the built editor (index.html, dist/, images/) and the Runware proxy on one port.
 *
 *   node server/serve.js [--mock] [--open] [--port 8080] [--host 127.0.0.1]
 *
 * Only the editor files are served, never the server folder, .env or other project files.
 * The API key stays in server/.env (or the RUNWARE_API_KEY environment variable).
 */

const path = require('path');
const { exec } = require('child_process');
const express = require('express');
const { app } = require('./index.js');

const root = path.join(__dirname, '..');

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = parseInt(arg('--port', process.env.PORT || '8080'), 10);
const host = arg('--host', process.env.HOST || '127.0.0.1');

// Static files after the API routes registered in index.js.
app.get('/', (req, res) => res.sendFile(path.join(root, 'index.html')));
app.use('/dist', express.static(path.join(root, 'dist'), { index: false, dotfiles: 'ignore' }));
app.use('/images', express.static(path.join(root, 'images'), { index: false, dotfiles: 'ignore' }));
app.get('/service-worker.js', (req, res) => res.status(404).end());

const server = app.listen(port, host, () => {
	const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
	const mock = process.argv.includes('--mock');
	console.log('');
	console.log('  miniPaint AI is running: ' + url);
	console.log('  Press Ctrl+C to stop.');
	if (mock) console.log('  Mock mode: AI results are fake and free.');
	console.log('');
	if (process.argv.includes('--open')) {
		const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
		exec(cmd, () => {});
	}
});

server.on('error', (error) => {
	if (error.code === 'EADDRINUSE') {
		console.error(`Port ${port} is already in use. Close the other program or run: node server/serve.js --port ${port + 1}`);
	} else {
		console.error('Could not start the server: ' + error.message);
	}
	process.exit(1);
});
