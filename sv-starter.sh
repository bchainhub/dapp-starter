#!/usr/bin/env bash
set -euo pipefail

# Defensive programming: ensure all variables are properly initialized
picked=""
pkgs=""
choice=""
exclude_lockfiles=""
copy_editorconfig=""
copy_github=""
lic_choice=""
final_commit=""
do_push=""

TEMPLATE_URL="https://github.com/bchainhub/sveltekit-mota.git"
# Starter repo (for editors/.editorconfig and providers/.github)
STARTER_REPO_GIT="https://github.com/bchainhub/sveltekit-starter.git"
STARTER_REPO_RAW="https://cdn.jsdelivr.net/gh/bchainhub/sveltekit-starter"

# ------------------ UI helpers ---------------------------------------------------
print_section() {
  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo
}

print_subsection() {
  echo
  echo "┌─ $1 ──────────────────────────────────────────────────────────────────────┐"
  echo
}

print_success() { echo "✅ $1"; }
print_info()    { echo "ℹ️  $1"; }
print_error()   { echo "❌ $1"; }
print_step()    { echo "→ $1"; }

# ------------------ parse flags ----------------------------------------------
pass_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --template) TEMPLATE_URL="${2:-}"; shift 2;;
    --template=*) TEMPLATE_URL="${1#*=}"; shift;;
    *) pass_args+=("$1"); shift;;
  esac
done
if [[ ${#pass_args[@]} -gt 0 ]]; then
  set -- "${pass_args[@]}"
fi

# ------------------ snapshot BEFORE sv create --------------------------------
TMP_MARKER=""
if command -v mktemp >/dev/null 2>&1; then
  TMP_MARKER="$(mktemp 2>/dev/null || echo "/tmp/sv-starter-$$")"
else
  TMP_MARKER="/tmp/sv-starter-$$"
fi
trap 'rm -f "$TMP_MARKER" 2>/dev/null || true' EXIT
touch "$TMP_MARKER" 2>/dev/null || true

# ------------------ run official creator -------------------------------------
print_section "🚀 Creating SvelteKit Project"
npx sv create "$@"
echo
print_success "SvelteKit project created!"
echo
read -rp "Press Enter to continue with package installation and configuration… " || true

# ------------------ detect the created project dir ---------------------------
project_dir="."

if [[ -f svelte.config.js || -f svelte.config.ts ]] && [[ -f "package.json" ]]; then
  project_dir="."
else
  if [[ -n "$TMP_MARKER" ]] && [[ -f "$TMP_MARKER" ]]; then
    candidates=()
    while IFS= read -r -d '' dir; do
      if [[ -f "$dir/package.json" ]] && [[ -f "$dir/svelte.config.js" || -f "$dir/svelte.config.ts" ]]; then
        candidates+=("$dir")
      fi
    done < <(find . -maxdepth 1 -mindepth 1 -type d -newer "$TMP_MARKER" -print0 2>/dev/null || true)

    if [[ ${#candidates[@]} -gt 0 ]]; then
      newest_time=0
      for dir in "${candidates[@]}"; do
        if [[ -d "$dir" ]]; then
          mod_time="0"
          if stat -f "%m" "$dir" >/dev/null 2>&1; then
            mod_time=$(stat -f "%m" "$dir" 2>/dev/null || echo "0")
          elif stat -c "%Y" "$dir" >/dev/null 2>&1; then
            mod_time=$(stat -c "%Y" "$dir" 2>/dev/null || echo "0")
          fi
          if [[ "$mod_time" -gt "$newest_time" ]]; then
            newest_time="$mod_time"
            project_dir="$dir"
          fi
        fi
      done
    fi
  fi

  if [[ "$project_dir" == "." ]]; then
    for dir in */; do
      if [[ -d "$dir" ]] && [[ -f "$dir/package.json" ]] && [[ -f "$dir/svelte.config.js" || -f "$dir/svelte.config.ts" ]]; then
        project_dir="${dir%/}"
        break
      fi
    done
  fi
fi
project_dir="${project_dir#./}"
print_step "Detected project directory: ${project_dir:-.}"
cd "${project_dir:-.}"

# ------------------ package manager helpers ----------------------------------
detect_pm() {
  if [[ -f pnpm-lock.yaml ]] && command -v pnpm >/dev/null 2>&1; then echo pnpm
  elif [[ -f bun.lockb ]]  && command -v bun  >/dev/null 2>&1; then echo bun
  elif [[ -f yarn.lock ]]  && command -v yarn >/dev/null 2>&1; then echo yarn
  else echo npm; fi
}
PKG_PM="$(detect_pm)"
pm_add() {
  case "$PKG_PM" in
    pnpm) pnpm add "$@" ;;
    yarn) yarn add "$@" ;;
    bun)  bun add  "$@" ;;
    *)    npm i   "$@" ;;
  esac
}
pm_add_dev() {
  case "$PKG_PM" in
    pnpm) pnpm add -D "$@" ;;
    yarn) yarn add -D "$@" ;;
    bun)  bun add  -d "$@" ;;
    *)    npm i   -D "$@" ;;
  esac
}
pm_remove() {
  case "$PKG_PM" in
    pnpm) pnpm remove "$@" ;;
    yarn) yarn remove "$@" ;;
    bun)  bun remove "$@" ;;
    *)    npm uninstall "$@" ;;
  esac
}
pm_install_all() {
  case "$PKG_PM" in
    pnpm) pnpm install ;;
    yarn) yarn install ;;
    bun)  bun install ;;
    *)    npm install ;;
  esac
}
print_step "Using package manager: $PKG_PM"

# ------------------ gitignore helper (used early) ----------------------------
append_if_missing() {
  local pattern="$1"
  local file=".gitignore"
  grep -qxF "$pattern" "$file" 2>/dev/null || echo "$pattern" >> "$file"
}

# ------------------ package.json helper --------------------------------------
pkg_json_set_bin_and_deps() {
  if [[ ! -f package.json ]] || ! command -v node >/dev/null 2>&1; then
    print_info "Skipping package.json updates (package.json or node not available)."
    return 0
  fi

  node - <<'NODE'
const fs = require('fs');

const f = 'package.json';
const j = JSON.parse(fs.readFileSync(f, 'utf8'));

j.bin = j.bin || {};
if (!j.bin.addon) j.bin.addon = "./bin/addon";

j.devDependencies = j.devDependencies || {};
if (!j.devDependencies.hygen) j.devDependencies.hygen = "*";
if (!j.devDependencies.tiged) j.devDependencies.tiged = "*";

fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
NODE
}

# ------------------ install base packages (non-auth) -------------------------
print_subsection "📦 Installing Base Packages"
print_step "Installing core dependencies…"
pm_add @blockchainhub/blo @blockchainhub/ican @tailwindcss/vite \
       blockchain-wallet-validator device-sherlock exchange-rounding \
       lucide-svelte payto-rl tailwindcss txms.js vite-plugin-pwa
print_success "Base packages installed"

# ------------------ Addon tooling (dev deps) ---------------------------------
print_step "Installing addon tooling (dev): hygen + tiged"
pm_add_dev hygen tiged
print_success "Addon tooling installed"

# ------------------ Create bin/addon CLI (Style A) ----------------------------
print_subsection "🧩 Addon CLI"
mkdir -p bin

cat > bin/addon <<'ADDON_EOF'
#!/usr/bin/env bash
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
  addon bchainhub@mota-addon-corepass auth install
  addon bchainhub@mota-addon-corepass auth install --cache
  addon bchainhub@mota-addon-corepass auth install --dry-run
  addon bchainhub@mota-addon-corepass auth install --cache --dry-run
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
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
  HYGEN_TMPLS="$TMPLS" hygen "$GEN" "$ACT" "${FORWARD_ARGS[@]}"
else
  HYGEN_TMPLS="$TMPLS" npx -y hygen "$GEN" "$ACT" "${FORWARD_ARGS[@]}"
fi
ADDON_EOF

# Best-effort chmod (do not fail installer)
if chmod +x bin/addon >/dev/null 2>&1; then
  print_success "Created bin/addon (executable)."
else
  print_info "Created bin/addon but could not chmod +x (non-POSIX FS / Windows can cause this)."
  print_info "If it doesn't run, use: bash bin/addon … or set exec bit in git."
fi

# Add root bin/ to .gitignore (as requested; /bin/ = root only)
touch .gitignore
append_if_missing "/bin/"

# Register bin in package.json, ensure deps keys exist
pkg_json_set_bin_and_deps

# Make sure everything is installed (idempotent)
pm_install_all

# ------------------ Translations picker ----------------------------------------
print_section "🌐 Internationalization (i18n)"
read -rp "Install translations using typesafe-i18n? [Y/n]: " install_translations
install_translations="${install_translations:-Y}"

if [[ "$install_translations" =~ ^[Yy]$ ]]; then
  print_step "Installing typesafe-i18n"
  pm_add typesafe-i18n
  print_success "typesafe-i18n installed successfully"
else
  print_step "Skipped translations installation"
fi

# ------------------ Agent Skills (https://skills.sh / vercel-labs/skills CLI) -
# Uses @clack/prompts UI when available (inline script); else text menu.
print_section "🤖 Agent Skills"
set +u
print_info "Uses the official skills CLI (npx skills). Discover at https://skills.sh/"

skill_selections=""
if command -v node >/dev/null 2>&1 && [[ -f package.json ]]; then
  if pm_add_dev @clack/prompts 2>/dev/null; then
    SKILLS_PICKER_TMP=""
    if command -v mktemp >/dev/null 2>&1; then
      T="$(mktemp 2>/dev/null)" && SKILLS_PICKER_TMP="${T}.mjs" || true
    fi
    [[ -z "$SKILLS_PICKER_TMP" ]] && SKILLS_PICKER_TMP=".sv-starter-skills-picker-$$.mjs"
    cat <<'PICKER_END' > "$SKILLS_PICKER_TMP"
import { intro, outro, multiselect, isCancel, cancel } from '@clack/prompts';
intro('Agent Skills');
const selected = await multiselect({
  message: 'Select skills to add (space to toggle, Enter to confirm).',
  options: [
    { value: 'find', label: 'Interactive search (npx skills find)', hint: 'discover any skills' },
    { value: 'core', label: 'Core Blockchain Skills (core-coin/skills)' },
    { value: 'mota', label: 'MOTA Skills (bchainhub/mota-skills)' },
    { value: 'custom', label: 'Add your own repo', hint: 'will prompt for owner/repo' }
  ],
  required: false
});
if (isCancel(selected)) { cancel('Skipped.'); process.exit(1); }
outro('Done');
console.log((selected || []).join(' '));
PICKER_END
    skill_selections=$(node "$SKILLS_PICKER_TMP" 2>/dev/null) || true
    rm -f "$SKILLS_PICKER_TMP" 2>/dev/null || true
  fi
fi

if [[ -z "$skill_selections" ]]; then
  echo
  echo "  1) Interactive search (npx skills find) — discover and add any skills"
  echo "  2) Add from repos — Core Blockchain, MOTA, or your own (CLI will prompt)"
  echo "  3) Skip"
  read -rp "Enter a number (default 3): " skill_choice
  skill_choice="${skill_choice:-3}"
  case "$skill_choice" in
    1) skill_selections="find" ;;
    2)
      echo
      echo "  a) Core Blockchain  b) MOTA  c) Your own repo"
      read -rp "Enter letters (e.g. a b): " skill_letters
      for letter in $skill_letters; do
        case "$letter" in a|A) skill_selections="${skill_selections:+$skill_selections }core" ;; b|B) skill_selections="${skill_selections:+$skill_selections }mota" ;; c|C) skill_selections="${skill_selections:+$skill_selections }custom" ;; esac
      done
      ;;
    *) skill_selections="" ;;
  esac
fi

for sel in $skill_selections; do
  case "$sel" in
    find)
      print_step "Running npx skills find (interactive search)…"
      npx skills find || print_info "Run manually: npx skills find"
      ;;
    core)
      print_step "Running npx skills add core-coin/skills…"
      npx skills add core-coin/skills || print_info "Run later: npx skills add core-coin/skills"
      ;;
    mota)
      print_step "Running npx skills add bchainhub/mota-skills…"
      npx skills add bchainhub/mota-skills || print_info "Run later: npx skills add bchainhub/mota-skills"
      ;;
    custom)
      read -rp "Repo (owner/repo or URL; empty to skip): " skill_repo
      while [[ -n "$skill_repo" ]]; do
        skill_repo="${skill_repo#"https://github.com/"}"
        skill_repo="${skill_repo%.git}"
        print_step "Running npx skills add $skill_repo…"
        npx skills add "$skill_repo" || print_info "Run later: npx skills add $skill_repo"
        read -rp "Another repo (empty to finish): " skill_repo
      done
      ;;
  esac
done

echo
read -rp "Add .agents/ and skills-lock.json to .gitignore? [Y/n]: " ignore_skills
ignore_skills="${ignore_skills:-Y}"
if [[ "$ignore_skills" =~ ^[Yy]$ ]]; then
  touch .gitignore
  if ! grep -qxF "# AI Agents" .gitignore 2>/dev/null; then
    echo >> .gitignore
    echo "# AI Agents" >> .gitignore
  fi
  append_if_missing "/.agents/"
  append_if_missing "/skills-lock.json"
  print_success "Added .agents/ and skills-lock.json to .gitignore"
else
  print_step "Keeping skills files tracked in git"
fi

set -u

# ------------------ clone & merge template (git-clone, paste & overwrite) ---
if [[ -n "${TEMPLATE_URL}" ]]; then
  print_section "📋 Template Integration"
  print_step "Cloning template repository…"
  TMPDIR="$(mktemp -d)"
  CLONE_DIR="${TMPDIR}/clone"

  tpl_url="${TEMPLATE_URL%.git}.git"

  if git clone --depth=1 "$tpl_url" "$CLONE_DIR"; then
    print_step "Removing existing src/routes/+page.svelte to avoid conflicts…"
    rm -f "src/routes/+page.svelte"

    print_step "Pasting template into project (create new + overwrite existing)…"
    (cd "$CLONE_DIR" && tar -cf - --exclude='.git' --exclude='node_modules' .) | tar -xf - -C .
    print_success "Template paste & overwrite complete."
  else
    print_error "Failed to clone template from: $tpl_url"
  fi

  print_step "Cleaning cloned artifacts…"
  rm -rf "$TMPDIR"

  if [[ -f "package.json" ]]; then
    print_step "Installing dependencies after template merge…"
    pm_install_all
    print_success "Dependencies installed"
  else
    print_error "package.json not found; skipping dependency installation."
  fi
fi

# ------------------ ensure git repo (no commits yet) -------------------------
print_subsection "Git Repository"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init
  print_success "Initialized new git repository."
fi

# ------------------ .gitignore handling --------------------------------------
print_section "📝 Git Configuration"
read -rp "Exclude lock files (package-lock.json, etc.) via .gitignore to keep repo cleaner and avoid cross-PM conflicts? [Y/n]: " exclude_lockfiles
exclude_lockfiles="${exclude_lockfiles:-Y}"

touch .gitignore

echo >> .gitignore
echo "# Extra ignores (added by installer)" >> .gitignore

append_if_missing "._*"
append_if_missing "npm-debug.log*"
append_if_missing "yarn-debug.log*"
append_if_missing "yarn-error.log*"
append_if_missing "pnpm-debug.log*"
append_if_missing "pnpm-error.log*"
append_if_missing "bun-debug.log*"
append_if_missing "lerna-debug.log*"
append_if_missing "*.log"
append_if_missing "*.log.*"
append_if_missing "logs"
append_if_missing "*.pid"
append_if_missing "*.seed"
append_if_missing "*.pid.lock"

echo >> .gitignore
echo "# Editor folders" >> .gitignore
append_if_missing "/.idea/"
append_if_missing "/.vscode/"
append_if_missing "/.history/"
append_if_missing "/.swp"
append_if_missing "/*.sublime-workspace"
append_if_missing "/*.sublime-project"

echo >> .gitignore
echo "# Addon cache" >> .gitignore
append_if_missing "/.addon-cache/"
append_if_missing "/.hygen-tmp-*"
append_if_missing "/_templates/"

echo >> .gitignore
echo "# Output files" >> .gitignore
append_if_missing "/.output/"
append_if_missing "/.vercel/"
append_if_missing "/.netlify/"
append_if_missing "/.wrangler/"
append_if_missing "/.svelte-kit/"
append_if_missing "/build/"

# Portal has default wrangler in connector, this is excluded for local development
echo >> .gitignore
echo "# Wrangler" >> .gitignore
append_if_missing "/wrangler.toml"
append_if_missing "/wrangler.jsonc"

echo >> .gitignore
echo "# Migration files" >> .gitignore
append_if_missing "/better-auth_migrations/"

case "$exclude_lockfiles" in
  [Yy]*|'')
    echo >> .gitignore
    echo "# Lock files (managed by installer)" >> .gitignore
    append_if_missing "/package-lock.json"
    append_if_missing "/pnpm-lock.yaml"
    append_if_missing "/yarn.lock"
    append_if_missing "/bun.lockb"
    append_if_missing "/npm-shrinkwrap.json"
    append_if_missing "/shrinkwrap.yaml"
    append_if_missing "/.pnp.cjs"
    append_if_missing "/.pnp.loader.mjs"
    ;;
  *)
    print_step "Keeping lock files tracked."
    ;;
esac

# ------------------ Copy assets from starter repo (editors/providers) --------
print_section "📁 Project Assets"
read -rp "Copy .editorconfig from starter repo (editors/.editorconfig)? [Y/n]: " copy_editorconfig
copy_editorconfig="${copy_editorconfig:-Y}"

STARTER_TMP=""
ensure_starter_clone() {
  if [[ -z "${STARTER_TMP}" ]]; then
    STARTER_TMP="$(mktemp -d)"
    print_step "Cloning starter assets repo…"
    if ! git clone --depth=1 "$STARTER_REPO_GIT" "$STARTER_TMP" >/dev/null 2>&1; then
      print_error "Failed to clone starter repo: $STARTER_REPO_GIT"
      STARTER_TMP=""
    fi
  fi
}

if [[ "$copy_editorconfig" =~ ^[Yy]$ ]]; then
  if curl -fsSL "${STARTER_REPO_RAW}/editors/.editorconfig" -o .editorconfig; then
    print_success ".editorconfig copied from editors/.editorconfig (raw)."
  else
    ensure_starter_clone
    if [[ -n "$STARTER_TMP" && -f "$STARTER_TMP/editors/.editorconfig" ]]; then
      cp "$STARTER_TMP/editors/.editorconfig" .editorconfig
      print_success ".editorconfig copied from editors/.editorconfig (clone)."
    else
      print_error "Failed to obtain .editorconfig from starter repo. Skipping."
    fi
  fi
else
  print_step "Skipped .editorconfig copy."
fi

echo
read -rp "Copy .github (providers/.github) into project root? [y/N]: " copy_github
copy_github="${copy_github:-N}"

if [[ "$copy_github" =~ ^[Yy]$ ]]; then
  STAGING_DIR="$(mktemp -d)"
  mkdir -p "$STAGING_DIR/.github/ISSUE_TEMPLATE"
  ok=true
  curl -fsSL "${STARTER_REPO_RAW}/providers/.github/ISSUE_TEMPLATE/bug.yml"     -o "$STAGING_DIR/.github/ISSUE_TEMPLATE/bug.yml"     || ok=false
  curl -fsSL "${STARTER_REPO_RAW}/providers/.github/ISSUE_TEMPLATE/feature.yml" -o "$STAGING_DIR/.github/ISSUE_TEMPLATE/feature.yml" || ok=false
  curl -fsSL "${STARTER_REPO_RAW}/providers/.github/ISSUE_TEMPLATE/config.yml"  -o "$STAGING_DIR/.github/ISSUE_TEMPLATE/config.yml"  || ok=false
  if [[ "$ok" == false ]]; then
    ensure_starter_clone
    if [[ -n "$STARTER_TMP" && -d "$STARTER_TMP/providers/.github" ]]; then
      rsync -a "$STARTER_TMP/providers/.github"/ "$STAGING_DIR/.github"/
      ok=true
    fi
  fi
  if [[ "$ok" == true && -d "$STAGING_DIR/.github" ]]; then
    mkdir -p .github
    rsync -a "$STAGING_DIR/.github"/ .github/
    print_success ".github assets copied into project root."
  else
    print_error "Failed to obtain .github assets from starter repo. Skipping."
  fi
  rm -rf "$STAGING_DIR"
else
  print_step "Skipped .github copy."
fi

# ------------------ LICENSE handling -----------------------------------------
print_section "📜 License Selection"
echo "Choose a license for this project:"
echo "  0) CORE (default)"
echo "  1) MIT"
echo "  2) Apache-2.0"
echo "  3) GPL-3.0-or-later"
echo "  4) AGPL-3.0-or-later"
echo "  5) LGPL-3.0-or-later"
echo "  6) BSD-2-Clause"
echo "  7) BSD-3-Clause"
echo "  8) MPL-2.0"
echo "  9) Unlicense"
echo " 10) CC0-1.0"
echo " 11) ISC"
echo " 12) EPL-2.0"
echo " 13) None (skip)"

set +u
read -rp "Enter a number (default 0): " lic_choice
lic_choice="${lic_choice:-0}"

CORE_URL="https://raw.githubusercontent.com/bchainhub/core-license/refs/heads/main/LICENSE"

spdx_url_for() {
  case "$1" in
    MIT)                 echo "https://spdx.org/licenses/MIT.txt" ;;
    Apache-2.0)          echo "https://www.apache.org/licenses/LICENSE-2.0.txt" ;;
    GPL-3.0-or-later)    echo "https://spdx.org/licenses/GPL-3.0-or-later.txt" ;;
    AGPL-3.0-or-later)   echo "https://spdx.org/licenses/AGPL-3.0-or-later.txt" ;;
    LGPL-3.0-or-later)   echo "https://spdx.org/licenses/LGPL-3.0-or-later.txt" ;;
    BSD-2-Clause)        echo "https://spdx.org/licenses/BSD-2-Clause.txt" ;;
    BSD-3-Clause)        echo "https://spdx.org/licenses/BSD-3-Clause.txt" ;;
    MPL-2.0)             echo "https://spdx.org/licenses/MPL-2.0.txt" ;;
    Unlicense)           echo "https://spdx.org/licenses/Unlicense.txt" ;;
    CC0-1.0)             echo "https://spdx.org/licenses/CC0-1.0.txt" ;;
    ISC)                 echo "https://spdx.org/licenses/ISC.txt" ;;
    EPL-2.0)             echo "https://spdx.org/licenses/EPL-2.0.txt" ;;
    *)                   echo "" ;;
  esac
}

set_pkg_license() {
  local lic="$1"
  if [[ -f package.json ]]; then
    if command -v node >/dev/null 2>&1; then
      node -e "
        const fs=require('fs');
        const f='package.json';
        const j=JSON.parse(fs.readFileSync(f,'utf8'));
        j.license = '$lic';
        fs.writeFileSync(f, JSON.stringify(j,null,2) + '\n');
      "
      print_step "package.json license set to: $lic"
    else
      print_info "Node not found; skipping package.json license update."
    fi
  fi
}

license_pkg_value=""
url=""
spdx_key=""

case "$lic_choice" in
  13) : ;;
  0|"")  url="$CORE_URL"; license_pkg_value="SEE LICENSE IN LICENSE" ;;
  1)     spdx_key="MIT" ;;
  2)     spdx_key="Apache-2.0" ;;
  3)     spdx_key="GPL-3.0-or-later" ;;
  4)     spdx_key="AGPL-3.0-or-later" ;;
  5)     spdx_key="LGPL-3.0-or-later" ;;
  6)     spdx_key="BSD-2-Clause" ;;
  7)     spdx_key="BSD-3-Clause" ;;
  8)     spdx_key="MPL-2.0" ;;
  9)     spdx_key="Unlicense" ;;
  10)    spdx_key="CC0-1.0" ;;
  11)    spdx_key="ISC" ;;
  12)    spdx_key="EPL-2.0" ;;
  *)     : ;;
esac

if [[ -n "$spdx_key" ]]; then
  url="$(spdx_url_for "$spdx_key")"
  license_pkg_value="$spdx_key"
fi

if [[ -n "$url" ]]; then
  if curl -fsSL "$url" -o LICENSE; then
    print_success "Added license from: $url"
  else
    print_error "Failed to fetch license from: $url"
    license_pkg_value=""
  fi
fi

if [[ -n "$license_pkg_value" ]]; then
  set_pkg_license "$license_pkg_value"
fi
set -u

# ------------------ Update all packages to latest (npm-check-updates) ----------
print_step "Updating all packages to latest with npm-check-updates…"
pm_add_dev npm-check-updates
npx --yes npm-check-updates -u
pm_install_all
pm_remove npm-check-updates
print_success "Package versions updated."

# ------------------ Final optional commit & push ------------------------------
print_section "💾 Git Commit & Push"
read -rp "Create a single git commit with all current changes? [Y/n]: " final_commit
final_commit="${final_commit:-Y}"

if [[ "$final_commit" =~ ^[Yy]$ ]]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if ! git rev-parse HEAD >/dev/null 2>&1; then
      default_branch="$(git config --get init.defaultBranch || echo main)"
      git checkout -b "$default_branch" >/dev/null 2>&1 || true
    fi
    git add -A || true
    git commit -m "chore: initial scaffold and configuration" || print_info "Nothing to commit."

    echo
    read -rp "Push this commit to origin now? [y/N]: " do_push
    do_push="${do_push:-N}"
    if [[ "$do_push" =~ ^[Yy]$ ]]; then
      if git remote get-url origin >/dev/null 2>&1; then
        current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
        git push -u origin "$current_branch" || print_error "Push failed. Check your credentials/remote."
      else
        print_info "No 'origin' remote set. Add one and push manually, e.g.:"
        echo "   git remote add origin <git@host:owner/repo.git>"
        echo "   git push -u origin \$(git rev-parse --abbrev-ref HEAD)"
      fi
    else
      print_step "Skipped push."
    fi
  else
    print_info "Not a git repository; skipping commit/push."
  fi
else
  print_step "Skipped final commit."
fi

# ------------------ cleanup ---------------------------------------------------
if [[ -n "${STARTER_TMP:-}" && -d "${STARTER_TMP:-}" ]]; then
  rm -rf "${STARTER_TMP}"
fi

print_section "✨ Setup Complete"
print_success "Project ready at: $(pwd)"
echo
echo "📝 Next steps:"
echo
echo "   Enter the project directory: cd $(pwd)"
echo "   Start by running: npm run dev -- --open"
echo "   To close the dev server, hit Ctrl-C"
echo
echo "💡 Stuck? Visit us at https://github.com/bchainhub/sveltekit-starter"
echo
