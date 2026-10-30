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

The starter always targets SvelteKit `^3.0.0`, allowing the latest 3.x release on a fresh install. New projects receive `#lib`, `#data`, `#components` and `#modules/*` package import mappings and TypeScript `~6.0.3` (Kit requires its JavaScript API). Projects are detected by their SvelteKit dependency, without requiring the removed `svelte.config.js` file. The Svelte CLI (`sv@latest`) has its own version number, separate from SvelteKit.

Before updating a SvelteKit 2 project, follow the [SvelteKit 3 migration guide](https://svelte.dev/docs/kit/migrating-to-sveltekit-3). Update mode preserves Vite configuration and refuses to apply the new template to an unmigrated project. Existing `src/env.ts` declarations are also preserved. After updating, run your package manager install to refresh the lockfile and generated types.

## Requirements

- Node.js 22.17+
- git
- one package manager: npm, pnpm, yarn, or bun

## Development

We use `legacy-peer-deps=true` in the project `.npmrc` to make npm less strict when resolving peer dependencies. This allows installation to continue when a package declares an older or narrower peer-dependency range even though the newer installed version is still compatible in practice. This is particularly useful for keeping dependencies up to date without being blocked by packages whose peer-dependency declarations have not yet caught up with the latest ecosystem releases.

Sometimes, because of peer dependency incompatibility and the pressure to stay on current package versions (for security and updates), you may need to relax resolution or temporarily pin or downgrade a package so your app installs and runs.

**ĐApp Starter with npm:** the installer writes `legacy-peer-deps=true` into the project `.npmrc` (and restores it after the MOTA template merge) so installs succeed when a dependency’s peer range lags behind Vite—for example `vite-plugin-pwa` vs Vite 8.

If you still hit peer conflicts, or you are not using this installer, create a `.npmrc` file in the project **root** with `legacy-peer-deps=true` **before** installing dependencies:

```ini
legacy-peer-deps=true
```

Merge the compatibility setting without replacing registry/auth settings:

```bash
npm config set legacy-peer-deps=true --location=project
```

Commit `.npmrc` if you want the same behavior in CI and deployment pipelines that run `npm install`.

When deploying to Cloudflare, you may encounter an `adapter-auto` error because `@sveltejs/adapter-auto` detects the Cloudflare environment and expects the corresponding Cloudflare adapter to be available as a peer dependency. If this happens, install the Cloudflare adapter explicitly:

```bash
npm install -D @sveltejs/adapter-cloudflare
```

After installing the adapter, rebuild or redeploy the application. The existing `adapter-auto` configuration can then detect and use the Cloudflare adapter during deployment.

## What the installer sets up

The installer:

1. runs `sv create`
2. installs base dependencies
3. installs addon tooling
4. writes `bin/addon.mjs`
5. maps the command name `addon` in `package.json`
6. composes a project README
7. optionally adds translations, skills, template merge, blockchain interaction tools, license, and first commit

When translations are enabled, English (`en`) is always included. Additional locale codes are added alongside it; `none` or Enter keeps English only, and `all` installs every available locale.

After each skills command, choose another source or **None (continue setup)** (selected by default). Custom repository input also accepts `none` or Enter to continue. Skills commands run asynchronously with terminal input/output inherited. `/skills-lock.json` is added to `.gitignore` after the template merge; ignoring `/.agents/` is optional.

Before choosing a license, the installer asks **Install Blockchain interaction toolset**:

- **None** (default) — skip installation.
- **Connect.js (Connect Protocol)** — install `connect-protocol`.
- **CoreBC** — install `corebc`.
- **Other** — enter an npm package name, including scoped names such as `@scope/package-name`.

The selected package is installed as a runtime dependency using the project's package manager.

## Addon CLI

Use the project's installed runner. Applying directly to the current project is the default; `--dry-run` optionally performs a **static inspection** instead:

```sh
node bin/addon.mjs owner/repo generator install --dry-run
```

The report shows the normalized repository, resolved full commit SHA, files, static destination hints, declared packages/migrations and enabled stages. Dynamic output paths and arbitrary code effects remain unknown until execution. Inspection does not import prompt.js, render EJS, execute hooks/scripts, install dependencies, regenerate translations or write project files. Fetching source uses a temporary directory outside the project.

Apply directly using the selected repository/ref:

```sh
node bin/addon.mjs owner/repo generator install --answers '{"route":"account"}'
```

`--apply` is an optional explicit alias for the default behavior and cannot be combined with `--dry-run`. `--commit FULL_SHA` optionally pins the full SHA printed by inspection; without it, the requested repository ref (or default HEAD) is resolved at invocation time. There is no project copy or execution sandbox: approved EJS, prompts and shell commands retain host permissions. Review their effects before enabling them.

Repository input accepts owner/repo, github:owner/repo, HTTPS URL, or an absolute local Git repository path. Addon refs use `#branch`, `#tag` or `#commit` (quote the argument), not the installer's `@version` template syntax. Generator and action must each be one letters/digits/hyphen/underscore segment. HTTPS URLs cannot contain credentials or query parameters. Git hooks/global config are disabled for retrieval; use a local reviewed checkout for sources needing custom authentication configuration.

`npx addon ...` remains a convenience alias only when it resolves to this installed runner. Prefer `node bin/addon.mjs` to avoid an unintended npm-registry fallback.

### Stage controls

| Option | Effect |
| --- | --- |
| No execution flag, or `--apply` | Render/generate files and merge enabled config/translations directly |
| `--commit SHA` | Optionally pin an exact full commit instead of resolving the repository ref |
| `--dry-run`, `-d` | Static inspection only; no addon execution or project writes |
| `--answers JSON` | Non-secret prompt data, supplied without executing prompt.js |
| `--allow-prompts` | Execute reviewed prompt.js; explicit --answers values override collected values |
| `--allow-scripts` | Run the selected reviewed plain hidden shell script after file/package stages |
| `--allow-expressions` | Permit raw `$expr(...)` config/translation values |
| `--allow-packages` | Install exact registry versions declared in addon.json; npm lifecycle scripts disabled |
| `--allow-package-scripts` | Also permit npm dependency lifecycle scripts; requires --allow-packages |
| `--run-migrations --migrations-only --migration-target NAME` | Separate migration-only invocation with an explicit named target |
| `--overwrite` | Allow generated files to replace existing files; template force does not bypass this |
| `--cache`, `-c` | Cache source Git objects by normalized repository and full commit outside the project during apply |
| `--no-scripts`, `-ns` | Skip the hidden script stage |
| `--no-config`, `-nc` | Skip hidden config merge |
| `--no-translations`, `-nt` | Skip hidden translation merge |

Plain _config/_lang merges run during application (the default); EJS used in them is executable code. Source symlinks/submodules are rejected. Destination validation rejects absolute paths, .. components, Windows/backslash paths, symlink/hard-link destinations, .git, node_modules, .addon-cache and overwriting the runner itself. All runner-managed output is validated before the first write. This constrains the file writer, not arbitrary explicitly enabled JavaScript or shell code.

Raw shell `sh`/`setup` template hooks, addon index.js, project .hygen.js and unsafe YAML tags are not executed by the controlled template renderer. The installed Hygen front-matter/context/injection utilities are used without invoking its CLI engine. Reviewable output is kept in memory until validation, then written directly into the project. File application is not a multi-file transaction; inspect the working tree if a later I/O or explicit command fails.

### Exact source and cache identity

Each invocation resolves the selected branch/tag to a commit and reports it. Without --commit, a later invocation can resolve to a newer commit. With optional --commit SHA, apply fetches **that SHA directly**, even if the branch moves afterward. Cache keys include repository and full commit; cached Git objects are integrity-checked, and blob IDs are verified before materializing addon source. No working checkout, Git filters or addon package lifecycle scripts run during fetching. A cache is not evidence that code is trustworthy. Current apply still verifies/fetches the selected commit, so the cache is not an offline-install guarantee.

## Addon action structure

Both generator/action and _templates/generator/action layouts are supported:

```text
generator/install/
    addon.json
    prompt.js
    page.svelte.ejs.t
    other.ts.t
    _scripts/_scripts.sh
    _config/_config.json5
    _lang/en.json5
```

Normal `.t` templates (including `.ejs.t`) are rendered. Control files are not copied as generated output. Config and script search checks action root before the optional subfolder and uses the first supported candidate. Locale processing collects matching _lang files. The controlled renderer supports to, inject, before/after, prepend/append, at_line, eof_last, skip_if, unless_exists, force, from and message; unsupported attributes fail explicitly.

### Prompts and inputs

prompt.js exports either an array of `prompts` questions or an async function receiving `{ prompts, cwd, generator, action, repo, commit }`. It is imported only with --allow-prompts. Otherwise --answers supplies data directly. Values must be JSON-compatible and keys cannot override runner/template internals. Do not collect credentials: values can be available to subprocess environments and generated files.

```js
export default [
    {
        type: 'text',
        name: 'route',
        message: 'Route segment',
        initial: 'account',
        validate: (value) => /^[a-z][a-z0-9-]*$/.test(value) || 'Use a lowercase route segment'
    },
    {
        type: 'select',
        name: 'provider',
        message: 'Provider',
        choices: [{ title: 'Local', value: 'local' }, { title: 'External', value: 'external' }]
    }
];
```

Validate data for its destination, including values supplied through --answers. The runner checks generated paths independently. Serialize strings in TypeScript output rather than inserting them into quoted literals:

```text
---
to: src/routes/<%= route %>/+page.svelte
---
<h1>Account</h1>
```

```text
---
to: src/lib/account-config.ts
---
export const provider = <%- JSON.stringify(provider) %>;
```

A truthy legacy runMigration answer is refused during generation. Declare migration commands separately instead of embedding auto-migration into a prompt/default.

### Scripts and packages

Hidden scripts are opt-in and must be plain shell source. Shell templates containing `<%` interpolation are rejected, even with --allow-scripts. Convert `_scripts.ejs.sh` into `_scripts.sh` that reads validated/quoted environment data:

```bash
#!/usr/bin/env bash
set -euo pipefail
case "${ADDON_VAR_ROUTE:-}" in
    account|profile) printf 'Configured route: %s\n' "$ADDON_VAR_ROUTE" ;;
    *) printf 'Unsupported route\n' >&2; exit 1 ;;
esac
```

Context variables include ADDON_CONTEXT_JSON, ADDON_REPO, ADDON_COMMIT, ADDON_GENERATOR, ADDON_ACTION and ADDON_VAR_<UPPERCASE_NAME>. The runner passes data through environment variables, never EJS interpolation into shell source. Do not use eval or unquoted expansions in addon scripts. Explicitly permitted scripts still have full host permissions and can perform undeclared package installs or DB operations; stage flags cannot constrain arbitrary code without a sandbox.

Declare package installs in the action's static addon.json instead:

```json
{
    "version": 1,
    "description": "Account feature",
    "packages": {
        "dependencies": ["zod@4.6.7"],
        "devDependencies": []
    },
    "migrations": [
        {
            "name": "Account schema",
            "command": "node",
            "args": ["bin/migrate-account.mjs", "--target", "{{target}}"]
        }
    ]
}
```

Use actual selected versions; only exact registry package specs are accepted (no Git/file URLs, shell strings or floating ranges). --allow-packages currently supports npm projects; other managers must use their own reviewed package commands separately. npm is invoked with an argument array, --save-exact and --ignore-scripts unless lifecycle execution was explicitly allowed. No new permission is inferred from an addon README.

### Databases and migrations

A generated _migrations folder is SQL/history, not a live database connection. The starter ignores /_migrations/ and /better-auth_migrations/ by default. To commit migrations, remove only those ignore rules, review SQL plus journal/snapshot files, and stage the chosen files. To keep history private, retain the ignores and supply a private migration artifact/repository to CI; an ignored directory will not appear in a clean checkout. Never store credentials or production data in migration SQL.

Configure the selected ORM's output directory explicitly, for example Drizzle `out: './_migrations'` with an existing server-side schema path and dialect. Keep DB URLs in server environment/deployment secrets; migration CLI config uses its own environment loader, not browser site config. Generate/review SQL and test it against a disposable DB before applying to the intended target. Drizzle push is a direct schema change, not equivalent to reviewed generated migration history.

The manifest's migration commands run only through a separate invocation:

```sh
node bin/addon.mjs owner/repo generator install --run-migrations --migrations-only --migration-target staging
```

Add --dry-run to inspect the migration-only invocation without executing it; --commit SHA is optional here too. Every migration must have a name, executable command and string args array, including `{{target}}`. The runner substitutes the named target as a literal argument and sets ADDON_MIGRATION_TARGET; it does not interpolate a shell command. The migration program must resolve that name to its configured database and validate the target. It runs from the current project, so generate its migration files/entrypoint first. No templates, prompts, package installs, merges or hidden scripts run during migration-only execution. The command still has host permissions; inspect it and its DB mapping before execution. Keep DB credentials out of target names and command arguments.

### Config composition

_config.json5 or _config.ejs.json5 merges into the client-visible modules block of vite.config.ts. Never include credentials or private environment values. $remove applies before merging. `$navbarItems` and `$authItems` accept $append/$remove arrays for idempotent navbar/user-menu composition; matches use the supplied fields.

```json5
{
    support: { enabled: true },
    $navbarItems: { $append: [{ label: "navbar.support", to: "/support", position: "left" }] }
}
```

Uninstall uses `$remove: [{ to: "/support" }]` under $navbarItems and module-specific $remove entries. Avoid removing other addons' items. `$expr(...)` injects raw TypeScript only with --allow-expressions; use reviewed fixed expressions, never user strings or secrets. Reserved prototype/internal wrapper keys are rejected in incoming data.

### Translations

Use _lang.en.json5 in the action root or _lang/en.json5. `$path` defaults to modules.<cleanedGenerator>; explicit paths target existing locale dictionaries. $remove accepts a key/string, key array or nested deletion object.

```json5
{
    $path: "modules.support",
    $remove: ["oldTitle"],
    title: "Support"
}
```

Translation writes obey destination checks. The runner prints a reminder after dictionary changes; it does **not** automatically execute typesafe-i18n or npx. After reviewing the generated diff, run the installed project's i18n:extract script yourself. Do not hand-edit generated translation types.

## Compatibility with older addons

Older instructions that say “install runs everything”, “dry-run runs Hygen”, “put migrations in _scripts”, or “interpolate prompt answers into _scripts.ejs.sh” are obsolete for this runner. Use --dry-run when inspection is wanted, optionally pin with --commit SHA, migrate package/DB effects to addon.json, and replace interpolated scripts with quoted environment data. Unsupported hooks fail instead of executing implicitly.

## Resources

- [📦 MOTA addons search](https://github.com/topics/mota-addon)
- [📖 MOTA skills search](https://skills.sh)

## License

This starter is licensed under the [CORE License](https://github.com/bchainhub/core-license).
