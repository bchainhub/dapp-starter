#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';
import JSON5 from 'json5';
import prompts from 'prompts';
// @ts-ignore - tiged untyped (declaration not included in package)
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
	console.error('  -c,  --cache           use cache dir for repo');
	console.error('  -d,  --dry-run         no writes, script/config/lang skipped');
	console.error('  -nt, --no-translations skip _lang processing');
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
	ensureTemplatesLayout();
}

const TMPLS_DIR = '_templates';

/** Ensure tmpDir has _templates/generator/action so HYGEN_TMPLS can point at _templates; move root-level generator dirs into _templates if needed. */
function ensureTemplatesLayout() {
	const templatesPath = path.join(tmpDir, TMPLS_DIR);
	const actionInTemplates = path.join(templatesPath, generator, action);
	if (fs.existsSync(actionInTemplates)) return;

	// Clone has generator/action at root; create _templates and move generator dirs into it
	fs.mkdirSync(templatesPath, { recursive: true });
	const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
	for (const ent of entries) {
		if (!ent.isDirectory() || ent.name === TMPLS_DIR || ent.name === '.git') continue;
		const src = path.join(tmpDir, ent.name);
		const dest = path.join(templatesPath, ent.name);
		fs.renameSync(src, dest);
	}
}

function resolveActionDir() {
	return path.join(tmpDir, TMPLS_DIR, generator, action);
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

	// Point Hygen at _templates inside the clone (cleaned with tmpDir when !useCache)
	const hygenTmpls = path.join(tmpDir, TMPLS_DIR);
	const result = spawnSync('npx', args, {
		stdio: 'inherit',
		cwd,
		env: { ...process.env, HYGEN_TMPLS: hygenTmpls }
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
		fs.writeFileSync(i18nPath, next);
		applied = true;
	}
	return applied;
}

function runTypesafeI18n() {
	if (dryRun) return;
	const result = spawnSync('npx', ['typesafe-i18n', '--no-watch'], {
		cwd,
		stdio: 'inherit'
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

			const baseIndent = detectModulesBlockIndent(block.raw);
			const newBlock = objectToTs(current, 0, baseIndent);
			const next = src.slice(0, block.start) + newBlock + src.slice(block.end);

			fs.writeFileSync(viteFile, next);
			return;
		}
	}
}

async function main() {
	await fetchAddon();
	ensureTemplatesLayout();

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
