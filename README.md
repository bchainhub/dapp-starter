# SvelteKit Starter – Installer

This repository ships a one-shot installer that scaffolds a SvelteKit app, adds common deps, optionally merges a template, sets up AI toolkit integration, tweaks `.gitignore`, can copy shared assets from the starter repo, sets a license, and (optionally) makes a local git commit.

## 🚀 Quick start

**One command (no clone):**

```bash
npx github:bchainhub/sveltekit-starter
```

With a custom template:

```bash
npx github:bchainhub/sveltekit-starter -- --template https://github.com/your-org/your-template.git
```

**Or clone and run locally:**

```bash
git clone https://github.com/bchainhub/sveltekit-starter.git
cd sveltekit-starter
npm install
./sv-starter.mjs
```

> 💡 With `npx github:...`, use `--` before flags for `sv create` (e.g. `-- --template URL`).

## ✅ Requirements

* **Node.js** 18+ (20+ recommended) and `npx`
* **git** (for cloning templates and committing)
* One or more package managers available (the installer auto-detects): `pnpm`, `bun`, `yarn`, or `npm`

## 🖥️ Platform Support & Testing

### ✅ Tested Platforms

* **macOS 14.6.0 (Sonoma)** - Primary testing platform, fully tested and supported
* **macOS 13+ (Ventura)** - Compatible and tested
* **Linux (Ubuntu 22.04+)** - Compatible with most distributions

### 🔧 Cross-Platform Features

* **Node.js**: Single `sv-starter.mjs` script with `@clack/prompts` UI
* **Package managers**: Auto-detects npm, yarn, pnpm, bun across platforms
* **Git operations**: Standard git commands that work everywhere

## 🧭 What the installer does (in order)

1. **Runs SvelteKit creator**
   Uses `npx sv create "$@"` to start a new project (your answers go to SvelteKit's wizard).

2. **Detects the created project directory**
   Automatically `cd`'s into it (even if SvelteKit created a subfolder).

3. **Installs base packages**
   Installs a curated set of deps for this starter.

4. **Translations (interactive)**
   Choose to install `typesafe-i18n` for internationalization (default **Yes**).

5. **Agent Skills (interactive)** — [skills.sh](https://skills.sh/)
   Multiselect: interactive search (`npx skills find`), Core Blockchain Skills, MOTA Skills, or add your own repo. Optionally add `.agents/` and `skills-lock.json` to `.gitignore`.

6. **(Optional) Merge a template repository**
   By default, uses:
   `https://github.com/blockchainhub/sveltekit-mota.git`
   Override with `--template <repo-url>`.

   Before merging, removes `src/routes/+page.svelte` to avoid conflicts.

7. **Initialize git (if needed)**
   Initializes a repository if none exists.

8. **Augment `.gitignore`**
   Appends extra ignores: OS cruft, logs, editor folders, addon cache, output dirs, Wrangler, migrations. **Optional:** ignore lockfiles (default **Yes**).

9. **(Optional) Copy shared assets from this starter repo**

    * **`.editorconfig`** (default **Yes**):
      Pulled from `editors/.editorconfig` and placed at project root as `.editorconfig`.
    * **`.github`** (default **No**):
      Copies `providers/.github/` to your project root as `.github` (includes `ISSUE_TEMPLATE`).
      If retrieval fails, the installer **prints a failure and skips**—no fallback files.

10. **License selection (interactive)**
    Default is **CORE** (your org's license). You can also choose from common SPDX licenses or **None**:

    * CORE (custom)

      * Fetches from: `https://raw.githubusercontent.com/bchainhub/core-license/refs/heads/main/LICENSE`
      * Writes to `LICENSE` and sets `package.json` → `"license": "SEE LICENSE IN LICENSE"` (npm-compliant for non-SPDX).
    * SPDX licenses (MIT, Apache-2.0, GPL-3.0-or-later, AGPL-3.0-or-later, LGPL-3.0-or-later, BSD-2/3, MPL-2.0, Unlicense, CC0-1.0, ISC, EPL-2.0)

      * Fetched from canonical text endpoints.
      * Writes to `LICENSE` and sets `package.json` → `"license": "<SPDX-ID>"`.
    * None

      * Skips creating `LICENSE` and leaves `package.json` alone.

    > If the license text can't be fetched, the script prints an error and **does not** modify `package.json`.

11. **Final (optional) local commit**
    Prompt: "Create a single git commit with all current changes?" Default **Yes**.
    If **Yes**, it stages everything and commits locally.

    Optionally prompts to push to origin (default **No**).

## 🧩 Options & flags

* `--template <git-url>`
  Use a different template repository for the initial project structure.
  Example:

  ```bash
  ./sv-starter.mjs --template https://github.com/your-org/your-sveltekit-template.git
  ```

* Any additional arguments are forwarded to `sv create`.
  Example:

  ```bash
  ./sv-starter.mjs --name my-app
  ```

## 🔌 Addons (plugins)

The installer adds an **addon** script to `package.json`. Addons are [hygen](https://www.hygen.io/)-based generators fetched from a repo (e.g. GitHub) and run in your project. They can add files, config, or run setup steps.

### Install an addon

```bash
npx addon <repo> <generator> <action> [option]
```

* **&lt;repo&gt;** – Source of the addon (e.g. `bchainhub@mota-addon-corepass` or `owner/repo`).
* **&lt;generator&gt;** – Hygen generator name (e.g. `auth`).
* **&lt;action&gt;** – Hygen action name (e.g. `install`).
* **\[option\]** – Optional. Use `--cache` to keep templates under `.addon-cache/` so the same addon is not re-downloaded each time.

**Examples:**

```bash
# Install CorePass Passkey auth addon
npx addon bchainhub@mota-addon-corepass auth install

# Same addon, cached under .addon-cache/
npx addon bchainhub@mota-addon-corepass auth install --cache
```

### Uninstall (remove) an addon

If the addon provides an **uninstall** (or **remove**) action, run it to reverse the install (e.g. remove added files and clean up):

```bash
npx addon <repo> <generator> uninstall
```

**Example:**

```bash
# Remove CorePass Passkey addon (removes files added by the addon)
npx addon bchainhub@mota-addon-corepass auth uninstall
```

The addon repo must implement that action (e.g. `auth/uninstall/`) and use hygen to delete or revert the same files it created during install.

### Create a simple addon

An addon is a repo that contains [hygen](https://www.hygen.io/) generator/action folders at its root, e.g. `auth/install/` and `auth/uninstall/`. When users run the addon, that content is fetched and used locally as `_templates/auth/install`, `_templates/auth/uninstall`, and so on. In the repo you only have the generator/action paths. The layout is:

```text
<repo>/
  <generator>/
    <action>/
      prompt.js          # optional: prompt for variables
      *.ejs.t            # template files (e.g. Component.svelte.ejs.t)
```

#### 1. Repo structure example

```text
my-addon/
  auth/
    install/
      auth.config.ts.ejs.t
      +page.server.ts.ejs.t
    uninstall/
      cleanup.ejs.t   # or use a script that removes the same paths
```

Locally, these are used as `_templates/auth/install` and `_templates/auth/uninstall`.

#### 2. Template file example

In the repo: `auth/install/auth.config.ts.ejs.t`. Locally: `_templates/auth/install/auth.config.ts.ejs.t`.

```text
---
to: src/lib/auth.config.ts
---
export const config = { /* ... */ };
```

#### 3. Uninstall

Provide an `uninstall` action that removes the files your addon added. For example, in `auth/uninstall/` you can have a template that runs a shell script or use hygen’s ability to generate “removal” steps. A simple approach is a single template that outputs a list of paths to delete, then run that list with `rm` or a small script.

#### 4. Use the addon

Push the repo (e.g. to GitHub). Users install with:

```bash
npx addon owner/my-addon auth install
npx addon owner/my-addon auth uninstall
```

For GitHub, `<repo>` is `owner/repo` (no `@`). The `@` prefix is only for npm-scoped package names (e.g. `scope@repo`), not required by GitHub.

## 📝 What to expect during prompts

* **Auth:** pick none/Auth.js/Lucia. If you choose Auth.js, you are then asked whether to **install CorePass Passkey** addon (default **Yes**).
* **DB:** pick a data layer (or None).
* **Translations:** install typesafe-i18n (default **Yes**).
* **AI Toolkit:**
  * Download AGENTS.md (default **Yes**)
  * Include Spec-Kit (if available, default **Yes**)
  * Select AI agent: GitHub Copilot/Cursor/Continue.dev/Other (default: GitHub Copilot)
  * Add `.specify/` to `.gitignore` (default **Yes**)
* **Ignore lockfiles:** default **Yes** (adds them to `.gitignore`).
* **Copy `.editorconfig`:** default **Yes** (from `editors/.editorconfig`).
* **Copy `.github` folder:** default **No** (from `providers/.github/`).
* **License:** default **CORE**.

  * For CORE (non-SPDX) we set `package.json` → `"SEE LICENSE IN LICENSE"`.
  * For SPDX licenses we write the SPDX ID to `package.json`.
* **Final commit:** default **Yes** (optionally push, default **No**).

## 🔐 Security note

Clone the repo and review `sv-starter.mjs` before running:

```bash
git clone https://github.com/bchainhub/sveltekit-starter.git
cd sveltekit-starter
# review sv-starter.mjs, then:
npm install && ./sv-starter.mjs
```

## 🧯 Troubleshooting

* **"command not found: node / npx / pnpm / git"**
  Install Node.js 18+ and the missing tool, then rerun.
* **Template/asset copy fails**
  The script prints a ❌ message and skips that step—no fallbacks are written.
  Check the URL/branch/path and your network access.
* **License wasn't set in `package.json`**
  This only happens if fetching the license text failed. Fix the URL/network and rerun that step, or set `license` manually.
* **Skills or addon step fails**
  You can run `npx skills find` or `npx skills add owner/repo` later from the project directory.

## 🧱 Reproducible asset copies (optional)

If you want to pin the asset copy steps to an exact commit:

* Replace the raw base:

  ```bash
  https://raw.githubusercontent.com/bchainhub/sveltekit-starter/<COMMIT_SHA>
  ```

* After cloning the starter repo, check out the same SHA before syncing:

  ```bash
  git -C "$STARTER_TMP" checkout <COMMIT_SHA> --quiet || true
  ```

## 📂 What gets created

* A SvelteKit project with your selections.
* `package.json` with updated dependencies, an **addon** script for plugins (see [Addons](#-addons-plugins)), and (optionally) `license`.
* `.gitignore` with enhanced ignores (+ optional lockfile excludes, + optional AI Agents section).
* Optional `.editorconfig` and `.github/ISSUE_TEMPLATE` from the starter repo.
* Optional `AGENTS.md` (AI constitution file) from agents-sveltekit repository.
* Optional `.specify/` directory (if Spec-Kit is included).
* `LICENSE` file per your selection.

Happy hacking! ✨
