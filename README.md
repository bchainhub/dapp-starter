# ĐApp Starter

This repository ships a one-shot installer that scaffolds a SvelteKit app, adds common deps, optionally merges a template, sets up AI toolkit integration, tweaks `.gitignore`, can copy shared assets from the starter repo, sets a license, and optionally makes a local git commit.

## Quick start

```bash
npx github:bchainhub/dapp-starter
````

With a custom template:

```bash
npx github:bchainhub/dapp-starter -- --template https://github.com/your-org/your-template.git
```

Or clone and run locally:

```bash
git clone https://github.com/bchainhub/dapp-starter.git
cd dapp-starter
npm install
node start.mjs
```

**Template options:** use `--template URL` or `-t URL` to point at a different template repo (default: mota-dapp). You can pin a version in the URL (jsDelivr-style): append `@version` (e.g. `...mota-dapp.git@1.2.3`). Alternatively use `--template-version REF` or `--tv REF` when the URL has no `@version` (e.g. default mota-dapp or a custom URL without a tag). If no version is given, the repo’s default branch is used (from the remote).

## Update from template

To refresh an existing project from the template (overwrites files with the template’s version, **except `vite.config.ts`**):

```bash
cd /path/to/your-project
node /path/to/dapp-starter/start.mjs --update
# or: npx github:bchainhub/dapp-starter -- --update
```

With a custom template or version in URL:

```bash
node start.mjs --update --template https://github.com/your-org/your-template.git
# version in URL (jsDelivr-style): ...mota-dapp.git@1.2.3
# or use --tv 1.2.3 when URL has no @version
```

- **`--update` / `-u`** — run in update mode (no new project; run from project root).
- **`--template-version REF` / `--tv REF`** — alternative to `URL@version`; use when the URL has no version (e.g. default mota-dapp or custom URL). Clone this branch or tag; if omitted, uses the repo’s default branch.
- Before overwriting, the script asks: **Create a git commit before updating (breakpoint)?** (default **Yes**). If yes, it runs `git add -A` and `git commit -m "chore: checkpoint before template update"`.
- Template is cloned to a temp dir; its contents are copied over your project (excluding `.git` and `node_modules`). Your **`vite.config.ts`** is backed up and restored so it is never replaced.
- On success you get: *Project updated from template. vite.config.ts was preserved.*

## Requirements

- Node.js 18+
- git
- one package manager: npm, pnpm, yarn, or bun

## What the installer sets up

The installer:

1. runs `sv create`
2. installs base dependencies
3. installs addon tooling
4. writes `bin/addon.mjs`
5. maps the command name `addon` in `package.json`
6. composes a project README
7. optionally adds translations, skills, template merge, license, and first commit

## Addon CLI

After installation, projects can run:

```bash
npx addon <repo> <generator> <action> [options]
```

Examples:

```bash
npx addon bchainhub@mota-addon-support support install
npx addon owner/repo auth uninstall
npx addon owner/repo auth install -c
npx addon owner/repo auth install -d
```

**Versioning:** You can pin a release, branch, or commit by appending `#<ref>` to the repo (the addon uses tiged, which supports git refs). For example, for release `1.2.3` use a tag such as `v1.2.3` or `1.2.3`:

```bash
npx addon owner/repo#v1.2.3 auth install
npx addon owner/repo#1.2.3 auth install
```

Use `#branch` for a branch or `#<commit-hash>` for a specific commit.

**Options (short and long):**

| Flag | Short | Effect |
| --- | --- | --- |
| `--cache` | `-c` | Use cache dir for repo (faster re-runs). |
| `--dry-run` | `-d` | No writes; script/config/lang steps are skipped. |
| `--no-translations` | `-nt` | Skip _lang (translations) processing. |
| `--no-scripts` | `-ns` | Skip _scripts execution. |
| `--no-config` | `-nc` | Skip _config merge. |

## Addon structure

An addon repository contains generator/action folders. Hidden files `_scripts`, `_config`, and `_lang` can live **either** in the action root **or** inside optional subfolders of the same name:

```text
<repo>/
  <generator>/
    <action>/
      prompt.js
      *.ejs.t
      _scripts.ejs.sh    or  _scripts/_scripts.ejs.sh
      _scripts.sh            _scripts/_scripts.sh
      _config.ejs.json5  or  _config/_config.ejs.json5
      _config.json5          _config/_config.json5
      _lang.sk.json5     or  _lang/sk.json5, _lang/en.ejs.json5, ...
      _lang.en.json5         _lang/en.json5
```

### The `_migrations` folder

A `_migrations` folder may be created or copied into your project (e.g. by addons or the template). It is intended for database migrations. It is listed in `.gitignore`, so it **will not be committed** to the git repository - but you can change it to commit it if you want.

You need to configure your app to use this folder. For example, with **Drizzle ORM** set `out` to `./_migrations` in your config:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./_migrations",   // 👈 custom migrations folder
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

To execute migrations, add the intended migration command to your `_scripts.ejs.sh` or `_scripts.sh` scripts.

For example:

```bash
#!/usr/bin/env bash
set -euo pipefail

npx drizzle-kit push
```

## What each file does

### `prompt.js`

Optional. Collects prompt values once.

Those same values are then reused by:

- Hygen templates
- hidden scripts
- hidden config

A `prompt.js` file can export either:

- an array of prompt definitions
- a function returning an answers object

Example array export:

```js
export default [
  {
    type: 'text',
    name: 'provider',
    message: 'Auth provider'
  },
  {
    type: 'text',
    name: 'route',
    message: 'Route name',
    initial: 'auth'
  }
];
```

Example function export:

```js
export default async ({ prompts, cwd, generator, action, repo }) => {
  const answers = await prompts([
    {
      type: 'text',
      name: 'provider',
      message: 'Auth provider'
    }
  ]);

  return answers;
};
```

### `*.ejs.t`

Normal Hygen templates. These generate or inject project files.

Example:

```text
---
to: src/routes/auth/+page.svelte
---
<h1>Hello</h1>
```

These are the only files in the addon action folder that generate normal project output.

### `_scripts.ejs.sh` / `_scripts.sh`

Optional hidden control files.

They are:

- executed automatically after Hygen
- never copied into the user project
- useful for `npm install`, `pnpm add`, formatting, cleanup, and post-generation actions

If you use `_scripts.ejs.sh`, prompt values are available through EJS:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm install <%= packageName %>
echo "Configured route: <%= routeName %>"
```

Prompt values are also exposed as environment variables:

- `ADDON_CONTEXT_JSON`
- `ADDON_REPO`
- `ADDON_GENERATOR`
- `ADDON_ACTION`
- `ADDON_VAR_<NAME>`

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "$ADDON_VAR_PROVIDER"
echo "$ADDON_CONTEXT_JSON"
```

Use `_scripts.sh` when you do not need EJS interpolation.
Use `_scripts.ejs.sh` when you want prompt-driven values inserted directly into the script before execution.

### `_config.ejs.json5` / `_config.json5`

Optional hidden config files.

They are:

- rendered automatically after Hygen
- never copied into the user project
- currently applied to the `modules` block in `vite.config.ts`

**Important:** This config is **client-side**. Never put secrets or server-only configuration here—it can end up in the client bundle.

For secrets and server config, use the official SvelteKit approach: `$env/static/private`, `$env/dynamic/private`, or Vite’s `import.meta.env` (e.g. `VITE_*` for public env vars only).

Use `_config.ejs.json5` when you want prompt values interpolated before merge:

```json5
{
  auth: {
    enabled: true,
    provider: "<%= provider %>",
    route: "<%= route %>"
  }
}
```

Use `_config.json5` when no interpolation is needed.

### `_lang` (translations)

Optional. Language files are merged into `src/i18n/<lang>/index.ts` (e.g. `src/i18n/en/index.ts`). They can live in the action root or inside a `_lang/` folder.

- **In action root:** `_lang.<code>.json5` or `_lang.<code>.<pathSuffix>.json5`, e.g. `_lang.sk.json5`, `_lang.en.content.ejs.json5`.
- **In `_lang/` folder:** `<code>.json5` or `<code>.<pathSuffix>.json5`, e.g. `sk.json5`, `en.content.ejs.json5`.

Use `.ejs.json5` when you need prompt values interpolated (e.g. `<%= routeName %>`). Use `$path` to target a different object path in the i18n file (default is `modules.<generator>`). Use `$remove` to remove keys from the target before merging (see below).

#### Removing old translation strings

To drop keys that are no longer used (e.g. when uninstalling an addon or deprecating strings), set `$remove` in the language file. It is applied to the target object before your new keys are merged. You can pass:

- **Array** — top-level keys to delete: `"$remove": ["oldTitle", "deprecatedLabel"]`
- **String** — single key: `"$remove": "oldTitle"`
- **Object** — nested removal: use `true` to delete a key, or a nested object to remove keys inside it

Example (remove two top-level keys and one nested key, then add/update others):

```json5
{
  "$path": "modules.myAddon",
  "$remove": {
    "oldTitle": true,
    "oldDescription": true,
    "actions": { "legacySubmit": true }
  },
  "title": "New title",
  "actions": { "submit": "Odoslať" }
}
```

Example `_lang.sk.json5` (or `_lang/sk.json5`):

```json5
{
  "$path": "modules.myAddon",
  "title": "Názov",
  "description": "Popis",
  "actions": {
    "submit": "Odoslať",
    "cancel": "Zrušiť"
  }
}
```

With EJS, e.g. `_lang/en.content.ejs.json5`:

```json5
{
  "$path": "modules.myAddon",
  "welcome": "Welcome to <%= featureName %>"
}
```

Skip translation application with `-nt` or `--no-translations`.

## Config merge behavior

The hidden config file is merged into the `modules` object in `vite.config.ts`. Remember: this is client-visible config—no secrets or server-only values (use SvelteKit `$env/*/private` or Vite `import.meta.env` instead).

Supported behavior:

- normal keys are merged into `modules`
- `$remove` removes keys
- `$expr("...")` injects a raw TypeScript expression instead of a quoted string

Example:

```json5
{
  auth: {
    enabled: true,
    provider: "github"
  },
  $remove: {
    legacyAuth: true
  }
}
```

That removes `legacyAuth` from `modules` and adds or updates `auth`.

### Raw expressions with `$expr(...)`

Example:

```json5
{
  auth: {
    strategy: "$expr(resolveAuthStrategy())",
    origin: "$expr(process.env.ORIGIN)"
  }
}
```

That is written into `vite.config.ts` as raw TypeScript expressions, not JSON strings.

## Important behavior

These files are never copied into the target project:

- `prompt.js`
- `_scripts.ejs.sh`
- `_scripts.sh`
- `_config.ejs.json5`
- `_config.json5`

Only normal Hygen templates like `*.ejs.t` produce project files.

## Recommended addon action layout

```text
auth/
  install/
    prompt.js
    auth.config.ts.ejs.t
    +page.svelte.ejs.t
    _scripts.ejs.sh
    _config.ejs.json5
```

Typical flow:

1. `prompt.js` collects answers
2. Hygen renders normal templates
3. `_scripts*` runs automatically
4. `_config*` is applied automatically

## Example addon

### prompt.js

```js
export default [
  {
    type: 'text',
    name: 'provider',
    message: 'Auth provider'
  },
  {
    type: 'text',
    name: 'route',
    message: 'Route name',
    initial: 'auth'
  }
];
```

### `auth.config.ts.ejs.t`

```text
---
to: src/lib/auth/auth.config.ts
---
export const authConfig = {
  provider: "<%= provider %>",
  route: "<%= route %>"
};
```

### `+page.svelte.ejs.t`

```text
---
to: src/routes/<%= route %>/+page.svelte
---
<h1>Login via <%= provider %></h1>
```

### `_scripts.ejs.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

npm install @auth/<%= provider %>
```

### `_config.ejs.json5`

```json5
{
  auth: {
    enabled: true,
    provider: "<%= provider %>",
    route: "<%= route %>"
  },
  $remove: {
    legacyAuth: true
  }
}
```

## Dry run

Use:

```bash
npx addon owner/repo addon action --dry-run
```

This runs Hygen generation but skips hidden scripts and hidden config application.

## Cache

Use:

```bash
npx addon owner/repo addon action --cache
```

This keeps addon sources under `.addon-cache/` so they do not need to be downloaded every time.

## License

This starter is licensed under the [CORE License](https://github.com/bchainhub/core-license).
