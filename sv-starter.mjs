#!/usr/bin/env node
/**
 * SvelteKit project starter — full interactive setup using @clack/prompts.
 * Run: node sv-starter.mjs [--template=URL] [args for sv create]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

const TEMPLATE_URL = 'https://github.com/bchainhub/sveltekit-mota.git';
const STARTER_REPO_RAW = 'https://cdn.jsdelivr.net/gh/bchainhub/sveltekit-starter';
const CORE_LICENSE_URL = 'https://raw.githubusercontent.com/bchainhub/core-license/refs/heads/main/LICENSE';

// Parse argv: --template=URL or --template URL, rest passed to sv create
let templateUrl = TEMPLATE_URL;
const passArgs = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--template' && process.argv[i + 1]) {
    templateUrl = process.argv[++i];
  } else if (arg.startsWith('--template=')) {
    templateUrl = arg.slice('--template='.length);
  } else {
    passArgs.push(arg);
  }
}

function run(cmd, args = [], opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.inherit ? 'inherit' : 'pipe',
    shell: opts.shell ?? true,
    cwd: opts.cwd || process.cwd(),
    ...opts
  });
  return result;
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
  if (fs.existsSync(path.join(cwd, 'package.json')) &&
      (fs.existsSync(path.join(cwd, 'svelte.config.js')) || fs.existsSync(path.join(cwd, 'svelte.config.ts')))) {
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
  if (best) return best;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = e.name;
    const pj = path.join(cwd, dir, 'package.json');
    const sc = path.join(cwd, dir, 'svelte.config.js');
    const st = path.join(cwd, dir, 'svelte.config.ts');
    if (fs.existsSync(pj) && (fs.existsSync(sc) || fs.existsSync(st))) return dir;
  }
  return '.';
}

const BIN_ADDON_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

print_error(){ echo "❌ $*" >&2; }

usage() {
  cat <<'USAGE'
Usage:
  addon <repo> <generator> <action> [options]

Addon options:
  --cache        Cache fetched templates under .addon-cache/

All other flags are forwarded to hygen.

Examples:
  addon bchainhub@mota-api auth install
  addon bchainhub@mota-api auth install --cache
  addon bchainhub@mota-api auth install --dry-run
  addon bchainhub@mota-api auth install --cache --dry-run
USAGE
}

if [[ "\${1:-}" == "--help" || "\${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 3 ]]; then
  print_error "Missing required arguments."
  usage
  exit 2
fi

REPO="$1"
GEN="$2"
ACT="$3"
shift 3

CACHE=0
FORWARD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cache)
      CACHE=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      FORWARD_ARGS+=("$1")
      shift
      ;;
  esac
done

CACHE_ROOT=".addon-cache"
KEY="$(printf "%s" "$REPO/$GEN/$ACT" | sed 's#[^A-Za-z0-9._-]#_#g')"

if [[ "$CACHE" -eq 1 ]]; then
  TMPLS="$CACHE_ROOT/$KEY"
  if [[ ! -d "$TMPLS/$GEN/$ACT" ]]; then
    mkdir -p "$TMPLS"
    if command -v tiged >/dev/null 2>&1; then
      tiged "$REPO/$GEN/$ACT" "$TMPLS/$GEN/$ACT"
    else
      npx -y tiged "$REPO/$GEN/$ACT" "$TMPLS/$GEN/$ACT"
    fi
  fi
else
  TMPLS=".hygen-tmp-${GEN}-${ACT}"
  trap 'rm -rf "$TMPLS" 2>/dev/null || true' EXIT INT TERM
  if command -v tiged >/dev/null 2>&1; then
    tiged "$REPO/$GEN/$ACT" "$TMPLS/$GEN/$ACT"
  else
    npx -y tiged "$REPO/$GEN/$ACT" "$TMPLS/$GEN/$ACT"
  fi
fi

if command -v hygen >/dev/null 2>&1; then
  HYGEN_TMPLS="$TMPLS" hygen "$GEN" "$ACT" "\${FORWARD_ARGS[@]}"
else
  HYGEN_TMPLS="$TMPLS" npx -y hygen "$GEN" "$ACT" "\${FORWARD_ARGS[@]}"
fi
`;

async function main() {
  intro('SvelteKit Starter');

  const s1 = spinner();
  s1.start('Creating SvelteKit project…');
  const svResult = run('npx', ['sv', 'create', ...passArgs], { stdio: 'inherit', shell: true });
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
  pmAdd(process.cwd(), pm,
    '@blockchainhub/blo', '@blockchainhub/ican', '@tailwindcss/vite',
    'blockchain-wallet-validator', 'device-sherlock', 'exchange-rounding',
    'lucide-svelte', 'payto-rl', 'tailwindcss', 'txms.js', 'vite-plugin-pwa'
  );
  pmAddDev(process.cwd(), pm, 'hygen', 'tiged');
  s1.stop('Base packages and addon tooling installed.');

  fs.mkdirSync(path.join(process.cwd(), 'bin'), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), 'bin', 'addon'), BIN_ADDON_SCRIPT, { mode: 0o755 });
  log.success('Created bin/addon');

  ensureLineInFile(path.join(process.cwd(), '.gitignore'), '/bin/');
  const pkgPath = path.join(process.cwd(), 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.bin = pkg.bin || {};
  pkg.bin.addon = './bin/addon';
  pkg.devDependencies = pkg.devDependencies || {};
  pkg.devDependencies.hygen = pkg.devDependencies.hygen || '*';
  pkg.devDependencies.tiged = pkg.devDependencies.tiged || '*';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  pmInstall(process.cwd(), pm);

  // Translations
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
    pmAdd(process.cwd(), pm, 'typesafe-i18n');
    s1.stop('typesafe-i18n installed.');
  }

  // Agent Skills
  log.info('Agent skills: https://skills.sh/');
  const skillChoices = await multiselect({
    message: 'Select skills to add (space to toggle, Enter to confirm).',
    options: [
      { value: 'find', label: 'Interactive search (npx skills find)', hint: 'discover any skills' },
      { value: 'core', label: 'Core Blockchain Skills (core-coin/skills)' },
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
    if (sel === 'find') {
      log.step('Running npx skills find…');
      runNpx(['skills', 'find'], { stdio: 'inherit' });
    } else if (sel === 'core') {
      log.step('Adding core-coin/skills…');
      runNpx(['skills', 'add', 'core-coin/skills'], { cwd: process.cwd() });
    } else if (sel === 'mota') {
      log.step('Adding bchainhub/mota-skills…');
      runNpx(['skills', 'add', 'bchainhub/mota-skills'], { cwd: process.cwd() });
    } else if (sel === 'custom') {
      let repo = await text({ message: 'Repo (owner/repo or URL; empty to skip)', placeholder: 'owner/repo' });
      if (isCancel(repo)) break;
      while (repo && repo.trim()) {
        const r = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
        log.step(`Adding ${r}…`);
        runNpx(['skills', 'add', r], { cwd: process.cwd() });
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

  // Template
  if (templateUrl) {
    const doTemplate = await confirm({
      message: `Merge template from ${templateUrl}?`,
      initialValue: true
    });
    if (!isCancel(doTemplate) && doTemplate) {
      s1.start('Cloning and merging template…');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-starter-'));
      const cloneDir = path.join(tmpDir, 'clone');
      const tpl = templateUrl.replace(/\\.git$/, '') + '.git';
      const cloneResult = run('git', ['clone', '--depth=1', tpl, cloneDir], { stdio: 'pipe' });
      if (cloneResult.status === 0) {
        const page = path.join(process.cwd(), 'src', 'routes', '+page.svelte');
        if (fs.existsSync(page)) fs.unlinkSync(page);
        const cwd = process.cwd();
        run('sh', ['-c', `(cd "${cloneDir}" && tar -cf - --exclude=.git --exclude=node_modules .) | tar -xf - -C "${cwd}"`], { stdio: 'pipe' });
        log.success('Template merged.');
        pmInstall(process.cwd(), pm);
      } else {
        log.error('Failed to clone template.');
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
      s1.stop('Done.');
    }
  }

  if (!fs.existsSync(path.join(process.cwd(), '.git'))) {
    run('git', ['init'], { stdio: 'pipe' });
    log.success('Initialized git repository.');
  }

  // Git config / .gitignore
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
      fs.appendFileSync(gi, '\n# Lock files (managed by installer)\n');
      for (const lock of ['/package-lock.json', '/pnpm-lock.yaml', '/yarn.lock', '/bun.lockb', '/npm-shrinkwrap.json', '/shrinkwrap.yaml', '/.pnp.cjs', '/.pnp.loader.mjs']) {
        appendIfMissing(gi, lock);
      }
    }
    log.success('Updated .gitignore');
  }

  // Project assets
  const copyEditorconfig = await confirm({
    message: 'Copy .editorconfig from starter repo?',
    initialValue: true
  });
  if (!isCancel(copyEditorconfig) && copyEditorconfig) {
    try {
      const res = await fetch(`${STARTER_REPO_RAW}/editors/.editorconfig`);
      if (res.ok) {
        fs.writeFileSync(path.join(process.cwd(), '.editorconfig'), await res.text());
        log.success('.editorconfig copied.');
      }
    } catch {
      log.error('Failed to fetch .editorconfig');
    }
  }
  const copyGithub = await confirm({
    message: 'Copy .github (issue templates) into project?',
    initialValue: false
  });
  if (!isCancel(copyGithub) && copyGithub) {
    const ghDir = path.join(process.cwd(), '.github', 'ISSUE_TEMPLATE');
    fs.mkdirSync(ghDir, { recursive: true });
    const files = ['bug.yml', 'feature.yml', 'config.yml'];
    for (const f of files) {
      try {
        const res = await fetch(`${STARTER_REPO_RAW}/providers/.github/ISSUE_TEMPLATE/${f}`);
        if (res.ok) fs.writeFileSync(path.join(ghDir, f), await res.text());
      } catch { /* ignore */ }
    }
    log.success('.github copied.');
  }

  // License
  const licChoice = await select({
    message: 'Choose a license',
    options: [
      { value: '0', label: 'CORE (default)' },
      { value: '1', label: 'MIT' },
      { value: '2', label: 'Apache-2.0' },
      { value: '3', label: 'GPL-3.0-or-later' },
      { value: '4', label: 'AGPL-3.0-or-later' },
      { value: '5', label: 'LGPL-3.0-or-later' },
      { value: '6', label: 'BSD-2-Clause' },
      { value: '7', label: 'BSD-3-Clause' },
      { value: '8', label: 'MPL-2.0' },
      { value: '9', label: 'Unlicense' },
      { value: '10', label: 'CC0-1.0' },
      { value: '11', label: 'ISC' },
      { value: '12', label: 'EPL-2.0' },
      { value: '13', label: 'None (skip)' }
    ],
    initialValue: '0'
  });
  if (isCancel(licChoice)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  const spdxUrls = {
    '1': 'https://spdx.org/licenses/MIT.txt',
    '2': 'https://www.apache.org/licenses/LICENSE-2.0.txt',
    '3': 'https://spdx.org/licenses/GPL-3.0-or-later.txt',
    '4': 'https://spdx.org/licenses/AGPL-3.0-or-later.txt',
    '5': 'https://spdx.org/licenses/LGPL-3.0-or-later.txt',
    '6': 'https://spdx.org/licenses/BSD-2-Clause.txt',
    '7': 'https://spdx.org/licenses/BSD-3-Clause.txt',
    '8': 'https://spdx.org/licenses/MPL-2.0.txt',
    '9': 'https://spdx.org/licenses/Unlicense.txt',
    '10': 'https://spdx.org/licenses/CC0-1.0.txt',
    '11': 'https://spdx.org/licenses/ISC.txt',
    '12': 'https://spdx.org/licenses/EPL-2.0.txt'
  };
  const spdxKeys = { '1': 'MIT', '2': 'Apache-2.0', '3': 'GPL-3.0-or-later', '4': 'AGPL-3.0-or-later', '5': 'LGPL-3.0-or-later', '6': 'BSD-2-Clause', '7': 'BSD-3-Clause', '8': 'MPL-2.0', '9': 'Unlicense', '10': 'CC0-1.0', '11': 'ISC', '12': 'EPL-2.0' };
  let licenseUrl = licChoice === '0' ? CORE_LICENSE_URL : spdxUrls[licChoice];
  let licensePkg = licChoice === '0' ? 'SEE LICENSE IN LICENSE' : spdxKeys[licChoice];
  if (licChoice !== '13' && licenseUrl) {
    try {
      const res = await fetch(licenseUrl);
      if (res.ok) {
        fs.writeFileSync(path.join(process.cwd(), 'LICENSE'), await res.text());
        log.success('LICENSE written.');
        const p = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        p.license = licensePkg;
        fs.writeFileSync(pkgPath, JSON.stringify(p, null, 2) + '\n');
      }
    } catch (e) {
      log.error('Failed to fetch license: ' + e.message);
    }
  }

  s1.start('Updating packages to latest (ncu)…');
  pmAddDev(process.cwd(), pm, 'npm-check-updates');
  runNpx(['npm-check-updates', '-u'], { cwd: process.cwd() });
  pmInstall(process.cwd(), pm);
  pmRemove(process.cwd(), pm, 'npm-check-updates');
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
    const doPush = await confirm({ message: 'Push to origin now?', initialValue: false });
    if (!isCancel(doPush) && doPush) {
      const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || 'main';
      run('git', ['push', '-u', 'origin', branch], { stdio: 'inherit' });
    }
  }

  outro('Setup complete.');
  log.success(`Project ready at: ${process.cwd()}`);
  log.message('Next: cd ' + process.cwd() + ' && npm run dev -- --open');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
