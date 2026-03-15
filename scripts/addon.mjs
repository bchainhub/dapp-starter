#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import ejs from 'ejs';
import JSON5 from 'json5';
import prompts from 'prompts';
import tiged from 'tiged';

const [, , repo, generator, action, ...rest] = process.argv;

if (!repo || !generator || !action) {
	console.error('Usage: addon <repo> <generator> <action> [--cache] [--dry-run]');
	process.exit(1);
}

const cwd = process.cwd();
const useCache = rest.includes('--cache');
const dryRun = rest.includes('--dry-run');

const cacheDir = path.join(cwd, '.addon-cache', repo.replace(/[/:@]/g, '_'));
const tmpDir = useCache ? cacheDir : fs.mkdtempSync(path.join(os.tmpdir(), 'addon-'));

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
	const emitter = tiged(repo, { mode: 'git' });
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

function runHiddenScript(actionDir, locals) {
	const candidates = ['_scripts.ejs.sh', '_scripts.sh'];

	for (const name of candidates) {
		const file = path.join(actionDir, name);
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

function applyHiddenConfig(actionDir, locals) {
	const candidates = ['_config.ejs.json5', '_config.json5'];

	for (const name of candidates) {
		const file = path.join(actionDir, name);
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

	if (!useCache) {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
