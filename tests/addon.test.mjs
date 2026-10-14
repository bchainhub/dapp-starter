import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, 'scripts/addon.mjs');
function git(cwd, ...args) {
	const result = spawnSync('git', ['-c', `core.hooksPath=${os.devNull}`, ...args], { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
function write(root, name, text) {
	const file = path.join(root, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}
function template(destination, body = 'generated\n', extra = '') {
	return `---\nto: ${destination}\n${extra}---\n${body}`;
}
function fixture(t, files = {}) {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mota-addon-test-')));
	const source = path.join(home, 'repo');
	const app = path.join(home, 'app');
	fs.mkdirSync(source); fs.mkdirSync(app);
	write(source, 'package.json', '{"type":"module"}');
	write(source, 'demo/install/file.ejs.t', template('src/generated.ts'));
	for (const [name, value] of Object.entries(files)) write(source, `demo/install/${name}`, value);
	git(source, 'init', '-b', 'main');
	git(source, 'add', '.');
	git(source, '-c', 'user.name=Addon Test', '-c', 'user.email=addon@example.invalid', 'commit', '-m', 'fixture');
	const commit = git(source, 'rev-parse', 'HEAD');
	write(app, 'package.json', '{"type":"module","private":true}');
	write(app, 'vite.config.ts', 'export default { themeConfig: { navbar: { items: [] } }, modules: {} };\n');
	fs.symlinkSync(path.join(root, 'node_modules'), path.join(app, 'node_modules'), 'dir');
	t.after(() => {
		fs.rmSync(home, { recursive: true, force: true });
		const key = createHash('sha256').update(source).digest('hex');
		fs.rmSync(path.join(os.tmpdir(), 'mota-addon-cache', key), { recursive: true, force: true });
	});
	return { home, source, app, commit };
}
function run(f, args = [], env = {}) {
	return spawnSync(process.execPath, [runner, f.source, 'demo', 'install', ...args], { cwd: f.app, encoding: 'utf8', env: { ...process.env, ...env } });
}
const apply = (f, ...args) => ['--apply', '--commit', f.commit, ...args];
function ok(result) { assert.equal(result.status, 0, result.stderr + result.stdout); }
function rejected(result, pattern) { assert.notEqual(result.status, 0); assert.match(result.stderr, pattern); }
function snapshot(directory) {
	const result = {};
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) { result[entry.name] = fs.readlinkSync(path.join(directory, entry.name)); continue; }
		result[entry.name] = entry.isDirectory() ? snapshot(path.join(directory, entry.name)) : fs.readFileSync(path.join(directory, entry.name), 'utf8');
	}
	return result;
}

test('dry-run executes no code and does not write project/cache files', (t) => {
	const f = fixture(t, {
		'prompt.js': "import fs from 'node:fs'; fs.writeFileSync(process.env.ADDON_TEST_MARKER, 'prompt'); export default [];",
		'file.ejs.t': template('src/<%= dynamicRoute %>.ts', "<% process.getBuiltinModule('fs').writeFileSync(process.env.ADDON_TEST_MARKER, 'ejs') %>"),
		'_scripts.sh': 'printf script > "$ADDON_TEST_MARKER"\n',
		'_config.ejs.json5': "<% process.getBuiltinModule('fs').writeFileSync(process.env.ADDON_TEST_MARKER, 'config') %>{}",
		'addon.json': JSON.stringify({ version: 1, packages: { dependencies: ['zod@4.6.7'] }, migrations: [{ name: 'db', command: 'node', args: ['{{target}}'] }] })
	});
	const marker = path.join(f.home, 'executed');
	const before = snapshot(f.app);
	const dry = run(f, ['--dry-run', '--cache', '--allow-prompts', '--allow-scripts', '--allow-packages'], { ADDON_TEST_MARKER: marker }); ok(dry);
	assert.match(dry.stdout, /dynamic destination: unknown/);
	assert.match(dry.stdout, /Declared packages/);
	assert.match(dry.stdout, new RegExp(f.commit));
	assert.equal(fs.existsSync(marker), false);
	assert.deepEqual(snapshot(f.app), before);
	assert.equal(fs.existsSync(path.join(f.app, '.addon-cache')), false);
	assert.equal(fs.existsSync(path.join(os.tmpdir(), 'mota-addon-cache', createHash('sha256').update(f.source).digest('hex'))), false);
});

test('explicit apply conflicts with dry-run; optional commit and other inputs are validated', (t) => {
	const f = fixture(t);
	rejected(run(f, [...apply(f), '--dry-run']), /mutually exclusive/);
	rejected(run(f, ['--commit', 'HEAD']), /full commit SHA/);
	rejected(run(f, ['--allow-package-scripts']), /requires --allow-packages/);
	for (const segment of ['../demo', '/absolute', '..', 'demo/install', 'demo\\install']) {
		const result = spawnSync(process.execPath, [runner, f.source, segment, 'install'], { cwd: f.app, encoding: 'utf8' });
		rejected(result, /Invalid generator/);
	}
});

test('apply writes directly, renders .t and .ejs.t, and does not execute project/addon Hygen hooks', (t) => {
	const f = fixture(t, {
		'other.ts.t': template('src/other.ts', 'export const route = <%- JSON.stringify(route) %>;\n'),
		'index.js': "throw new Error('addon hook executed');",
		'_config.json5': '{ feature: { enabled: true }, $navbarItems: { $append: [{ to: "/feature", label: "Feature" }] } }',
		'prompt.js': "throw new Error('prompt executed without permission');"
	});
	write(f.app, '.hygen.js', "throw new Error('project hook executed');");
	ok(run(f, apply(f, '--answers', '{"route":"hello"}')));
	assert.equal(fs.readFileSync(path.join(f.app, 'src/generated.ts'), 'utf8'), 'generated\n');
	assert.match(fs.readFileSync(path.join(f.app, 'src/other.ts'), 'utf8'), /"hello"/);
	assert.match(fs.readFileSync(path.join(f.app, 'vite.config.ts'), 'utf8'), /feature/);
	assert.equal(fs.existsSync(path.join(f.app, 'prompt.js')), false);
});

test('all destinations are checked before any generated file is written', (t) => {
	const f = fixture(t, { 'z-escape.t': template('../outside') });
	const before = snapshot(f.app);
	rejected(run(f, apply(f)), /Unsafe project path/);
	assert.deepEqual(snapshot(f.app), before);
	assert.equal(fs.existsSync(path.join(f.home, 'outside')), false);
});

for (const destination of ['/tmp/escape', 'C:\\escape', 'src/../escape', '.git/config', 'node_modules/evil.js', 'src\\escape']) {
	test(`rejects destination ${destination}`, (t) => {
		const f = fixture(t, { 'file.ejs.t': template(destination) });
		rejected(run(f, apply(f)), /Unsafe project path|Protected project path/);
		assert.equal(fs.existsSync(path.join(f.app, 'src/generated.ts')), false);
	});
}

test('rejects symlink directories, final symlinks and hard-linked outputs', (t) => {
	const f = fixture(t);
	const outside = path.join(f.home, 'outside'); fs.mkdirSync(outside);
	write(outside, 'secret', 'untouched');
	fs.symlinkSync(outside, path.join(f.app, 'src'), 'dir');
	rejected(run(f, apply(f)), /Symlink destination/);
	fs.unlinkSync(path.join(f.app, 'src'));fs.mkdirSync(path.join(f.app, 'src'));
	fs.symlinkSync(path.join(outside, 'secret'), path.join(f.app, 'src/generated.ts'));
	rejected(run(f, apply(f, '--overwrite')), /Symlink destination/);
	fs.unlinkSync(path.join(f.app, 'src/generated.ts'));
	fs.linkSync(path.join(outside, 'secret'), path.join(f.app, 'src/generated.ts'));
	rejected(run(f, apply(f, '--overwrite')), /Hard-linked destination/);
	assert.equal(fs.readFileSync(path.join(outside, 'secret'), 'utf8'), 'untouched');
});

test('validates dynamic prompt-derived destinations without invoking prompt.js', (t) => {
	const f = fixture(t, { 'file.ejs.t': template('<%= route %>') });
	rejected(run(f, apply(f, '--answers', '{"route":"../escape"}')), /Unsafe project path/);
	rejected(run(f, apply(f, '--answers', '{"__proto__":{"polluted":true}}')), /Unsafe answers key/);
	rejected(run(f, apply(f, '--answers', '{"generator":"other"}')), /Reserved or invalid answer/);
});

test('prompts run only with explicit permission and cannot opt generation into migrations', (t) => {
	const f = fixture(t, { 'prompt.js': 'export default async () => ({ runMigration: true });' });
	rejected(run(f, apply(f, '--allow-prompts')), /runMigration is disabled/);
	assert.equal(fs.existsSync(path.join(f.app, 'src/generated.ts')), false);
});

test('rejects unsafe YAML, shell/setup template hooks and config prototype/expression wrappers', (t) => {
	const f = fixture(t, { 'file.ejs.t': template('src/generated.ts', 'x', 'sh: touch anything\n') });
	rejected(run(f, apply(f)), /shell\/setup hooks/);
	const prototype = fixture(t, { '_config.json5': '{ "__proto__": { polluted: true } }' });
	rejected(run(prototype, apply(prototype)), /Unsafe config\/translation key/);
	assert.equal(fs.existsSync(path.join(prototype.app, 'src/generated.ts')), false);
	const expression = fixture(t, { '_config.json5': '{ value: { __expr: "process.exit()" } }' });
	rejected(run(expression, apply(expression)), /Unsafe config\/translation key/);
	const yaml = fixture(t, { 'file.ejs.t': template('src/generated.ts', 'x', 'message: !!js/function "function () { return 1; }"\n') });
	rejected(run(yaml, apply(yaml)), /unknown tag/);
});

test('raw config expressions require a separate permission', (t) => {
	const f = fixture(t, { '_config.json5': '{ value: "$expr(Math.PI)" }' });
	rejected(run(f, apply(f)), /require --allow-expressions/);
	assert.equal(fs.existsSync(path.join(f.app, 'src/generated.ts')), false);
	ok(run(f, apply(f, '--allow-expressions')));
	assert.match(fs.readFileSync(path.join(f.app, 'vite.config.ts'), 'utf8'), /value: Math\.PI/);
});

test('script values stay in environment data and templated shell interpolation is rejected', (t) => {
	const f = fixture(t, { '_scripts.sh': 'printf "%s" "$ADDON_VAR_PAYLOAD" > script-result\n' });
	const marker = path.join(f.home, 'injected');
	const payload = `$(touch ${marker}); \`touch ${marker}\``;
	ok(run(f, apply(f, '--answers', JSON.stringify({ payload }))));
	assert.equal(fs.existsSync(path.join(f.app, 'script-result')), false);
	ok(run(f, apply(f, '--overwrite', '--allow-scripts', '--answers', JSON.stringify({ payload }))));
	assert.equal(fs.readFileSync(path.join(f.app, 'script-result'), 'utf8'), payload);
	assert.equal(fs.existsSync(marker), false);
	const legacy = fixture(t, { '_scripts.ejs.sh': 'printf "<%= payload %>"\n' });
	rejected(run(legacy, apply(legacy, '--allow-scripts')), /Templated shell scripts/);
	assert.equal(fs.existsSync(path.join(legacy.app, 'src/generated.ts')), false);
});

test('package installation is opt-in, uses literal argv, and disables lifecycle scripts by default', (t) => {
	const f = fixture(t, { 'addon.json': JSON.stringify({ version: 1, packages: { dependencies: ['zod@4.6.7'] } }) });
	const commands = path.join(f.home, 'commands'); fs.mkdirSync(commands);
	const log = path.join(f.home, 'npm-args');
	write(commands, 'npm', `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ADDON_TEST_NPM_LOG,JSON.stringify(process.argv.slice(2)));\n`);
	fs.chmodSync(path.join(commands, 'npm'), 0o755);
	const env = { PATH: commands + path.delimiter + process.env.PATH, ADDON_TEST_NPM_LOG: log };
	ok(run(f, apply(f), env)); assert.equal(fs.existsSync(log), false);
	ok(run(f, apply(f, '--overwrite', '--allow-packages'), env));
	assert.deepEqual(JSON.parse(fs.readFileSync(log)), ['install', '--save-exact', '--ignore-scripts', '--', 'zod@4.6.7']);
	const bad = fixture(t, { 'addon.json': JSON.stringify({ version: 1, packages: { dependencies: ['zod@4.6.7;touch /tmp/injected'] } }) });
	rejected(run(bad), /exact registry version/);
});

test('migrations require a separate invocation and target, and never generate files', (t) => {
	const f = fixture(t, { 'addon.json': JSON.stringify({ version: 1, migrations: [{ name: 'fixture migration', command: 'node', args: ['-e', "require('node:fs').writeFileSync('migration-target',process.argv[1])", '{{target}}'] }] }) });
	ok(run(f, apply(f)));
	assert.equal(fs.existsSync(path.join(f.app, 'migration-target')), false);
	rejected(run(f, apply(f, '--run-migrations')), /both --migrations-only/);
	rejected(run(f, apply(f, '--run-migrations', '--migrations-only')), /explicit --migration-target/);
	fs.unlinkSync(path.join(f.app, 'src/generated.ts'));
	ok(run(f, apply(f, '--run-migrations', '--migrations-only', '--migration-target', 'test-local')));
	assert.equal(fs.readFileSync(path.join(f.app, 'migration-target'), 'utf8'), 'test-local');
	assert.equal(fs.existsSync(path.join(f.app, 'src/generated.ts')), false);
});

test('source symlinks cannot escape the reviewed source tree', (t) => {
	const f = fixture(t);
	fs.symlinkSync('/tmp', path.join(f.source, 'demo/install/escape'));
	git(f.source, 'add', '.');git(f.source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'symlink');
	rejected(run(f), /symlinks and submodules/);
});

test('a moving branch cannot replace the reviewed commit, even with caching', (t) => {
	const f = fixture(t);
	const review = run(f, ['--dry-run']);ok(review);assert.match(review.stdout, new RegExp(f.commit));
	write(f.source, 'demo/install/file.ejs.t', template('src/generated.ts', 'new branch content'));
	git(f.source, 'add', '.');git(f.source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'move branch');
	ok(run(f, apply(f, '--cache')));
	assert.equal(fs.readFileSync(path.join(f.app, 'src/generated.ts'), 'utf8'), 'generated\n');
	const newCommit = git(f.source, 'rev-parse', 'HEAD');
	ok(run(f, ['--apply', '--commit', newCommit, '--cache', '--overwrite']));
	assert.equal(fs.readFileSync(path.join(f.app, 'src/generated.ts'), 'utf8'), 'new branch content');
	const cache = path.join(os.tmpdir(), 'mota-addon-cache', createHash('sha256').update(f.source).digest('hex'), newCommit);
	fs.mkdirSync(path.join(cache, 'objects', newCommit.slice(0, 2)), { recursive: true });
	const objectFile = path.join(cache, 'objects', newCommit.slice(0, 2), newCommit.slice(2));
	fs.rmSync(objectFile, { force: true });
	fs.writeFileSync(objectFile, 'corrupted');
	rejected(run(f, ['--apply', '--commit', newCommit, '--cache', '--overwrite']), /Git fsck failed/);
});

test('translation paths reject prototype traversal and symlink writes', (t) => {
	const f = fixture(t, { '_lang/en.json5': '{ $path: "modules.__proto__", title: "Bad" }' });
	write(f.app, 'src/i18n/en/index.ts', 'const translation = { modules: {} }; export default translation;\n');
	rejected(run(f, apply(f)), /Unsafe translation \$path/);
	assert.equal(fs.existsSync(path.join(f.app, 'src/generated.ts')), false);
});


test('plain config and translation merges remain supported without running generators automatically', (t) => {
	const f = fixture(t, { '_lang/en.json5': '{ $path: "modules.demo", title: "Hello" }' });
	write(f.app, 'src/i18n/en/index.ts', 'const translation = { modules: {} }; export default translation;\n');
	const result = run(f, apply(f));ok(result);
	assert.match(fs.readFileSync(path.join(f.app, 'src/i18n/en/index.ts'), 'utf8'), /title: "Hello"/);
	assert.match(result.stdout, /Regenerate types/);
});

test('static inspection works without installed application dependencies', (t) => {
	const f = fixture(t);
	fs.unlinkSync(path.join(f.app, 'node_modules'));
	ok(run(f, ['--dry-run']));
});


test('nested _templates layout supports bounded from and injection operations', (t) => {
	const f = fixture(t);
	write(f.source, '_templates/demo/install/copy.t', template('src/copied.ts', '', 'from: shared/content.txt\n'));
	write(f.source, '_templates/shared/content.txt', 'copied content\n');
	write(f.source, '_templates/demo/install/inject.t', template('existing.ts', 'inserted', 'inject: true\nafter: marker\n'));
	write(f.app, 'existing.ts', 'marker\nend\n');
	git(f.source, 'add', '.');git(f.source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'nested layout');
	f.commit = git(f.source, 'rev-parse', 'HEAD');
	ok(run(f, apply(f)));
	assert.equal(fs.readFileSync(path.join(f.app, 'src/copied.ts'), 'utf8'), 'copied content\n');
	assert.match(fs.readFileSync(path.join(f.app, 'existing.ts'), 'utf8'), /marker\ninserted\nend/);
});

test('overwrite requires caller permission even when a template sets force', (t) => {
	const f = fixture(t, { 'file.ejs.t': template('existing.ts', 'replacement', 'force: true\n') });
	write(f.app, 'existing.ts', 'original');
	rejected(run(f, apply(f)), /--overwrite is required/);
	assert.equal(fs.readFileSync(path.join(f.app, 'existing.ts'), 'utf8'), 'original');
	ok(run(f, apply(f, '--overwrite')));
	assert.equal(fs.readFileSync(path.join(f.app, 'existing.ts'), 'utf8'), 'replacement');
});


test('applying is the default and follows the selected ref without requiring a commit', (t) => {
	const f = fixture(t);
	ok(run(f));
	assert.equal(fs.readFileSync(path.join(f.app, 'src/generated.ts'), 'utf8'), 'generated\n');
	write(f.source, 'demo/install/file.ejs.t', template('src/generated.ts', 'updated default branch'));
	git(f.source, 'add', '.');git(f.source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'update default');
	const result = run(f, ['--overwrite']);ok(result);
	assert.match(result.stdout, new RegExp(git(f.source, 'rev-parse', 'HEAD')));
	assert.equal(fs.readFileSync(path.join(f.app, 'src/generated.ts'), 'utf8'), 'updated default branch');
});

test('--apply remains an optional explicit alias and does not require a commit', (t) => {
	const f = fixture(t);
	ok(run(f, ['--apply']));
	assert.equal(fs.readFileSync(path.join(f.app, 'src/generated.ts'), 'utf8'), 'generated\n');
});

test('migration-only execution supports optional pinning and dry-run', (t) => {
	const f = fixture(t, { 'addon.json': JSON.stringify({ version: 1, migrations: [{ name: 'fixture', command: 'node', args: ['-e', "require('node:fs').writeFileSync('migration-target',process.argv[1])", '{{target}}'] }] }) });
	const migrationArgs = ['--run-migrations', '--migrations-only', '--migration-target', 'test-local'];
	ok(run(f, [...migrationArgs, '--dry-run']));
	assert.equal(fs.existsSync(path.join(f.app, 'migration-target')), false);
	ok(run(f, migrationArgs));
	assert.equal(fs.readFileSync(path.join(f.app, 'migration-target'), 'utf8'), 'test-local');
	assert.equal(fs.existsSync(path.join(f.app, 'src/generated.ts')), false);
});
