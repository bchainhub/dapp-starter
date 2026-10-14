#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const [repo, generator, action] = argv;
const options = {};
const booleanFlags = new Set(['apply', 'dry-run', 'cache', 'no-translations', 'no-scripts', 'no-config', 'allow-prompts', 'allow-scripts', 'allow-expressions', 'allow-packages', 'allow-package-scripts', 'run-migrations', 'migrations-only', 'overwrite']);
const valueFlags = new Set(['commit', 'answers', 'migration-target']);
const aliases = { '-c': '--cache', '-d': '--dry-run', '-nt': '--no-translations', '-ns': '--no-scripts', '-nc': '--no-config' };
function usage() {
	console.log(`Usage: node bin/addon.mjs <owner/repo#ref|https-url|local-git-path> <generator> <action> [options]
Default: apply directly to this project. Use --dry-run for static inspection.
  --apply                 explicitly apply (optional; this is the default)
  --commit SHA            optionally pin an exact full commit SHA
  -d, --dry-run            static inspection (cannot be combined with --apply)
  -c, --cache              cache verified source objects by repository and commit outside the project
  --answers JSON          non-secret prompt values as a JSON object
  --allow-prompts          allow prompt.js execution (otherwise use --answers)
  --allow-scripts          allow reviewed plain _scripts.sh (host permissions)
  --allow-expressions      allow raw $expr config values
  --allow-packages         install exact packages declared in addon.json, lifecycle scripts disabled
  --allow-package-scripts  also allow dependency lifecycle scripts
  --run-migrations --migrations-only --migration-target NAME
                          run only declared migrations against an explicit named target
  --overwrite             allow generated templates to replace existing files
  -ns, --no-scripts        skip hidden scripts
  -nc, --no-config         skip config merge
  -nt, --no-translations   skip translation merge`);
}
let tmpDir;
let downloadDir;
let resolvedCommit;
let sourceUrl;
const cwd = fs.realpathSync(process.cwd());
const projectRequire = createRequire(path.join(cwd, 'package.json'));
const pendingWrites = new Map();
const generatedDestinations = new Set();
let ejs;
let JSON5;
let prompts;
let noTranslations;
let noScripts;
let noConfig;
const dryRun = argv.includes('--dry-run') || argv.includes('-d');
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor', '__expr', '__rawObject']);

function parseOptions() {
	for (let i = 3; i < argv.length; i++) {
		const flag = aliases[argv[i]] ?? argv[i];
		const key = flag.slice(2);
		if (!flag.startsWith('--') || (!booleanFlags.has(key) && !valueFlags.has(key))) throw new Error(`Unknown option: ${flag}`);
		if (options[key] !== undefined) throw new Error(`Repeated option: ${flag}`);
		if (valueFlags.has(key)) {
			if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
			options[key] = argv[++i];
		} else options[key] = true;
	}
	for (const [label, value] of [['generator', generator], ['action', action]]) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value ?? '')) throw new Error(`Invalid ${label}: use a single letters/digits/hyphen/underscore segment`);
	}
	if (options.apply && options['dry-run']) throw new Error('--apply and --dry-run are mutually exclusive');
	if (options.commit && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(options.commit)) throw new Error('--commit requires a full commit SHA');
	if (options.commit) options.commit = options.commit.toLowerCase();
	if (options['allow-package-scripts'] && !options['allow-packages']) throw new Error('--allow-package-scripts requires --allow-packages');
	if (options['migrations-only'] !== options['run-migrations']) throw new Error('Migrations require both --migrations-only and --run-migrations');
	if (options['run-migrations'] && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(options['migration-target'] ?? '')) throw new Error('Migrations require an explicit --migration-target NAME (not a credential URL)');
	if (options['migration-target'] && !options['run-migrations']) throw new Error('--migration-target requires --run-migrations');
	if (options['migrations-only'] && ['allow-prompts', 'allow-scripts', 'allow-packages', 'allow-package-scripts', 'allow-expressions', 'overwrite', 'answers'].some((flag) => options[flag])) throw new Error('Migration-only execution cannot include generation, prompts, scripts or packages');
	noTranslations = !!options['no-translations'];
	noScripts = !!options['no-scripts'];
	noConfig = !!options['no-config'];
}

function assertData(value, label = 'data', depth = 0) {
	if (depth > 40) throw new Error(`${label} is nested too deeply`);
	if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return;
	if (Array.isArray(value)) {
		for (const entry of value) assertData(entry, label, depth + 1);
		return;
	}
	if (!isPlainObject(value)) throw new Error(`${label} must contain JSON-compatible data only`);
	for (const [key, entry] of Object.entries(value)) {
		if (unsafeKeys.has(key)) throw new Error(`Unsafe ${label} key: ${key}`);
		assertData(entry, label, depth + 1);
	}
}

function assertRelative(value, label) {
	if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f\\]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
	return value;
}

function projectPath(relative) {
	assertRelative(relative, 'project path');
	if (relative.split('/').some((part) => ['.git', 'node_modules', '.addon-cache'].includes(part))) throw new Error(`Protected project path: ${relative}`);
	const target = path.resolve(cwd, relative);
	if (target === fs.realpathSync(process.argv[1])) throw new Error('An addon cannot overwrite its own runner');
	let current = cwd;
	const parts = relative.split('/');
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		try {
			const stat = fs.lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error(`Symlink destination is not allowed: ${relative}`);
			if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Parent destination is not a directory: ${relative}`);
			if (index === parts.length - 1 && !stat.isFile()) throw new Error(`Destination is not a regular file: ${relative}`);
			if (stat.isFile() && stat.nlink > 1) throw new Error(`Hard-linked destination is not allowed: ${relative}`);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}
	return target;
}

function readProjectFile(file) {
	const target = projectPath(path.relative(cwd, file).split(path.sep).join('/'));
	return pendingWrites.get(target) ?? fs.readFileSync(target, 'utf8');
}

function queueProjectFile(file, content) {
	const target = projectPath(path.relative(cwd, file).split(path.sep).join('/'));
	pendingWrites.set(target, content);
}

function writeProjectFiles() {
	// Validate every destination before the first write; then recheck at each open.
	for (const file of pendingWrites.keys()) projectPath(path.relative(cwd, file).split(path.sep).join('/'));
	for (const [file, content] of pendingWrites) {
		const relative = path.relative(cwd, file).split(path.sep).join('/');
		projectPath(relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		projectPath(relative);
		const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
		try {
			if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink > 1) throw new Error(`Unsafe destination at write time: ${relative}`);
			fs.ftruncateSync(fd, 0);
			fs.writeFileSync(fd, content);
		} finally { fs.closeSync(fd); }
		console.log(`[addon] wrote ${JSON.stringify(relative)}`);
	}
}

function parseSource(spec) {
	if (typeof spec !== 'string' || /[\x00-\x20\x7f]/.test(spec)) throw new Error('Invalid repository');
	const hash = spec.lastIndexOf('#');
	let url = hash < 0 ? spec : spec.slice(0, hash);
	const ref = hash < 0 ? 'HEAD' : spec.slice(hash + 1);
	if (!ref || ref.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..')) throw new Error('Invalid repository ref');
	if (url.startsWith('github:')) url = url.slice(7);
	const ssh = url.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
	if (ssh) url = ssh[1];
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) url = `https://github.com/${url.replace(/\.git$/, '')}.git`;
	if (path.isAbsolute(url)) url = fs.realpathSync(url);
	else {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Use an HTTPS repository without embedded credentials, or an absolute local Git path');
		url = parsed.href;
	}
	return { url, ref };
}

function git(args, directory, input, binary = false) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' });
	const result = spawnSync('git', ['-c', `core.hooksPath=${os.devNull}`, ...args], { cwd: directory, env, input, encoding: binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.error?.message ?? String(result.stderr).trim()}`);
	return result.stdout;
}

async function fetchAddon() {
	const source = parseSource(repo);
	sourceUrl = source.url;
	downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mota-addon-'));
	let gitDir = path.join(downloadDir, 'repo.git');
	git(['init', '--bare', gitDir], cwd);
	// An approved commit is fetched directly, never re-resolved through a moving branch.
	git(['fetch', '--no-tags', '--depth=1', '--', sourceUrl, options.commit ?? source.ref], gitDir);
	resolvedCommit = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], gitDir).trim();
	if (options.commit && resolvedCommit.toLowerCase() !== options.commit.toLowerCase()) throw new Error('Fetched commit differs from the reviewed commit');
	const repositoryKey = createHash('sha256').update(sourceUrl).digest('hex');
	const cacheRoot = fs.realpathSync(os.tmpdir());
	const cachePath = path.join(cacheRoot, 'mota-addon-cache', repositoryKey, resolvedCommit);
	if (options.cache && !dryRun) {
		let parent = cacheRoot;
		for (const part of ['mota-addon-cache', repositoryKey]) {
			parent = path.join(parent, part);
			if (!fs.existsSync(parent)) fs.mkdirSync(parent);
			if (!fs.lstatSync(parent).isDirectory() || fs.lstatSync(parent).isSymbolicLink()) throw new Error('Unsafe source cache directory');
		}
		if (!fs.existsSync(cachePath)) fs.renameSync(gitDir, cachePath);
		gitDir = cachePath;
		if (fs.lstatSync(gitDir).isSymbolicLink()) throw new Error('Symlink source cache is not allowed');
		git(['fsck', '--full', '--strict', '--no-reflogs'], gitDir);
	}
	const entries = git(['ls-tree', '-r', '-z', resolvedCommit], gitDir).split('\0').filter(Boolean).map((entry) => {
		const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
		if (!match || !['100644', '100755'].includes(match[1]) || match[2] !== 'blob') throw new Error('Addon sources must be regular files; symlinks and submodules are not supported');
		assertRelative(match[4], 'source path');
		if (match[4].split('/').includes('.git')) throw new Error('Protected .git source path');
		return { mode: match[1], oid: match[3], name: match[4] };
	});
	tmpDir = path.join(downloadDir, 'source');
	fs.mkdirSync(tmpDir);
	if (entries.length) {
		const blobs = git(['cat-file', '--batch'], gitDir, entries.map((entry) => entry.oid).join('\n') + '\n', true);
		let offset = 0;
		for (const entry of entries) {
			const end = blobs.indexOf(10, offset);
			const header = blobs.subarray(offset, end).toString();
			const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
			if (!match || match[1] !== entry.oid) throw new Error('Invalid source object');
			const size = Number(match[2]);
			const body = blobs.subarray(end + 1, end + 1 + size);
			const digest = createHash(entry.oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${size}\0`).update(body).digest('hex');
			if (body.length !== size || digest !== entry.oid) throw new Error('Source object integrity check failed');
			const file = path.join(tmpDir, entry.name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
			offset = end + size + 2;
		}
	}
}

function resolveActionDir() {
	const nested = path.join(tmpDir, '_templates', generator, action);
	return fs.existsSync(nested) ? nested : path.join(tmpDir, generator, action);
}

function listFiles(directory) {
	const files = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const file = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error('Addon source symlinks are not supported');
		if (entry.isDirectory()) files.push(...listFiles(file));
		else if (entry.isFile()) files.push(file);
	}
	return files;
}

function loadManifest(actionDir) {
	const file = path.join(actionDir, 'addon.json');
	if (!fs.existsSync(file)) return { version: 1 };
	const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
	assertData(manifest, 'manifest');
	if (!isPlainObject(manifest) || manifest.version !== 1) throw new Error('addon.json requires version: 1');
	for (const key of Object.keys(manifest)) if (!['version', 'description', 'packages', 'migrations'].includes(key)) throw new Error(`Unknown addon.json field: ${key}`);
	if (manifest.packages !== undefined) {
		if (!isPlainObject(manifest.packages)) throw new Error('packages must be an object');
		for (const [group, specifications] of Object.entries(manifest.packages)) {
			if (!['dependencies', 'devDependencies'].includes(group) || !Array.isArray(specifications)) throw new Error('packages requires dependencies/devDependencies arrays');
			for (const spec of specifications) if (typeof spec !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec)) throw new Error(`Package must use a name and exact registry version: ${JSON.stringify(spec)}`);
		}
	}
	if (manifest.migrations !== undefined) {
		if (!Array.isArray(manifest.migrations)) throw new Error('migrations must be an array');
		for (const migration of manifest.migrations) {
			if (!isPlainObject(migration) || typeof migration.name !== 'string' || typeof migration.command !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(migration.command) || !Array.isArray(migration.args) || !migration.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')) || Object.keys(migration).some((key) => !['name', 'command', 'args'].includes(key))) throw new Error('Migration requires name, executable command (no path), and a string args array');
			if (!migration.args.some((arg) => arg.includes('{{target}}'))) throw new Error('Every migration must explicitly use {{target}} in its args');
		}
	}
	return manifest;
}

function printPlan(actionDir, manifest) {
	console.log(`[addon] Repository: ${JSON.stringify(sourceUrl)}`);
	console.log(`[addon] Commit: ${resolvedCommit}`);
	console.log(`[addon] Action: ${generator}/${action}`);
	for (const file of listFiles(actionDir)) {
		const relative = path.relative(actionDir, file).split(path.sep).join('/');
		const raw = fs.readFileSync(file, 'utf8');
		const destination = raw.match(/^to:\s*(.*)$/m)?.[1];
		console.log(`[inspect] ${JSON.stringify(relative)}${destination ? ` -> ${JSON.stringify(destination)}${destination.includes('<%') ? ' (dynamic destination: unknown until execution)' : ''}` : ''}`);
	}
	console.log(`[inspect] Declared packages: ${JSON.stringify(manifest.packages ?? {})}`);
	console.log(`[inspect] Declared migrations: ${JSON.stringify(manifest.migrations ?? [])}`);
	console.log('[inspect] EJS, prompts and explicitly allowed shell scripts have host permissions and may have undeclared effects, including installs or DB changes. Stage controls are not a sandbox.');
	console.log(`[stages] generation=${!dryRun && !options['migrations-only'] ? 'enabled' : 'inspection only'} prompts=${!!options['allow-prompts']} scripts=${!!options['allow-scripts'] && !noScripts} packages=${!!options['allow-packages']} lifecycle=${!!options['allow-package-scripts']} migrations=${!!options['run-migrations']} target=${JSON.stringify(options['migration-target'] ?? null)}`);
	if (dryRun) console.log(`[inspect] To apply, omit --dry-run. Optionally pin this source with --commit ${resolvedCommit}. Other executable stages remain opt-in.`);
}

function runCommand(command, args, env = process.env) {
	console.log(`[addon] command ${JSON.stringify([command, ...args])}`);
	const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false });
	if (result.error || result.status !== 0) throw new Error(`Command failed: ${command} (status ${result.status ?? 'unavailable'})`);
}

function installPackages(manifest) {
	if (!options['allow-packages'] || !Object.values(manifest.packages ?? {}).some((specs) => specs.length)) return;
	const packageFile = projectPath('package.json');
	const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
	if ((pkg.packageManager && !pkg.packageManager.startsWith('npm@')) || ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some((name) => fs.existsSync(path.join(cwd, name)))) throw new Error('Declared package installation currently supports npm projects only; use this project\'s manager explicitly instead');
	for (const [group, specs] of Object.entries(manifest.packages ?? {})) {
		if (!specs.length) continue;
		runCommand('npm', ['install', '--save-exact', ...(group === 'devDependencies' ? ['--save-dev'] : []), ...(!options['allow-package-scripts'] ? ['--ignore-scripts'] : []), '--', ...specs]);
	}
}

function runMigrations(manifest) {
	if (!manifest.migrations?.length) throw new Error('No migrations declared in addon.json');
	for (const migration of manifest.migrations) {
		const args = migration.args.map((arg) => arg.replaceAll('{{target}}', options['migration-target']));
		runCommand(migration.command, args, { ...process.env, ADDON_MIGRATION_TARGET: options['migration-target'], ADDON_COMMIT: resolvedCommit });
	}
}

function toFileUrl(file) { return pathToFileURL(file); }

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
}

function deepMerge(target, source) {
	const out = { ...target };
	for (const [key, value] of Object.entries(source)) {
		if (isPlainObject(value) && isPlainObject(out[key])) {
			out[key] = deepMerge(out[key], value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function removeKeys(target, removeSpec) {
	if (!isPlainObject(target) || !removeSpec) return target;

	const out = { ...target };

	if (Array.isArray(removeSpec)) {
		for (const key of removeSpec) delete out[key];
		return out;
	}

	if (typeof removeSpec === 'string') {
		delete out[removeSpec];
		return out;
	}

	if (isPlainObject(removeSpec)) {
		for (const [key, value] of Object.entries(removeSpec)) {
			if (value === true) {
				delete out[key];
			} else if (isPlainObject(value) && isPlainObject(out[key])) {
				out[key] = removeKeys(out[key], value);
			}
		}
	}

	return out;
}

const I18N_INDENT = '\t';

/** @param indentStr - When set, first level uses it and each deeper level adds one tab. @param alignClosingWithKeys - When true and indentStr set, closing "}" aligns with keys (for i18n); otherwise one tab less (for vite config). */
function objectToTs(obj, indent = 0, indentStr = null, alignClosingWithKeys = false) {
	const unit = indentStr ?? I18N_INDENT;
	const pad =
		indentStr != null
			? indentStr + '\t'.repeat(indent)
			: unit.repeat(indent);
	const keyPrefix = indentStr != null ? pad : pad + unit;

	if (Array.isArray(obj)) {
		return `[${obj.map((x) => objectToTs(x, indent, indentStr, alignClosingWithKeys)).join(', ')}]`;
	}

	if (obj && typeof obj === 'object') {
		if (obj.__expr !== undefined) return obj.__expr;

		const entryList = Object.entries(obj);
		if (!entryList.length) return '{}';

		const lines = ['{'];
		entryList.forEach(([key, value], idx) => {
			const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
			const comma = idx < entryList.length - 1 ? ',' : '';
			lines.push(`${keyPrefix}${safeKey}: ${objectToTs(value, indent + 1, indentStr, alignClosingWithKeys)}${comma}`);
		});
		const closingPad =
			indentStr != null
				? (indent === 0 ? indentStr.slice(0, -1) : indentStr + '\t'.repeat(indent - 1))
				: pad;
		lines.push(`${closingPad}}`);
		return lines.join('\n');
	}

	if (typeof obj === 'string') return JSON.stringify(obj);
	if (obj === null) return 'null';
	return String(obj);
}

function extractExpr(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();

	const m = trimmed.match(/^\$expr\(([\s\S]*)\)$/);
	if (!m) return null;
	if (!options['allow-expressions']) throw new Error('Raw $expr values require --allow-expressions');
	const body = m[1].trim();
	return /^(['"])[\s\S]*\1$/.test(body) ? body.slice(1, -1) : body;
}

function replaceExprs(value) {
	if (Array.isArray(value)) return value.map(replaceExprs);

	if (isPlainObject(value)) {
		const out = {};
		for (const [k, v] of Object.entries(value)) {
			const expr = extractExpr(v);
			out[k] = expr !== null ? { __expr: expr } : replaceExprs(v);
		}
		return out;
	}

	return value;
}

function isSubsetMatch(value, match) {
	if (!isPlainObject(value) || !isPlainObject(match)) return value === match;
	return Object.entries(match).every(([key, expected]) =>
		isPlainObject(expected) ? isSubsetMatch(value[key], expected) : value[key] === expected
	);
}

function findClosingToken(source, open, opening, closing) {
	let depth = 1;
	let quote = null;
	for (let i = open + 1; i < source.length; i++) {
		const char = source[i];
		if (quote) {
			if (char === '\\') i++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
		if (char === opening) depth++;
		else if (char === closing && --depth === 0) return i;
	}
	return -1;
}

function parseArrayEntries(source) {
	const entries = [];
	let start = 0;
	let braces = 0;
	let brackets = 0;
	let quote = null;
	for (let i = 0; i <= source.length; i++) {
		const char = source[i];
		if (quote) {
			if (char === '\\') i++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
		if (char === '{') braces++;
		else if (char === '}') braces--;
		else if (char === '[') brackets++;
		else if (char === ']') brackets--;
		if ((char === ',' && braces === 0 && brackets === 0) || i === source.length) {
			const raw = source.slice(start, i).trim();
			if (raw) {
				let value = null;
				try { value = JSON5.parse(raw); } catch { /* Preserve TypeScript expressions. */ }
				entries.push({ raw, value });
			}
			start = i + 1;
		}
	}
	return entries;
}

function composeNavbarArray(source, propertyName, specification) {
	if (!isPlainObject(specification)) return source;
	const navbarMatch = /\bnavbar\s*:\s*\{/.exec(source);
	if (!navbarMatch) return source;
	const navbarOpen = source.indexOf('{', navbarMatch.index);
	const navbarClose = findClosingToken(source, navbarOpen, '{', '}');
	if (navbarClose < 0) return source;
	const navbarSource = source.slice(navbarOpen, navbarClose);
	const itemsMatch = new RegExp(`\\b${propertyName}\\s*:\\s*\\[`).exec(navbarSource);
	if (!itemsMatch) {
		const hasAppend = Array.isArray(specification.$append) && specification.$append.length > 0;
		if (!hasAppend) return source;
		const closingIndent = source.slice(source.lastIndexOf('\n', navbarClose) + 1, navbarClose);
		const propertyIndent = `${closingIndent}\t`;
		const previous = source.slice(0, navbarClose).search(/\S(?=\s*$)/);
		const comma = previous > navbarOpen ? ',' : '';
		const next = source.slice(0, previous + 1) + comma + `\n${propertyIndent}${propertyName}: []` + source.slice(previous + 1);
		return composeNavbarArray(next, propertyName, specification);
	}
	const arrayOpen = source.indexOf('[', navbarOpen + itemsMatch.index);
	const arrayClose = findClosingToken(source, arrayOpen, '[', ']');
	if (arrayClose < 0) return source;

	let entries = parseArrayEntries(source.slice(arrayOpen + 1, arrayClose));
	const remove = Array.isArray(specification.$remove) ? specification.$remove : [];
	entries = entries.filter((entry) => !remove.some((match) => entry.value && isSubsetMatch(entry.value, match)));
	const append = Array.isArray(specification.$append) ? specification.$append : [];
	for (const item of append) {
		if (!entries.some((entry) => entry.value && isSubsetMatch(entry.value, item))) {
			entries.push({ raw: objectToTs(replaceExprs(item)), value: item });
		}
	}

	const closingLine = source.slice(source.lastIndexOf('\n', arrayClose) + 1, arrayClose);
	const closingIndent = closingLine.match(/^\s*/)?.[0] ?? '';
	const itemIndent = `${closingIndent}\t`;
	const body = entries.length
		? `\n${entries.map((entry) => entry.raw.split('\n').map((line) => itemIndent + line).join('\n')).join(',\n')}\n${closingIndent}`
		: '';
	return source.slice(0, arrayOpen + 1) + body + source.slice(arrayClose);
}

async function loadPrompts(actionDir) {
	let answers = options.answers ? JSON.parse(options.answers) : {};
	if (!isPlainObject(answers)) throw new Error('--answers must be a JSON object');
	assertData(answers, 'answers');
	const promptFile = path.join(actionDir, 'prompt.js');
	if (options['allow-prompts'] && fs.existsSync(promptFile)) {
		const mod = await import(toFileUrl(promptFile));
		const exported = mod.default ?? mod;
		const runPrompts = (questions) => prompts(questions, { onCancel: () => { throw new Error('Cancelled'); } });
		const result = typeof exported === 'function'
			? await exported({ prompts: runPrompts, cwd, generator, action, repo, commit: resolvedCommit })
			: Array.isArray(exported) ? await runPrompts(exported) : {};
		answers = { ...result, ...answers };
	}
	assertData(answers, 'answers');
	for (const key of Object.keys(answers)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['generator', 'action', 'templates', 'actionfolder', 'cwd', 'h', 'attributes'].includes(key)) throw new Error(`Reserved or invalid answer key: ${key}`);
	}
	// Never enable the legacy auto-migration prompt through generation.
	if (answers.runMigration) throw new Error('runMigration is disabled during generation; use the separate declared migration stage');
	return answers;
}

function renderTemplates(actionDir, locals) {
	// Use only the installed front-matter/context utilities, not Hygen's runner,
	// project .hygen.js, addon index.js, shell/setup hooks or unsafe YAML loader.
	const hygenRequire = createRequire(projectRequire.resolve('hygen'));
	const frontMatter = hygenRequire('front-matter');
	const context = hygenRequire('./context.js').default;
	const injector = hygenRequire('./ops/injector.js').default;
	const templatesRoot = actionDir.startsWith(path.join(tmpDir, '_templates') + path.sep) ? path.join(tmpDir, '_templates') : tmpDir;
	const templateLocals = context({ ...locals, generator, action, cwd, templates: templatesRoot, actionfolder: actionDir });
	const supported = new Set(['to', 'inject', 'unless_exists', 'force', 'from', 'skip_if', 'before', 'after', 'prepend', 'append', 'at_line', 'eof_last', 'message']);
	for (const file of listFiles(actionDir).filter((file) => file.endsWith('.t'))) {
		const parsed = frontMatter(fs.readFileSync(file, 'utf8'), { allowUnsafe: false });
		assertData(parsed.attributes, 'template attributes');
		const attributes = {};
		for (const [key, value] of Object.entries(parsed.attributes)) {
			if (!supported.has(key)) throw new Error(`Unsupported template attribute ${key}; shell/setup hooks are not allowed`);
			attributes[key] = typeof value === 'string' ? ejs.render(value, templateLocals, { filename: file }) : value;
		}
		if (!attributes.to) continue;
		if (attributes.skip_if === 'true' || attributes.skip_if === true) continue;
		const to = projectPath(attributes.to);
		if (attributes.unless_exists && (pendingWrites.has(to) || fs.existsSync(to))) continue;
		if (attributes.force && !options.overwrite && fs.existsSync(to)) throw new Error(`--overwrite is required to replace ${attributes.to}`);
		let body;
		if (attributes.from) {
			assertRelative(attributes.from, 'template from path');
			const from = path.join(templatesRoot, attributes.from);
			if (!fs.existsSync(from) || !fs.statSync(from).isFile()) throw new Error(`Missing template from file: ${attributes.from}`);
			body = fs.readFileSync(from, 'utf8');
		} else body = ejs.render(parsed.body, { ...templateLocals, attributes }, { filename: file });
		if (attributes.inject) {
			if (!fs.existsSync(to) && !pendingWrites.has(to)) throw new Error(`Injection destination does not exist: ${attributes.to}`);
			body = injector({ attributes, body }, readProjectFile(to));
		} else if ((fs.existsSync(to) || generatedDestinations.has(to)) && !options.overwrite) throw new Error(`--overwrite is required to replace ${attributes.to}`);
		generatedDestinations.add(to);
		queueProjectFile(to, body);
	}
}

function searchDirs(actionDir, subFolder) {
	const sub = path.join(actionDir, subFolder);
	return fs.existsSync(sub) && fs.statSync(sub).isDirectory() ? [actionDir, sub] : [actionDir];
}

function selectedHiddenScript(actionDir) {
	for (const dir of searchDirs(actionDir, '_scripts')) {
		for (const name of ['_scripts.ejs.sh', '_scripts.sh']) {
			const file = path.join(dir, name);
			if (fs.existsSync(file)) return file;
		}
	}
	return null;
}

function runHiddenScript(actionDir, locals) {
	if (noScripts || !options['allow-scripts']) return;
	const script = selectedHiddenScript(actionDir);
	if (!script) return;
	// Prompt strings are data in the environment, never interpolated into shell source.
	const env = { ...process.env, ADDON_REPO: sourceUrl, ADDON_COMMIT: resolvedCommit, ADDON_GENERATOR: generator, ADDON_ACTION: action, ADDON_CONTEXT_JSON: JSON.stringify(locals) };
	for (const [key, value] of Object.entries(locals)) env[`ADDON_VAR_${key.toUpperCase()}`] = typeof value === 'object' ? JSON.stringify(value) : String(value);
	runCommand('bash', [script], env);
}

function findModulesBlock(content) {
	const re = /\bmodules\s*:\s*\{/;
	const startMatch = content.search(re);
	if (startMatch === -1) return null;

	const openBrace = content.indexOf('{', startMatch);
	let depth = 1;
	let i = openBrace + 1;

	while (i < content.length && depth > 0) {
		const ch = content[i];
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
		i++;
	}

	return {
		start: openBrace,
		end: i,
		raw: content.slice(openBrace, i)
	};
}

/** Detect the indent string used for the first level inside the modules block (e.g. "\\t\\t" or "    "). Preserves visual consistency on install/uninstall. */
function detectModulesBlockIndent(blockRaw) {
	const m = blockRaw.match(/\n([\t ]+)[A-Za-z_$"']/);
	return m ? m[1] : '\t';
}

/** Return index after the end of one value (string/array/object/primitive) in inner starting at start; respects strings and balanced [] {}. */
function consumeOneValue(inner, start) {
	let i = start;
	let depth = 0;
	let inString = null;
	while (i < inner.length) {
		const ch = inner[i];
		if (inString) {
			if (ch === '\\') {
				i += 2;
				continue;
			}
			if (ch === inString) {
				inString = null;
				i++;
				continue;
			}
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === '`') {
			inString = ch;
			i++;
			continue;
		}
		if (ch === '[' || ch === '{') {
			depth++;
			i++;
			continue;
		}
		if (ch === ']' || ch === '}') {
			depth--;
			i++;
			continue;
		}
		if ((ch === ',' || ch === '}') && depth === 0) return i;
		i++;
	}
	return i;
}

function parseTopLevelTsObject(tsObjectText) {
	const inner = tsObjectText.trim().replace(/^\{/, '').replace(/\}$/, '');
	if (!inner.trim()) return {};

	const result = {};
	let i = 0;

	while (i < inner.length) {
		while (i < inner.length && /[\s,]/.test(inner[i])) i++;
		if (i >= inner.length) break;

		const keyMatch = inner.slice(i).match(/^([A-Za-z_$][A-Za-z0-9_$]*|"[^"]+"|'[^']+')\s*:/);
		if (!keyMatch) break;

		const rawKey = keyMatch[1];
		const key = rawKey.startsWith('"') || rawKey.startsWith("'")
			? rawKey.slice(1, -1)
			: rawKey;

		i += keyMatch[0].length;

		while (i < inner.length && /\s/.test(inner[i])) i++;

		if (inner[i] === '{') {
			let depth = 1;
			const start = i;
			i++;
			let inStr = null;
			while (i < inner.length && depth > 0) {
				const c = inner[i];
				if (inStr) {
					if (c === '\\') {
						i += 2;
						continue;
					}
					if (c === inStr) {
						inStr = null;
						i++;
						continue;
					}
					i++;
					continue;
				}
				if (c === '"' || c === "'" || c === '`') {
					inStr = c;
					i++;
					continue;
				}
				if (c === '{') depth++;
				else if (c === '}') depth--;
				i++;
			}
			result[key] = { __rawObject: inner.slice(start, i) };
			continue;
		}

		const start = i;
		i = consumeOneValue(inner, i);
		const rawValue = inner.slice(start, i).trim();
		result[key] = { __expr: rawValue };
	}

	return result;
}

function rawObjectMapToPlain(map) {
	const out = {};
	for (const [key, value] of Object.entries(map)) {
		if (value && value.__rawObject) {
			out[key] = { __expr: value.__rawObject };
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Clean generator to a valid JS key for modules (e.g. "mota-support" -> "motaSupport"). */
function cleanModuleName(name) {
	if (!name || typeof name !== 'string') return 'module';
	return name
		.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
		.replace(/-/g, '')
		.replace(/[^A-Za-z0-9_$]/g, '') || 'module';
}

/** Find the first top-level object in i18n index.ts (const x = { ... }). */
function findI18nRootObject(content) {
	const eqBrace = content.indexOf('= {');
	if (eqBrace === -1) return null;
	const start = content.indexOf('{', eqBrace);
	if (start === -1) return null;
	let depth = 1;
	let i = start + 1;
	while (i < content.length && depth > 0) {
		const ch = content[i];
		if (ch === '"' || ch === "'" || ch === '`') {
			const q = ch;
			i++;
			while (i < content.length && content[i] !== q) {
				if (content[i] === '\\') i++;
				i++;
			}
			i++;
			continue;
		}
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
		i++;
	}
	return { start, end: i, raw: content.slice(start, i) };
}

/** Parse a TS/JS string literal (double- or single-quoted) from expr; return unwrapped string or null if not a string literal. */
function parseStringLiteralFromExpr(expr) {
	if (typeof expr !== 'string') return null;
	const trimmed = expr.trim();
	const q = trimmed[0];
	if (q !== '"' && q !== "'") return null;
	if (trimmed.length < 2 || trimmed[trimmed.length - 1] !== q) return null;
	if (q === '"') {
		try {
			return JSON.parse(trimmed);
		} catch {
			return null;
		}
	}
	// Single-quoted: unescape and return inner (TS allows single quotes)
	let inner = '';
	for (let i = 1; i < trimmed.length - 1; i++) {
		if (trimmed[i] === '\\') {
			i++;
			inner += { "'": "'", n: '\n', r: '\r', t: '\t', '\\': '\\' }[trimmed[i]] ?? trimmed[i];
		} else {
			inner += trimmed[i];
		}
	}
	// If inner is a double-quoted string (e.g. '"foo"' from JSON), parse it to avoid double-escaping on re-serialize
	if (inner.length >= 2 && inner[0] === '"' && inner[inner.length - 1] === '"') {
		try {
			return JSON.parse(inner);
		} catch {
			// fall through to return inner
		}
	}
	return inner;
}

/** Convert parsed TS object map (key -> __rawObject | __expr) to plain nested object for merging. */
function parseTsObjectToPlain(map) {
	const out = {};
	for (const [key, value] of Object.entries(map)) {
		if (value && value.__rawObject !== undefined) {
			const inner = parseTopLevelTsObject(value.__rawObject);
			out[key] = parseTsObjectToPlain(inner);
		} else if (value && value.__expr !== undefined) {
			const unwrapped = parseStringLiteralFromExpr(value.__expr);
			if (unwrapped !== null) {
				// Previously corrupted: string literal whose JSON text is array/object source — emit raw, not JSON.stringify again
				if (typeof unwrapped === 'string' && /^[[{]/.test(unwrapped.trim())) {
					out[key] = { __expr: unwrapped };
				} else {
					out[key] = unwrapped;
				}
			} else {
				// Arrays, objects, $expr(...), numbers as text, etc.: wrap so objectToTs emits raw TS (not JSON.stringify)
				out[key] = { __expr: value.__expr };
			}
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Serialize parsed map (key -> __rawObject | __expr) back to TS object string. keyIndent: prefix for each key (root = '\\t', first nested = '\\t\\t'). @param doubleBlankBetweenEntries - if true, blank line between top-level keys (i18n root only). */
function mapToTsRaw(map, keyIndent = I18N_INDENT, doubleBlankBetweenEntries = false) {
	const entries = Object.entries(map).filter(([, v]) => v && (v.__rawObject !== undefined || v.__expr !== undefined));
	const lines = entries.map(([key, value], idx) => {
		const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
		const comma = idx < entries.length - 1 ? ',' : '';
		if (value.__rawObject !== undefined) {
			return `${keyIndent}${safeKey}: ${value.__rawObject}${comma}`;
		}
		return `${keyIndent}${safeKey}: ${value.__expr}${comma}`;
	});
	const closingPad = keyIndent.length > 1 ? keyIndent.slice(0, -1) : '';
	const sep = doubleBlankBetweenEntries ? '\n\n' : '\n';
	return '{\n' + lines.join(sep) + '\n' + closingPad + '}';
}

/** Apply _lang files into src/i18n/<lang>/index.ts. Returns true if any file was written. */
function applyHiddenLang(actionDir, locals) {
	if (noTranslations) return false;
	let applied = false;
	const langEntries = [];
	for (const dir of searchDirs(actionDir, '_lang')) {
		const isLangDir = path.basename(dir) === '_lang';
		const names = fs.readdirSync(dir, { withFileTypes: true })
			.filter((d) => {
				if (!d.isFile() || (!d.name.endsWith('.json5') && !d.name.endsWith('.ejs.json5'))) return false;
				return isLangDir || d.name.startsWith('_lang.');
			})
			.map((d) => d.name);
		for (const name of names) {
			const match = name.match(isLangDir
				? /^([a-z]{2,})(?:\.([a-z0-9_.]+))?\.(ejs\.)?json5$/i
				: /^_lang\.([a-z]{2,})(?:\.([a-z0-9_.]+))?\.(ejs\.)?json5$/i);
			if (!match) continue;
			const lang = match[1];
			const pathSuffix = match[2];
			const hasEjs = !!match[3];
			langEntries.push({ dir, name, lang, pathSuffix, hasEjs });
		}
	}

	const cleanedGenerator = cleanModuleName(generator);
	const defaultPath = `modules.${cleanedGenerator}`;

	for (const { dir, name, lang, pathSuffix, hasEjs } of langEntries) {
		const langCode = lang.toLowerCase();
		const pathFromFile = hasEjs ? undefined : pathSuffix;
		const i18nPath = path.join(cwd, 'src', 'i18n', langCode, 'index.ts');
		if (!fs.existsSync(i18nPath) && !pendingWrites.has(i18nPath)) {
			if (!dryRun) console.warn(`[addon] Skipping _lang: src/i18n/${langCode}/index.ts not found`);
			continue;
		}
		if (dryRun) {
			console.log(`[dry-run] would apply _lang from ${name} -> src/i18n/${langCode}/index.ts`);
			continue;
		}

		let text = fs.readFileSync(path.join(dir, name), 'utf8');
		if (hasEjs) {
			text = ejs.render(text, locals, { filename: path.join(actionDir, name) });
		}
		let parsed = JSON5.parse(text);
			assertData(parsed, 'config/translation');
			if (!isPlainObject(parsed)) throw new Error('Config/translation must be an object');
		parsed = replaceExprs(parsed);

		const $remove = parsed.$remove;
		const $path = parsed.$path ?? (pathFromFile || defaultPath);
		delete parsed.$remove;
		delete parsed.$path;

		if (typeof $path !== 'string' || !$path.split('.').every((part) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) && !unsafeKeys.has(part))) throw new Error('Unsafe translation $path');
		const pathParts = $path.split('.');
		if (pathParts.length < 1) continue;

		const src = readProjectFile(i18nPath);
		const rootBlock = findI18nRootObject(src);
		if (!rootBlock) {
			console.warn(`[addon] No root object found in ${i18nPath}`);
			continue;
		}

		const rootMap = parseTopLevelTsObject(rootBlock.raw);
		// Depth 1 = root key (modules): first level uses 2 tabs. Depth 2 = modules.support: first level uses 3 tabs, etc.
		const i18nIndentForDepth = (depth) => '\t'.repeat(1 + depth);
		if (pathParts.length === 1) {
			const key = pathParts[0];
			const current = rootMap[key]?.__rawObject
				? parseTsObjectToPlain(parseTopLevelTsObject(rootMap[key].__rawObject))
				: {};
			let merged = deepMerge(isPlainObject(current) ? current : {}, parsed);
			merged = removeKeys(merged, $remove);
			rootMap[key] = { __rawObject: objectToTs(merged, 0, i18nIndentForDepth(1), true) };
		} else {
			const topKey = pathParts[0];
			const rest = pathParts.slice(1);
			const lastKey = rest[rest.length - 1];
			const topRaw = rootMap[topKey]?.__rawObject || '{}';
			const topMap = parseTopLevelTsObject(topRaw);
			const stack = [topMap];
			let inner = topMap;
			for (let i = 0; i < rest.length - 1; i++) {
				inner = parseTopLevelTsObject(inner[rest[i]]?.__rawObject || '{}');
				stack.push(inner);
			}
			const lastRaw = inner[lastKey]?.__rawObject || '{}';
			const lastPlain = parseTsObjectToPlain(parseTopLevelTsObject(lastRaw));
			let merged = deepMerge(isPlainObject(lastPlain) ? lastPlain : {}, parsed);
			merged = removeKeys(merged, $remove);
			inner[lastKey] = { __rawObject: objectToTs(merged, 0, i18nIndentForDepth(pathParts.length), true) };
			for (let i = stack.length - 1; i > 0; i--) {
				const nestedKeyIndent = '\t'.repeat(1 + i);
				stack[i - 1][rest[i - 1]] = { __rawObject: mapToTsRaw(stack[i], nestedKeyIndent) };
			}
			rootMap[topKey] = { __rawObject: mapToTsRaw(topMap, i18nIndentForDepth(1)) };
		}

		const newRootRaw = mapToTsRaw(rootMap, I18N_INDENT, true);
		const next = src.slice(0, rootBlock.start) + newRootRaw + src.slice(rootBlock.end);
		queueProjectFile(i18nPath, next);
		applied = true;
	}
	return applied;
}

function runTypesafeI18n() {
	console.log('[addon] Translation dictionaries changed. Regenerate types with the project i18n:extract script after reviewing the diff.');
}

function applyHiddenConfig(actionDir, locals) {
	if (noConfig) return;
	const candidates = ['_config.ejs.json5', '_config.json5'];

	for (const dir of searchDirs(actionDir, '_config')) {
		for (const name of candidates) {
			const file = path.join(dir, name);
			if (!fs.existsSync(file)) continue;
			if (dryRun) {
				console.log(`[dry-run] skipping config ${name}`);
				return;
			}

			let text = fs.readFileSync(file, 'utf8');
			if (name.endsWith('.ejs.json5')) {
				text = ejs.render(text, locals, { filename: file });
			}

			let parsed = JSON5.parse(text);
			assertData(parsed, 'config/translation');
			if (!isPlainObject(parsed)) throw new Error('Config/translation must be an object');
			parsed = replaceExprs(parsed);
			const navbarItems = parsed.$navbarItems;
			delete parsed.$navbarItems;
			const authItems = parsed.$authItems;
			delete parsed.$authItems;

			const viteFile = path.join(cwd, 'vite.config.ts');
			if (!fs.existsSync(viteFile) && !pendingWrites.has(viteFile)) return;

			const src = readProjectFile(viteFile);
			let composedSrc = composeNavbarArray(src, 'items', navbarItems);
			composedSrc = composeNavbarArray(composedSrc, 'authItems', authItems);
			const block = findModulesBlock(composedSrc);
			if (!block) {
				console.warn('No modules block found in vite.config.ts');
				return;
			}

			const currentMap = parseTopLevelTsObject(block.raw);
			let current = rawObjectMapToPlain(currentMap);

			const removeSpec = parsed.$remove;
			delete parsed.$remove;

			current = removeKeys(current, removeSpec);
			current = deepMerge(current, parsed);

			const baseIndent = detectModulesBlockIndent(block.raw);
			const newBlock = objectToTs(current, 0, baseIndent);
			const next = composedSrc.slice(0, block.start) + newBlock + composedSrc.slice(block.end);

			queueProjectFile(viteFile, next);
			return;
		}
	}
}

async function main() {
	if (argv.includes('--help') || argv.includes('-h')) { usage(); return; }
	if (!repo || !generator || !action) { usage(); throw new Error('Repository, generator and action are required'); }
	parseOptions();
	await fetchAddon();
	const actionDir = resolveActionDir();
	if (!fs.existsSync(actionDir) || !fs.statSync(actionDir).isDirectory()) throw new Error(`Addon action not found: ${generator}/${action}`);
	const manifest = loadManifest(actionDir);
	printPlan(actionDir, manifest);
	if (dryRun) return;
	if (options['migrations-only']) { runMigrations(manifest); return; }
	const script = selectedHiddenScript(actionDir);
	if (options['allow-scripts'] && !noScripts && script && /<%/.test(fs.readFileSync(script, 'utf8'))) throw new Error('Templated shell scripts are no longer supported. Use plain _scripts.sh with validated ADDON_VAR_* environment values; declare packages/migrations in addon.json.');
	ejs = projectRequire('ejs');
	JSON5 = projectRequire('json5');
	prompts = projectRequire('prompts');
	const locals = await loadPrompts(actionDir);
	renderTemplates(actionDir, locals);
	applyHiddenConfig(actionDir, locals);
	const langApplied = applyHiddenLang(actionDir, locals);
	writeProjectFiles();
	installPackages(manifest);
	runHiddenScript(actionDir, locals);
	if (langApplied) runTypesafeI18n();
}

main().catch((error) => {
	console.error(`[addon] ${error.message}`);
	process.exitCode = 1;
}).finally(() => {
	if (downloadDir) fs.rmSync(downloadDir, { recursive: true, force: true });
});
