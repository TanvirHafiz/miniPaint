/*
 * Starts the Runware proxy and the webpack dev server together (no extra dependencies).
 * Usage: npm run start:ai            (Ctrl+C stops both)
 *        npm run start:ai -- --mock  (proxy in mock mode)
 */

const { spawn } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const children = [];

function run(name, cmd, args) {
	const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
	const prefix = (line) => `[${name}] ${line}`;
	const pipe = (stream, out) => {
		let buffer = '';
		stream.on('data', (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop();
			for (const line of lines) out.write(prefix(line) + '\n');
		});
	};
	pipe(child.stdout, process.stdout);
	pipe(child.stderr, process.stderr);
	child.on('exit', (code) => {
		console.log(prefix(`exited with code ${code}`));
		shutdown(code || 0);
	});
	children.push(child);
}

let stopping = false;
function shutdown(code) {
	if (stopping) return;
	stopping = true;
	for (const c of children) {
		if (c.exitCode === null) c.kill('SIGTERM');
	}
	setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const webpackCli = require.resolve('webpack-cli/bin/cli.js', { paths: [root] });
run('proxy', process.execPath, [path.join(__dirname, 'index.js'), ...process.argv.slice(2)]);
run('web', process.execPath, [webpackCli, 'serve', '--mode', 'development', '--env', 'development', '--no-open']);
