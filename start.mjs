#!/usr/bin/env node
/**
 * Dapp starter — full interactive setup using @clack/prompts.
 * Run: node start.mjs [--template=URL] [--template-version=REF] [args for sv create]
 * Update mode: node start.mjs --update [--template=URL] [--template-version=REF]  (overwrites from template except vite.config.ts)
 * Template version: URL can include @version (e.g. ...mota-dapp.git@1.2.3). Else use --template-version/--tv. If both omitted, uses repo default branch (git ls-remote).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
	intro,
	outro,
	confirm,
	select,
	multiselect,
	text,
	spinner,
	log,
	isCancel,
	cancel
} from '@clack/prompts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STARTER_DIR = __dirname;

const TEMPLATE_URL = 'https://github.com/bchainhub/mota-dapp.git';
const STARTER_REPO_RAW = 'https://cdn.jsdelivr.net/gh/bchainhub/dapp-starter';
const CORE_LICENSE_URL = 'https://cdn.jsdelivr.net/gh/bchainhub/core-license@main/LICENSE';

// Ctrl+C exits immediately (including during sv create)
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// Parse argv: --update/-u, --template/-t=URL, --template-version/--tv=REF, rest passed to sv create
let templateUrl = TEMPLATE_URL;
let templateVersion = null; // alternative to URL@version; used when URL has no @ref (e.g. mota-dapp or -t without @). null = repo default branch
let updateMode = false;
const passArgs = [];
for (let i = 2; i < process.argv.length; i++) {
	const arg = process.argv[i];
	if (arg === '--update' || arg === '-u') {
		updateMode = true;
	} else if (arg === '--template' && process.argv[i + 1]) {
		templateUrl = process.argv[++i];
	} else if (arg === '-t' && process.argv[i + 1]) {
		templateUrl = process.argv[++i];
	} else if (arg.startsWith('--template=')) {
		templateUrl = arg.slice('--template='.length);
	} else if (arg.startsWith('-t=')) {
		templateUrl = arg.slice(3);
	} else if (arg === '--template-version' && process.argv[i + 1]) {
		templateVersion = process.argv[++i];
	} else if (arg === '--tv' && process.argv[i + 1]) {
		templateVersion = process.argv[++i];
	} else if (arg.startsWith('--template-version=')) {
		templateVersion = arg.slice('--template-version='.length);
	} else if (arg.startsWith('--tv=')) {
		templateVersion = arg.slice(5);
	} else {
		passArgs.push(arg);
	}
}

function run(cmd, args = [], opts = {}) {
	const result = spawnSync(cmd, args, {
		stdio: opts.inherit ? 'inherit' : 'pipe',
		shell: opts.shell ?? false,
		cwd: opts.cwd || process.cwd(),
		encoding: opts.encoding,
		...opts
	});
	return result;
}

const LOADING_EMOJIS = ['🔄', '⏳', '📦', '🚀', '✨', '🔧', '📥', '⚙️', '🌐', '📂'];
/** Start rotating random emoji on stderr so terminal doesn't look frozen. Returns stop(). */
function startEmojiRotation(message = ' working…') {
	const id = setInterval(() => {
		const emoji = LOADING_EMOJIS[Math.floor(Math.random() * LOADING_EMOJIS.length)];
		process.stderr.write(`\r ${emoji}${message}   `);
	}, 350);
	return () => {
		clearInterval(id);
		process.stderr.write('\r' + ' '.repeat(40) + '\r');
	};
}

/**
 * Parse template URL; supports jsDelivr-style version at the end: URL@version (e.g. ...mota-dapp.git@1.2.3).
 * Returns { baseUrl, refFromUrl }; refFromUrl is null if no @version in URL.
 */
function parseTemplateUrl(url) {
	const i = url.lastIndexOf('@');
	if (i <= 0) return { baseUrl: url, refFromUrl: null };
	const baseUrl = url.slice(0, i);
	const refFromUrl = url.slice(i + 1).trim() || null;
	return { baseUrl: baseUrl || url, refFromUrl };
}

/** Get the default branch of a remote repo (e.g. main, master) via git ls-remote. */
function getDefaultBranch(repoUrl) {
	const tpl = repoUrl.replace(/\.git$/, '') + '.git';
	const result = run('git', ['ls-remote', '--symref', tpl, 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
	const match = result.stdout?.match(/ref: refs\/heads\/(\S+)\s+HEAD/);
	return match ? match[1].trim() : 'main';
}

function runNpx(args, opts = {}) {
	return run('npx', ['--yes', ...args], opts);
}

function appendIfMissing(filePath, pattern) {
	if (!fs.existsSync(filePath)) return;
	const content = fs.readFileSync(filePath, 'utf8');
	if (content.includes(pattern)) return;
	fs.appendFileSync(filePath, pattern + '\n');
}

function ensureLineInFile(filePath, line) {
	if (!fs.existsSync(filePath)) {
		fs.writeFileSync(filePath, line + '\n');
		return;
	}
	const content = fs.readFileSync(filePath, 'utf8');
	if (content.includes(line)) return;
	const hasNewline = content.endsWith('\n');
	fs.appendFileSync(filePath, (hasNewline ? '' : '\n') + line + '\n');
}

function addScriptsToPackageJson(pkgPath, scripts) {
	if (!fs.existsSync(pkgPath)) return;
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.scripts = pkg.scripts || {};
	Object.assign(pkg.scripts, scripts);
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

function composeReadme(opts) {
	const runDev =
		opts.pm === 'pnpm' ? 'pnpm dev' :
		opts.pm === 'yarn' ? 'yarn dev' :
		opts.pm === 'bun' ? 'bun run dev' :
		'npm run dev';

	const installCmd =
		opts.pm === 'pnpm' ? 'pnpm install' :
		opts.pm === 'yarn' ? 'yarn' :
		opts.pm === 'bun' ? 'bun install' :
		'npm install';

	const lines = [
		`# ${opts.projectName}`,
		'',
		'MOTA dApp (SvelteKit, Core Blockchain, multi-chain).',
		'',
		'## Overview',
		'',
		'- SvelteKit + MOTA stack',
		'- Addon CLI: `npx addon <repo> <generator> <action>`',
		'- Hidden addon control files supported: `prompt.js`, `_scripts.ejs.sh` / `_scripts.sh`, `_config.ejs.json5` / `_config.json5`'
	];

	if (opts.installTranslations) lines.push('- **i18n** – typesafe-i18n (see [Translations](#translations))');
	if (opts.skillsSelected && opts.skillsSelected.length > 0) {
		const skillLabels = [];
		if (opts.skillsSelected.includes('mota')) skillLabels.push('MOTA Skills');
		if (opts.skillsSelected.includes('custom') || opts.skillsSelected.includes('find')) skillLabels.push('custom/find');
		lines.push('- **Agent skills** – [skills.sh](https://skills.sh/)' + (skillLabels.length ? ` (${skillLabels.join(', ')})` : ''));
	}
	if (opts.templateMerged && opts.templateUrl) {
		lines.push(`- **Template** – \`${opts.templateUrl.replace(/\.git$/, '')}\``);
	}
	if (opts.copyEditorconfig) lines.push('- `.editorconfig`');
	if (opts.copyCodeOfConductContributing) lines.push('- `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`');
	if (opts.copyProvider === '.github') lines.push('- `.github/ISSUE_TEMPLATE`');
	else if (opts.copyProvider === '.gitlab') lines.push('- `.gitlab/issue_templates`');
	else if (opts.copyProvider === 'custom') lines.push('- Issue templates (custom URL)');

	lines.push(
		'',
		'## Run dev server',
		'',
		'```bash',
		installCmd,
		runDev,
		'```',
		'',
		'## Addons',
		'',
		'Install an addon:',
		'',
		'```bash',
		'npx addon <repo> <generator> <action>',
		'```',
		'',
		'Examples:',
		'',
		'```bash',
		'npx addon bchainhub@mota-support auth install',
		'npx addon owner/repo auth uninstall',
		'npx addon owner/repo auth install --cache',
		'npx addon owner/repo auth install --dry-run',
		'```',
		'',
		'Addon action folders can contain:',
		'',
		'```text',
		'<generator>/<action>/',
		'  prompt.js',
		'  *.ejs.t',
		'  _scripts.ejs.sh',
		'  _scripts.sh',
		'  _config.ejs.json5',
		'  _config.json5',
		'```',
		'',
		'- `prompt.js` collects answers once and those values are reused in templates, scripts, and config.',
		'- `*.ejs.t` are normal Hygen templates and are copied/generated into the project.',
		'- `_scripts*` files are rendered/executed automatically and are never copied.',
		'- `_config*` files are rendered/applied automatically and are never copied.',
		'- `_config*` currently targets the `modules` block in `vite.config.ts`.',
		''
	);

	if (opts.installTranslations) {
		lines.push(
			'## Translations',
			'',
			'i18n is provided by **typesafe-i18n**.',
			''
		);
	}

	if (opts.licenseLabel && opts.licenseLabel !== 'None') {
		const licenseLine = (opts.licenseLabel === 'Other License' || opts.licenseLabel === 'Commercial Source License (CSL)')
			? 'CSL or Other License. See \`LICENSE\` in the repo root.'
			: `${opts.licenseLabel}. See \`LICENSE\` in the repo root.`;
		lines.push('## License', '', licenseLine);
	}

	return lines.join('\n');
}

function detectPm(cwd) {
	if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
	if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return 'bun';
	if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
	return 'npm';
}

function pmAdd(cwd, pm, ...pkgs) {
	if (pkgs.length === 0) return { status: 0 };
	if (pm === 'pnpm') return run('pnpm', ['add', ...pkgs], { cwd });
	if (pm === 'yarn') return run('yarn', ['add', ...pkgs], { cwd });
	if (pm === 'bun') return run('bun', ['add', ...pkgs], { cwd });
	return run('npm', ['i', ...pkgs], { cwd });
}

function pmAddDev(cwd, pm, ...pkgs) {
	if (pkgs.length === 0) return { status: 0 };
	if (pm === 'pnpm') return run('pnpm', ['add', '-D', ...pkgs], { cwd });
	if (pm === 'yarn') return run('yarn', ['add', ...pkgs], { cwd });
	if (pm === 'bun') return run('bun', ['add', '-d', ...pkgs], { cwd });
	return run('npm', ['i', '-D', ...pkgs], { cwd });
}

function pmRemove(cwd, pm, pkg) {
	if (pm === 'pnpm') return run('pnpm', ['remove', pkg], { cwd });
	if (pm === 'yarn') return run('yarn', ['remove', pkg], { cwd });
	if (pm === 'bun') return run('bun', ['remove', pkg], { cwd });
	return run('npm', ['uninstall', pkg], { cwd });
}

function pmInstall(cwd, pm) {
	if (pm === 'pnpm') return run('pnpm', ['install'], { cwd });
	if (pm === 'yarn') return run('yarn', ['install'], { cwd });
	if (pm === 'bun') return run('bun', ['install'], { cwd });
	return run('npm', ['install'], { cwd });
}

function getProjectDir() {
	const cwd = process.cwd();
	if (
		fs.existsSync(path.join(cwd, 'package.json')) &&
		(fs.existsSync(path.join(cwd, 'svelte.config.js')) || fs.existsSync(path.join(cwd, 'svelte.config.ts')))
	) {
		return '.';
	}

	const entries = fs.readdirSync(cwd, { withFileTypes: true });
	let best = null;
	let bestTime = 0;

	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const dir = e.name;
		const pj = path.join(cwd, dir, 'package.json');
		const sc = path.join(cwd, dir, 'svelte.config.js');
		const st = path.join(cwd, dir, 'svelte.config.ts');
		if (!fs.existsSync(pj)) continue;
		if (!fs.existsSync(sc) && !fs.existsSync(st)) continue;
		const stat = fs.statSync(path.join(cwd, dir));
		const mtime = stat.mtimeMs || 0;
		if (mtime > bestTime) {
			bestTime = mtime;
			best = dir;
		}
	}

	return best || '.';
}

async function runUpdateMode(tplUrl, tplVersion = null) {
	intro('Update from template');
	const cwd = process.cwd();
	const vitePath = path.join(cwd, 'vite.config.ts');
	let viteBackup = null;
	if (fs.existsSync(vitePath)) {
		viteBackup = fs.readFileSync(vitePath, 'utf8');
	}

	const doCommit = await confirm({
		message: 'Create a git commit before updating (breakpoint)?',
		initialValue: true
	});
	if (!isCancel(doCommit) && doCommit) {
		const addResult = run('git', ['add', '-A'], { cwd, stdio: 'pipe' });
		const commitResult = run('git', ['commit', '-m', 'chore: checkpoint before template update'], { cwd, stdio: 'pipe' });
		if (commitResult.status !== 0) {
			log.warn('Nothing to commit or commit failed. Continuing.');
		} else {
			log.success('Checkpoint commit created.');
		}
	}

	const s1 = spinner();
	const { baseUrl, refFromUrl } = parseTemplateUrl(tplUrl);
	const tpl = baseUrl.replace(/\.git$/, '') + '.git';
	const ref = refFromUrl ?? tplVersion ?? getDefaultBranch(tpl);
	s1.start(`Cloning template (${ref})…`);
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-starter-update-'));
	const cloneDir = path.join(tmpDir, 'clone');
	const cloneArgs = ['clone', '--depth=1', '-b', ref, tpl, cloneDir];
	const cloneResult = run('git', cloneArgs, { stdio: 'pipe' });
	if (cloneResult.status !== 0) {
		s1.stop('Clone failed.');
		log.error('Failed to clone template.');
		fs.rmSync(tmpDir, { recursive: true, force: true });
		process.exit(1);
	}
	s1.stop('Template cloned.');

	s1.start('Copying files (excluding vite.config.ts)…');
	run('sh', ['-c', `(cd "${cloneDir}" && tar -cf - --exclude=.git --exclude=node_modules .) | tar -xf - -C "${cwd}"`], { stdio: 'pipe' });
	if (viteBackup !== null) {
		fs.writeFileSync(vitePath, viteBackup);
	}
	fs.rmSync(tmpDir, { recursive: true, force: true });
	s1.stop('Done.');

	log.success('Project updated from template. vite.config.ts was preserved.');
	outro('Update complete.');
}

async function main() {
	if (updateMode) {
		await runUpdateMode(templateUrl, templateVersion);
		return;
	}

	intro('Dapp Starter');

	const s1 = spinner();
	s1.start('Creating SvelteKit project…');
	const svResult = run('npx', ['sv', 'create', ...passArgs], { stdio: 'inherit' });
	s1.stop(svResult.status === 0 ? 'SvelteKit project created.' : 'sv create finished.');
	if (svResult.status !== 0) {
		log.error('sv create failed.');
		process.exit(1);
	}

	const projectDir = getProjectDir();
	log.step(`Project directory: ${projectDir}`);
	process.chdir(projectDir);

	const pm = detectPm(process.cwd());
	log.step(`Package manager: ${pm}`);

	s1.start('Installing base packages…');
	const stopBase = startEmojiRotation('Installing base packages…');
	pmAdd(process.cwd(), pm,
		'@blockchainhub/blo', '@blockchainhub/ican', '@tailwindcss/vite',
		'blockchain-wallet-validator', 'device-sherlock', 'exchange-rounding',
		'lucide-svelte', 'payto-rl', 'tailwindcss', 'txms.js', 'vite-plugin-pwa', 'zod'
	);
	pmAddDev(process.cwd(), pm, 'hygen', 'tiged', 'json5', 'ejs', 'prompts');
	stopBase();
	s1.stop('Base packages and addon tooling installed.');

	fs.mkdirSync(path.join(process.cwd(), 'bin'), { recursive: true });

	const scriptsDir = path.join(STARTER_DIR, 'scripts');
	if (!fs.existsSync(scriptsDir)) {
		log.error('Starter scripts folder not found. Ensure scripts/ exists next to start.mjs.');
		process.exit(1);
	}
	const scriptFiles = fs.readdirSync(scriptsDir, { withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => d.name);
	if (scriptFiles.length === 0) {
		log.error('No files in scripts/. Add at least one script (e.g. addon.mjs).');
		process.exit(1);
	}
	for (const name of scriptFiles) {
		const src = path.join(scriptsDir, name);
		const dest = path.join(process.cwd(), 'bin', name);
		fs.writeFileSync(dest, fs.readFileSync(src, 'utf8'), { mode: 0o755 });
	}
	log.success('Created ' + scriptFiles.map((n) => 'bin/' + n).join(', '));

	ensureLineInFile(path.join(process.cwd(), '.gitignore'), '/bin/');

	const pkgPath = path.join(process.cwd(), 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.bin = pkg.bin || {};
	for (const name of scriptFiles) {
		const stem = name.replace(/\.[^.]+$/, '') || name;
		pkg.bin[stem] = `./bin/${name}`;
	}
	pkg.devDependencies = pkg.devDependencies || {};
	pkg.devDependencies.hygen = pkg.devDependencies.hygen || '*';
	pkg.devDependencies.tiged = pkg.devDependencies.tiged || '*';
	pkg.devDependencies.json5 = pkg.devDependencies.json5 || '*';
	pkg.devDependencies.ejs = pkg.devDependencies.ejs || '*';
	pkg.devDependencies.prompts = pkg.devDependencies.prompts || '*';
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

	const stopPm = startEmojiRotation('Running package install…');
	pmInstall(process.cwd(), pm);
	stopPm();

	const installTranslations = await confirm({
		message: 'Install translations using typesafe-i18n?',
		initialValue: true
	});
	if (isCancel(installTranslations)) {
		cancel('Cancelled.');
		process.exit(0);
	}
	if (installTranslations) {
		s1.start('Installing typesafe-i18n…');
		const stopI18n = startEmojiRotation('Installing typesafe-i18n…');
		pmAdd(process.cwd(), pm, 'typesafe-i18n');
		stopI18n();
		addScriptsToPackageJson(pkgPath, {
			'typesafe-i18n': 'typesafe-i18n',
			'i18n:extract': 'typesafe-i18n --no-watch',
			'i18n:watch': 'typesafe-i18n'
		});
		s1.stop('typesafe-i18n installed.');
	}

	log.info('Agent skills: https://skills.sh/');
	const skillChoices = await multiselect({
		message: 'Select skills to add (space to toggle, Enter to confirm).',
		options: [
			{ value: 'none', label: 'None (skip)', hint: 'no skills' },
			{ value: 'find', label: 'Interactive search (npx skills find)', hint: 'discover any skills' },
			{ value: 'mota', label: 'MOTA Skills (bchainhub/mota-skills)' },
			{ value: 'custom', label: 'Add your own repo', hint: 'will prompt for owner/repo' }
		],
		required: false
	});
	if (isCancel(skillChoices)) {
		cancel('Cancelled.');
		process.exit(0);
	}

	const selections = Array.isArray(skillChoices) ? skillChoices : [];
	for (const sel of selections) {
		if (sel === 'none') continue;
		if (sel === 'find') {
			runNpx(['skills', 'find'], { stdio: 'inherit' });
		} else if (sel === 'mota') {
			runNpx(['skills', 'add', 'bchainhub/mota-skills'], { cwd: process.cwd(), stdio: 'inherit' });
		} else if (sel === 'custom') {
			let repo = await text({ message: 'Repo (owner/repo or URL; empty to skip)', placeholder: 'owner/repo' });
			if (isCancel(repo)) break;
			while (repo && repo.trim()) {
				runNpx(['skills', 'add', repo.trim()], { cwd: process.cwd(), stdio: 'inherit' });
				repo = await text({ message: 'Another repo (empty to finish)', placeholder: '' });
				if (isCancel(repo)) break;
			}
		}
	}

	const ignoreSkills = await confirm({
		message: 'Add .agents/ and skills-lock.json to .gitignore?',
		initialValue: true
	});
	if (!isCancel(ignoreSkills) && ignoreSkills) {
		const gi = path.join(process.cwd(), '.gitignore');
		let gic = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
		if (!gic.includes('# AI Agents')) {
			fs.appendFileSync(gi, (gic.endsWith('\n') ? '' : '\n') + '# AI Agents\n');
		}
		appendIfMissing(gi, '/.agents/');
		appendIfMissing(gi, '/skills-lock.json');
		log.success('Added .agents/ and skills-lock.json to .gitignore');
	}

	let templateMerged = false;
	if (templateUrl) {
		const { baseUrl } = parseTemplateUrl(templateUrl);
		const normalizedDefault = TEMPLATE_URL.replace(/\.git$/, '');
		const normalizedCurrent = baseUrl.replace(/\.git$/, '');
		const isDefaultTemplate = normalizedCurrent === normalizedDefault;
		let doTemplate = isDefaultTemplate;
		if (!isDefaultTemplate) {
			const templateLabel = templateVersion ? `${templateUrl} @ ${templateVersion}` : templateUrl;
			const answer = await confirm({
				message: `Merge template from ${templateLabel}?`,
				initialValue: true
			});
			doTemplate = !isCancel(answer) && answer;
		}
		if (doTemplate) {
			const defaultPage = path.join(process.cwd(), 'src', 'routes', '+page.svelte');
			if (fs.existsSync(defaultPage)) fs.unlinkSync(defaultPage);
			const npmrc = path.join(process.cwd(), '.npmrc');
			if (fs.existsSync(npmrc)) fs.unlinkSync(npmrc);

			const { baseUrl, refFromUrl } = parseTemplateUrl(templateUrl);
			const tpl = baseUrl.replace(/\.git$/, '') + '.git';
			const ref = refFromUrl ?? templateVersion ?? getDefaultBranch(tpl);
			s1.start(`Cloning and merging template (${ref})…`);
			const stopMerge = startEmojiRotation('Cloning and merging template…');
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-starter-'));
			const cloneDir = path.join(tmpDir, 'clone');
			const cloneArgs = ['clone', '--depth=1', '-b', ref, tpl, cloneDir];
			const cloneResult = run('git', cloneArgs, { stdio: 'pipe' });

			if (cloneResult.status === 0) {
				const projectCwd = process.cwd();
				run('sh', ['-c', `(cd "${cloneDir}" && tar -cf - --exclude=.git --exclude=node_modules .) | tar -xf - -C "${projectCwd}"`], { stdio: 'pipe' });
				templateMerged = true;
				log.success('Template merged.');
				pmInstall(process.cwd(), pm);
			} else {
				log.error('Failed to clone template.');
			}

			stopMerge();
			fs.rmSync(tmpDir, { recursive: true, force: true });
			s1.stop('Done.');
		}
	}

	if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
		run('git', ['init'], { stdio: 'pipe' });
		log.success('Initialized git repository.');
	}

	const excludeLockfiles = await confirm({
		message: 'Exclude lock files via .gitignore (cleaner, avoid cross-PM conflicts)?',
		initialValue: true
	});
	if (!isCancel(excludeLockfiles)) {
		const gi = path.join(process.cwd(), '.gitignore');
		if (!fs.existsSync(gi)) fs.writeFileSync(gi, '');
		const extras = [
			'', '# Extra ignores (added by installer)', '._*', 'npm-debug.log*', 'yarn-debug.log*',
			'yarn-error.log*', 'pnpm-debug.log*', 'pnpm-error.log*', 'bun-debug.log*', 'lerna-debug.log*',
			'*.log', '*.log.*', 'logs', '*.pid', '*.seed', '*.pid.lock',
			'', '# Editor folders', '/.idea/', '/.vscode/', '/.history/', '/.swp', '/*.sublime-workspace', '/*.sublime-project',
			'', '# Addon cache', '/.addon-cache/', '/.hygen-tmp-*', '/_templates/',
			'', '# Output files', '/.output/', '/.vercel/', '/.netlify/', '/.wrangler/', '/.svelte-kit/', '/build/',
			'', '# Wrangler', '/wrangler.toml', '/wrangler.jsonc',
			'', '# Migration files', '/better-auth_migrations/'
		];
		for (const line of extras) {
			if (line === '' || line.startsWith('#')) fs.appendFileSync(gi, line + '\n');
			else appendIfMissing(gi, line);
		}
		if (excludeLockfiles) {
			fs.appendFileSync(gi, '\n# Lock files\n');
			for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'npm-shrinkwrap.json', 'shrinkwrap.yaml', '.pnp.cjs', '.pnp.loader.mjs']) {
				appendIfMissing(gi, lock);
			}
		}
		log.success('Updated .gitignore');
	}

	const copyEditorconfig = await confirm({
		message: 'Copy .editorconfig from starter repo?',
		initialValue: true
	});
	if (!isCancel(copyEditorconfig) && copyEditorconfig) {
		try {
			const res = await fetch(`${STARTER_REPO_RAW}/data/.editorconfig`);
			if (res.ok) {
				fs.writeFileSync(path.join(process.cwd(), '.editorconfig'), await res.text());
				log.success('.editorconfig copied.');
			}
		} catch {
			log.error('Failed to fetch .editorconfig');
		}
	}

	const copyCodeOfConductContributing = await confirm({
		message: 'Copy CODE_OF_CONDUCT.md and CONTRIBUTING.md from starter repo?',
		initialValue: false
	});

	const providerChoice = await select({
		message: 'Add provider-specific issue templates?',
		options: [
			{ value: '0', label: 'None (skip)' },
			{ value: 'github', label: '.github (GitHub issue templates)' },
			{ value: 'gitlab', label: '.gitlab (GitLab issue templates)' },
			{ value: 'custom', label: 'Custom URL (paste base URL)' }
		],
		initialValue: '0'
	});
	let providerCopied = ''; // e.g. '.github', '.gitlab', 'custom'
	if (providerChoice && providerChoice !== '0' && !isCancel(providerChoice)) {
		let baseUrl;
		let files;
		let destDir;
		if (providerChoice === 'github') {
			baseUrl = `${STARTER_REPO_RAW}/providers/.github/ISSUE_TEMPLATE`;
			files = ['bug.yml', 'feature.yml', 'config.yml'];
			destDir = path.join(process.cwd(), '.github', 'ISSUE_TEMPLATE');
			providerCopied = '.github';
		} else if (providerChoice === 'gitlab') {
			baseUrl = `${STARTER_REPO_RAW}/providers/.gitlab/issue_templates`;
			files = ['bug_report.md', 'feature_request.md'];
			destDir = path.join(process.cwd(), '.gitlab', 'issue_templates');
			providerCopied = '.gitlab';
		} else if (providerChoice === 'custom') {
			const urlInput = await text({
				message: 'Base URL for issue templates',
				placeholder: 'e.g. https://.../providers/.github/ISSUE_TEMPLATE or .../providers/.gitlab/issue_templates'
			});
			const rawUrl = !isCancel(urlInput) && typeof urlInput === 'string' ? urlInput.trim() : '';
			if (!rawUrl) {
				log.warn('No URL provided. Skipping provider templates.');
			} else {
				const structure = await select({
					message: 'Structure to copy',
					options: [
						{ value: 'github', label: '.github (bug.yml, feature.yml, config.yml)' },
						{ value: 'gitlab', label: '.gitlab (bug_report.md, feature_request.md)' }
					],
					initialValue: 'github'
				});
				if (!isCancel(structure) && structure) {
					baseUrl = rawUrl.replace(/\/$/, '');
					if (structure === 'github') {
						files = ['bug.yml', 'feature.yml', 'config.yml'];
						destDir = path.join(process.cwd(), '.github', 'ISSUE_TEMPLATE');
					} else {
						files = ['bug_report.md', 'feature_request.md'];
						destDir = path.join(process.cwd(), '.gitlab', 'issue_templates');
					}
					providerCopied = 'custom';
				}
			}
		}
		if (providerCopied && baseUrl && files && destDir) {
			fs.mkdirSync(destDir, { recursive: true });
			let ok = 0;
			for (const f of files) {
				try {
					const res = await fetch(`${baseUrl}/${f}`);
					if (res.ok) {
						fs.writeFileSync(path.join(destDir, f), await res.text());
						ok++;
					}
				} catch {}
			}
			if (ok) log.success(providerChoice === 'custom' ? 'Issue templates copied from custom URL.' : `${providerCopied} copied.`);
		}
	}

	const licChoice = await select({
		message: 'Choose a license',
		options: [
			{ value: '0', label: 'None (skip)' },
			{ value: '1', label: 'Other (paste text or URL)' },
			{ value: '2', label: 'Commercial Source License (CSL)' },
			{ value: '3', label: 'CORE (default)' },
			{ value: '4', label: 'MIT' },
			{ value: '5', label: 'Apache-2.0' },
			{ value: '6', label: 'GPL-3.0-or-later' },
			{ value: '7', label: 'AGPL-3.0-or-later' },
			{ value: '8', label: 'LGPL-3.0-or-later' },
			{ value: '9', label: 'BSD-2-Clause' },
			{ value: '10', label: 'BSD-3-Clause' },
			{ value: '11', label: 'MPL-2.0' },
			{ value: '12', label: 'Unlicense' },
			{ value: '13', label: 'CC0-1.0' },
			{ value: '14', label: 'ISC' },
			{ value: '15', label: 'EPL-2.0' }
		],
		initialValue: '3'
	});
	if (isCancel(licChoice)) {
		cancel('Cancelled.');
		process.exit(0);
	}

	const spdxUrls = {
		'4': 'https://spdx.org/licenses/MIT.txt',
		'5': 'https://www.apache.org/licenses/LICENSE-2.0.txt',
		'6': 'https://spdx.org/licenses/GPL-3.0-or-later.txt',
		'7': 'https://spdx.org/licenses/AGPL-3.0-or-later.txt',
		'8': 'https://spdx.org/licenses/LGPL-3.0-or-later.txt',
		'9': 'https://spdx.org/licenses/BSD-2-Clause.txt',
		'10': 'https://spdx.org/licenses/BSD-3-Clause.txt',
		'11': 'https://spdx.org/licenses/MPL-2.0.txt',
		'12': 'https://spdx.org/licenses/Unlicense.txt',
		'13': 'https://spdx.org/licenses/CC0-1.0.txt',
		'14': 'https://spdx.org/licenses/ISC.txt',
		'15': 'https://spdx.org/licenses/EPL-2.0.txt'
	};
	const spdxKeys = {
		'4': 'MIT', '5': 'Apache-2.0', '6': 'GPL-3.0-or-later', '7': 'AGPL-3.0-or-later',
		'8': 'LGPL-3.0-or-later', '9': 'BSD-2-Clause', '10': 'BSD-3-Clause', '11': 'MPL-2.0',
		'12': 'Unlicense', '13': 'CC0-1.0', '14': 'ISC', '15': 'EPL-2.0'
	};
	// Licenses that support an optional copyright holder (Other/CSL excluded: user pastes full text)
	const licensesWithOrg = new Set(['4', '5', '6', '7', '8', '9', '10', '11', '14', '15']);

	let licenseOrgName = '';
	if (licChoice !== '0' && licChoice !== '1' && licChoice !== '2' && licensesWithOrg.has(licChoice)) {
		const orgInput = await text({
			message: 'Organization / copyright holder name (optional)',
			placeholder: 'Leave empty to omit',
			initialValue: ''
		});
		if (!isCancel(orgInput) && typeof orgInput === 'string' && orgInput.trim()) {
			licenseOrgName = orgInput.trim();
		}
	}

	let licenseLabel = 'None';
	let licenseWritten = false;

	if (licChoice === '1' || licChoice === '2') {
		// Other or CSL: paste raw text or URL; no org prompt
		const pastePrompt = licChoice === '1' ? 'Paste license raw text or URL' : 'Paste CSL license raw text or URL';
		const pasteInput = await text({
			message: pastePrompt,
			placeholder: 'Leave empty to skip',
			initialValue: ''
		});
		const raw = !isCancel(pasteInput) && typeof pasteInput === 'string' ? pasteInput.trim() : '';
		if (!raw) {
			log.warn('Invalid: no text or URL provided. Skipping license.');
		} else {
			let body = '';
			if (/^https?:\/\//i.test(raw)) {
				try {
					const res = await fetch(raw);
					if (!res.ok) throw new Error(res.statusText);
					body = await res.text();
				} catch (e) {
					log.warn('Invalid: could not fetch URL. Skipping license.');
				}
			} else {
				body = raw;
			}
			if (body) {
				fs.writeFileSync(path.join(process.cwd(), 'LICENSE'), body);
				log.success('LICENSE written.');
				const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
				p.license = 'SEE LICENSE IN LICENSE';
				fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2) + '\n');
				licenseLabel = licChoice === '1' ? 'Other License' : 'Commercial Source License (CSL)';
				licenseWritten = true;
			}
		}
	} else if (licChoice !== '0') {
		const licenseUrl = licChoice === '3' ? CORE_LICENSE_URL : spdxUrls[licChoice];
		const licensePkg = licChoice === '3' ? 'SEE LICENSE IN LICENSE' : spdxKeys[licChoice];
		if (licenseUrl) {
			try {
				const res = await fetch(licenseUrl);
				if (res.ok) {
					let body = await res.text();
					if (licenseOrgName) {
						const year = new Date().getFullYear();
						body = `Copyright (c) ${year} ${licenseOrgName}\n\n` + body;
					}
					fs.writeFileSync(path.join(process.cwd(), 'LICENSE'), body);
					log.success('LICENSE written.');
					const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
					p.license = licensePkg;
					fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2) + '\n');
					licenseWritten = true;
				}
			} catch (e) {
				log.error('Failed to fetch license: ' + e.message);
			}
		}
		licenseLabel = licChoice === '3' ? 'CORE' : (spdxKeys[licChoice] || '');
		if (!licenseWritten) licenseLabel = 'None';
	}
	const pkgForReadme = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	const readmePath = path.join(process.cwd(), 'README.md');
	const readmeContent = composeReadme({
		projectName: pkgForReadme.name || 'my-app',
		pm,
		installTranslations: !!installTranslations,
		skillsSelected: selections,
		ignoreSkills: !isCancel(ignoreSkills) && !!ignoreSkills,
		templateMerged,
		templateUrl: templateUrl || undefined,
		licenseLabel,
		copyEditorconfig: !isCancel(copyEditorconfig) && !!copyEditorconfig,
		copyCodeOfConductContributing: !isCancel(copyCodeOfConductContributing) && !!copyCodeOfConductContributing,
		copyProvider: providerCopied || undefined
	});
	fs.writeFileSync(readmePath, readmeContent.endsWith('\n') ? readmeContent : readmeContent + '\n');
	log.success('README.md composed and written.');

	if (!isCancel(copyCodeOfConductContributing) && copyCodeOfConductContributing) {
		for (const name of ['CODE_OF_CONDUCT.md', 'CONTRIBUTING.md']) {
			try {
				const res = await fetch(`${STARTER_REPO_RAW}/data/${name}`);
				if (res.ok) {
					fs.writeFileSync(path.join(process.cwd(), name), await res.text());
					log.success(`${name} copied.`);
				}
			} catch {
				log.error(`Failed to fetch ${name}`);
			}
		}
	}

	s1.start('Updating packages to latest (ncu)…');
	const stopNcu = startEmojiRotation('Updating packages (ncu)…');
	const pkgJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
	const deps = { ...pkgJson.devDependencies, ...pkgJson.dependencies };
	const ncuPresent = deps && 'npm-check-updates' in deps;
	if (!ncuPresent) {
		pmAddDev(process.cwd(), pm, 'npm-check-updates');
	}
	runNpx(['npm-check-updates', '-u'], { cwd: process.cwd(), stdio: 'pipe' });
	pmInstall(process.cwd(), pm);
	if (!ncuPresent) {
		pmRemove(process.cwd(), pm, 'npm-check-updates');
	}
	stopNcu();
	s1.stop('Packages updated.');

	const doCommit = await confirm({
		message: 'Create a single git commit with all changes?',
		initialValue: true
	});
	if (!isCancel(doCommit) && doCommit) {
		const defaultBranch = run('git', ['config', '--get', 'init.defaultBranch'], { encoding: 'utf8' }).stdout?.trim() || 'main';
		run('git', ['checkout', '-b', defaultBranch], { stdio: 'pipe' });
		run('git', ['add', '-A'], { stdio: 'pipe' });
		const commitResult = run('git', ['commit', '-m', 'chore: initial scaffold and configuration'], { stdio: 'pipe' });
		if (commitResult.status !== 0) log.info('Nothing to commit or already committed.');
	}

	outro('Setup complete.');
	log.success(`Project ready at: ${process.cwd()}`);
	log.message('Next: cd ' + process.cwd() + ' && npm run dev -- --open');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
