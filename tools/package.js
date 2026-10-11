/*
 * Builds the portable download: release/miniPaint-AI-<version>-portable.zip
 *
 *   npm run package                       (builds first, version from package.json)
 *   node tools/package.js --version v0.1.0 [--no-build] [--no-zip]
 *
 * The zip holds the built editor, the server (Express only, node_modules included, so users only need
 * Node.js), start scripts and a short README. It never contains server/.env or any API key.
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const portable = path.join(__dirname, 'portable');

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(arg('--version', 'v' + rootPkg.version)).replace(/[^A-Za-z0-9._-]/g, '-');
const name = `miniPaint-AI-${version}-portable`;
const outDir = path.join(root, 'release');
const stage = path.join(outDir, name);

function rm(p) {
	fs.rmSync(p, { recursive: true, force: true });
}
function copy(from, to) {
	fs.cpSync(from, to, { recursive: true });
}

if (!flag('--no-build')) {
	console.log('Building the editor...');
	execSync('npm run build', { cwd: root, stdio: 'inherit' });
}

rm(stage);
fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });

// Editor files (no source map, no private project files).
copy(path.join(root, 'index.html'), path.join(stage, 'index.html'));
copy(path.join(root, 'dist', 'bundle.js'), path.join(stage, 'dist', 'bundle.js'));
const licenseFile = path.join(root, 'dist', 'bundle.js.LICENSE.txt');
if (fs.existsSync(licenseFile)) copy(licenseFile, path.join(stage, 'dist', 'bundle.js.LICENSE.txt'));
copy(path.join(root, 'images'), path.join(stage, 'images'));

// Server. .env.example only: never the real .env.
for (const f of ['index.js', 'mock.js', 'serve.js', '.env.example']) {
	copy(path.join(root, 'server', f), path.join(stage, 'server', f));
}
copy(path.join(root, 'MIT-LICENSE.txt'), path.join(stage, 'MIT-LICENSE.txt'));

// Launchers, README and a minimal package.json with only the server's runtime dependency.
for (const f of ['start.bat', 'start.sh', 'README.txt', 'package.json']) {
	copy(path.join(portable, f), path.join(stage, f));
}
if (process.platform !== 'win32') fs.chmodSync(path.join(stage, 'start.sh'), 0o755);

console.log('Installing server dependencies (express only)...');
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', { cwd: stage, stdio: 'inherit' });

// Safety net: no secrets or private files in the package.
const forbidden = [];
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.name === '.env' || entry.name.endsWith('.map') || entry.name === 'plan.md') forbidden.push(p);
		if (entry.isDirectory() && entry.name !== 'node_modules') walk(p);
	}
})(stage);
if (forbidden.length) {
	console.error('Refusing to package, forbidden files found:\n' + forbidden.join('\n'));
	process.exit(1);
}

if (flag('--no-zip')) {
	console.log('Staged at ' + stage);
	process.exit(0);
}

const zipPath = path.join(outDir, name + '.zip');
rm(zipPath);
let result;
if (process.platform === 'win32') {
	// bsdtar ships with Windows 10 and later and writes standard zip files. Call it by full path: Git Bash
	// puts GNU tar first, which cannot write zips. Relative paths avoid "C:" being read as a host name.
	const bsdtar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
	result = spawnSync(fs.existsSync(bsdtar) ? bsdtar : 'tar', ['-a', '-c', '-f', name + '.zip', name], { cwd: outDir, stdio: 'inherit' });
} else {
	result = spawnSync('zip', ['-r', '-q', zipPath, name], { cwd: outDir, stdio: 'inherit' });
}
if (result.status !== 0) {
	console.error('Could not create the zip. The staged folder is at ' + stage);
	process.exit(1);
}
const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
console.log(`Created ${path.relative(root, zipPath)} (${mb} MB)`);
