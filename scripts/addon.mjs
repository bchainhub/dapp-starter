#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';
import JSON5 from 'json5';
import prompts from 'prompts';
import tiged from 'tiged';

const restArgs = process.argv.slice(2);
const repo = restArgs[0];
const generator = restArgs[1];
const action = restArgs[2];
let noTranslations = false;
let noScripts = false;
let noConfig = false;
const rest = restArgs.slice(3).filter((arg) => {
	if (arg === '--no-translations' || arg === '-nt') { noTranslations = true; return false; }
	if (arg === '--no-scripts' || arg === '-ns') { noScripts = true; return false; }
	if (arg === '--no-config' || arg === '-nc') { noConfig = true; return false; }
	return true;
});

if (!repo || !generator || !action) {
	console.error('Usage: addon <repo> <generator> <action> [options]');
	console.error('  -c, --cache            use cache dir for repo');
	console.error('  -d, --dry-run          no writes, script/config/lang skipped');
	console.error('  -nt, --no-translations  skip _lang processing');
	console.error('  -ns, --no-scripts      skip _scripts execution');
	console.error('  -nc, --no-config       skip _config merge');
	process.exit(1);
}

const cwd = process.cwd();
const useCache = rest.includes('--cache') || rest.includes('-c');
const dryRun = rest.includes('--dry-run') || rest.includes('-d');

const cacheDir = path.join(cwd, '.addon-cache', repo.replace(/[/:@]/g, '_'));
const tmpDir = useCache ? cacheDir : fs.mkdtempSync(path.join(os.tmpdir(), 'addon-'));

/** Normalize repo to HTTPS URL so clone works without SSH keys (avoids "Permission denied (publickey)"). */
function repoToHttps(repoSpec) {
	const s = String(repoSpec).trim();
	// Already HTTPS
	if (s.startsWith('https://')) return s;
	// SSH GitHub
	const sshGitHub = s.match(/^git@github\.com:([^/]+\/[^/#]+)(?:\.git)?(#.*)?$/);
	if (sshGitHub) return `https://github.com/${sshGitHub[1]}${sshGitHub[2] || ''}`;
	// Shorthand: owner/repo or owner/repo#ref
	if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(#.*)?$/.test(s)) return `https://github.com/${s}`;
	// github:owner/repo or github:owner/repo#ref
	if (s.startsWith('github:')) return `https://github.com/${s.slice(7)}`;
	return s;
}

function toFileUrl(p) {
	return new URL(`file://${p}`);
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
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

function objectToTs(obj, indent = 0) {
	const pad = '  '.repeat(indent);

	if (Array.isArray(obj)) {
		return `[${obj.map((x) => objectToTs(x, indent)).join(', ')}]`;
	}

	if (obj && typeof obj === 'object') {
		if (obj.__expr !== undefined) return obj.__expr;

		const entries = Object.entries(obj);
		if (!entries.length) return '{}';

		const lines = ['{'];
		for (const [key, value] of entries) {
			const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
			lines.push(`${pad}  ${safeKey}: ${objectToTs(value, indent + 1)},`);
		}
		lines.push(`${pad}}`);
		return lines.join('\n');
	}

	if (typeof obj === 'string') return JSON.stringify(obj);
	if (obj === null) return 'null';
	return String(obj);
}

function extractExpr(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();

	const m = trimmed.match(/^\$expr\((['"])([\s\S]*)\1\)$/);
	return m ? m[2] : null;
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

async function fetchAddon() {
	if (useCache && fs.existsSync(tmpDir)) return;

	fs.mkdirSync(tmpDir, { recursive: true });
	// Use HTTPS URL so clone works without SSH keys (public repos)
	const cloneUrl = repoToHttps(repo);
	const emitter = tiged(cloneUrl, { mode: 'git' });
	await emitter.clone(tmpDir);
}

function resolveActionDir() {
	return path.join(tmpDir, generator, action);
}

async function loadPrompts(actionDir) {
	const promptFile = path.join(actionDir, 'prompt.js');
	if (!fs.existsSync(promptFile)) return {};

	const mod = await import(toFileUrl(promptFile));
	const exported = mod.default ?? mod;

	if (typeof exported === 'function') {
		const result = await exported({ prompts, cwd, generator, action, repo });
		return result || {};
	}

	if (Array.isArray(exported)) {
		return await prompts(exported);
	}

	return {};
}

function buildCliArgsFromLocals(locals) {
	return Object.entries(locals).flatMap(([key, value]) => {
		if (value === undefined || value === null) return [];
		if (typeof value === 'object') return [`--${key}`, JSON.stringify(value)];
		return [`--${key}`, String(value)];
	});
}

function runHygen(locals) {
	const args = [
		'hygen',
		generator,
		action,
		...buildCliArgsFromLocals(locals)
	];

	const result = spawnSync('npx', args, {
		stdio: 'inherit',
		cwd
	});

	if (result.status !== 0) process.exit(result.status ?? 1);
}

function renderEjsFile(filePath, locals) {
	const raw = fs.readFileSync(filePath, 'utf8');
	return ejs.render(raw, locals, { filename: filePath });
}

/** Return list of dirs to search: [actionDir, actionDir/subFolder] if subFolder exists. */
function searchDirs(actionDir, subFolder) {
	const dirs = [actionDir];
	const sub = path.join(actionDir, subFolder);
	if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) dirs.push(sub);
	return dirs;
}

function runHiddenScript(actionDir, locals) {
	if (noScripts) return;
	const candidates = ['_scripts.ejs.sh', '_scripts.sh'];

	for (const dir of searchDirs(actionDir, '_scripts')) {
		for (const name of candidates) {
			const file = path.join(dir, name);
			if (!fs.existsSync(file)) continue;
			if (dryRun) {
				console.log(`[dry-run] skipping script ${name}`);
				return;
			}

			let script = fs.readFileSync(file, 'utf8');
			if (name.endsWith('.ejs.sh')) {
				script = ejs.render(script, locals, { filename: file });
			}

			const tmpScript = path.join(os.tmpdir(), `addon-script-${Date.now()}.sh`);
			fs.writeFileSync(tmpScript, script, { mode: 0o755 });

			const env = {
				...process.env,
				ADDON_REPO: repo,
				ADDON_GENERATOR: generator,
				ADDON_ACTION: action,
				ADDON_CONTEXT_JSON: JSON.stringify(locals)
			};

			for (const [key, value] of Object.entries(locals)) {
				const envKey = `ADDON_VAR_${String(key).toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
				env[envKey] = typeof value === 'object' ? JSON.stringify(value) : String(value);
			}

			const result = spawnSync('bash', [tmpScript], {
				stdio: 'inherit',
				cwd,
				env
			});

			fs.rmSync(tmpScript, { force: true });

			if (result.status !== 0) process.exit(result.status ?? 1);
			return;
		}
	}
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

		if (inner[i] !== '{') {
			let start = i;
			while (i < inner.length && inner[i] !== ',') i++;
			const rawValue = inner.slice(start, i).trim();
			result[key] = { __expr: rawValue };
			continue;
		}

		let depth = 1;
		let start = i;
		i++;

		while (i < inner.length && depth > 0) {
			if (inner[i] === '{') depth++;
			else if (inner[i] === '}') depth--;
			i++;
		}

		const rawObj = inner.slice(start, i);
		result[key] = { __rawObject: rawObj };
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

/** Convert parsed TS object map (key -> __rawObject | __expr) to plain nested object for merging. */
function parseTsObjectToPlain(map) {
	const out = {};
	for (const [key, value] of Object.entries(map)) {
		if (value && value.__rawObject !== undefined) {
			const inner = parseTopLevelTsObject(value.__rawObject);
			out[key] = parseTsObjectToPlain(inner);
		} else if (value && value.__expr !== undefined) {
			out[key] = value.__expr;
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** Serialize parsed map (key -> __rawObject | __expr) back to TS object string. */
function mapToTsRaw(map) {
	const lines = [];
	for (const [key, value] of Object.entries(map)) {
		const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
		if (value && value.__rawObject !== undefined) {
			lines.push(`  ${safeKey}: ${value.__rawObject},`);
		} else if (value && value.__expr !== undefined) {
			lines.push(`  ${safeKey}: ${value.__expr},`);
		}
	}
	return '{\n' + lines.join('\n') + '\n}';
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
		if (!fs.existsSync(i18nPath)) {
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
		parsed = replaceExprs(parsed);

		const $remove = parsed.$remove;
		const $path = parsed.$path ?? (pathFromFile || defaultPath);
		delete parsed.$remove;
		delete parsed.$path;

		const pathParts = $path.split('.').filter(Boolean);
		if (pathParts.length < 1) continue;

		const src = fs.readFileSync(i18nPath, 'utf8');
		const rootBlock = findI18nRootObject(src);
		if (!rootBlock) {
			console.warn(`[addon] No root object found in ${i18nPath}`);
			continue;
		}

		const rootMap = parseTopLevelTsObject(rootBlock.raw);
		if (pathParts.length === 1) {
			const key = pathParts[0];
			const current = rootMap[key]?.__rawObject
				? parseTsObjectToPlain(parseTopLevelTsObject(rootMap[key].__rawObject))
				: {};
			let merged = deepMerge(isPlainObject(current) ? current : {}, parsed);
			merged = removeKeys(merged, $remove);
			rootMap[key] = { __rawObject: objectToTs(merged, 0) };
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
			inner[lastKey] = { __rawObject: objectToTs(merged, 0) };
			for (let i = stack.length - 1; i > 0; i--) {
				stack[i - 1][rest[i - 1]] = { __rawObject: mapToTsRaw(stack[i]) };
			}
			rootMap[topKey] = { __rawObject: mapToTsRaw(topMap) };
		}

		const newRootRaw = mapToTsRaw(rootMap);
		const next = src.slice(0, rootBlock.start) + newRootRaw + src.slice(rootBlock.end);
		fs.writeFileSync(i18nPath, next);
		applied = true;
	}
	return applied;
}

function runTypesafeI18n() {
	if (dryRun) return;
	const result = spawnSync('npx', ['typesafe-i18n', '--no-watch'], {
		cwd,
		stdio: 'inherit',
		shell: true
	});
	if (result.status !== 0) {
		console.warn('[addon] typesafe-i18n failed or is not installed; i18n types may be out of date.');
	}
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
			parsed = replaceExprs(parsed);

			const viteFile = path.join(cwd, 'vite.config.ts');
			if (!fs.existsSync(viteFile)) return;

			const src = fs.readFileSync(viteFile, 'utf8');
			const block = findModulesBlock(src);
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

			const newBlock = objectToTs(current, 0);
			const next = src.slice(0, block.start) + newBlock + src.slice(block.end);

			fs.writeFileSync(viteFile, next);
			return;
		}
	}
}

async function main() {
	await fetchAddon();

	const actionDir = resolveActionDir();
	if (!fs.existsSync(actionDir)) {
		console.error(`Addon action not found: ${generator}/${action}`);
		process.exit(1);
	}

	const locals = await loadPrompts(actionDir);

	runHygen(locals);
	runHiddenScript(actionDir, locals);
	applyHiddenConfig(actionDir, locals);
	const langApplied = applyHiddenLang(actionDir, locals);
	if (langApplied) runTypesafeI18n();

	if (!useCache) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
