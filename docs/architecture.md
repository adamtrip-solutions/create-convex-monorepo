# Architecture

Generation has one normalized input, a filesystem context, a framework registry, and an auth registry. It creates a new workspace; it does not mutate existing projects or load arbitrary third-party plugins.

## Execution

`src/commands/create.ts` parses flags and collects missing interactive answers. `src/generator/options.ts` validates names, resolves app names, rejects unsupported choices, and sets install/git defaults and validates the optional Convex initialization step. Both the CLI and exported `generateProject` API use this normalization.

`src/generator/index.ts` checks the destination and creates a sibling staging directory. It generates root files, copies the backend source and official generated assets, runs each selected app template, then applies one auth adapter. Only after template composition succeeds does it copy files exclusively into the destination and run optional installation, `git init`, and Convex initialization. The commit is not an atomic rename. A failure rolls back only files and directories created by that invocation, preserving an existing empty directory and concurrent user files.

Template errors clean up staging. Installation, git and Convex initialization failures preserve completed project files so users can retry setup. Existing non-empty directories and symlinks are rejected. No git commit or registry publication occurs during generation.

## Contracts and ownership

`src/generator/types.ts` defines `AppSpec`, `ProjectOptions`, `AppTemplate`, `AuthAdapter`, and `GeneratorContext`.

An app template implements `generate(context, app)`. It owns its framework entry points, application manifest, bundler configuration, environment example, and demo. Shared helpers in `src/templates/apps/shared.ts` generate manifests, environment files, type contracts, and web message components.

An auth adapter implements `apply(context)`. It owns backend `access.ts`, optional auth configuration, and app `providers.tsx` and `auth-controls.tsx`. Framework templates import those stable module names without importing Clerk. Clerk's binding map selects the framework SDK, middleware and native dependencies in `src/integrations/auth/clerk/index.ts`. Adding a provider requires platform-specific integration, but does not require embedding provider branches throughout framework templates.

`context.write` and `context.json` create files once and reject unsafe paths and collisions. `context.mergePackage` can update only manifests created by that context. Dependency maps merge by key and reject conflicting versions; script patches replace matching script keys. Other top-level manifest fields replace their previous values. This is intentionally not a generic deep-merge engine.

`src/generator/format.ts` uses the pinned Prettier runtime API with explicit options before authored files are written. It never resolves user configuration or loads user plugins. Convex `_generated` assets, route-tree output, and unsupported extensions such as dotenv pass through unchanged. Generated workspaces receive matching format scripts, configuration, and ignore patterns. Formatting failure is a generation failure and uses the same staging cleanup.

The package-manager contract lives in `src/package-manager/index.ts`. pnpm owns installation; subprocesses receive argument arrays and inherited terminal output. The root template owns Turborepo and workspace configuration. There is no Nx adapter or speculative migration engine.

## Shared Convex API

The backend is a source workspace package. Its `/api` export has a `types` condition for `convex/_generated/api.d.ts` and a runtime condition for `api.js`. `/dataModel` exposes only declarations. Consumers keep backend modules available because Convex's dynamic declarations derive types from their exports.

Do not bundle those declarations, export backend implementation modules to clients, replace the generated API with a generic proxy, or add TypeScript project-reference boundaries that prevent source resolution. The official runtime uses a proxy, while the original declarations preserve function signatures. Each messages-example frontend's `src/convex-api.type-test.ts` checks argument types, return types, document IDs, and invalid API keys.

`assets/backend/convex` contains the example and official generated output. Refresh generated output with a supported Convex development workflow after changing backend modules. Do not edit generated internals. New projects can typecheck the committed example before selecting their own deployment. Subsequent code generation requires normal Convex setup.

## Environment and process boundaries

The backend owns deployment configuration. Each app owns its public URL and publishable auth key with the prefix required by its bundler. Server secrets never receive public prefixes. Auth adapters add `.env.clerk.example` alongside the framework's `.env.example`; users combine their values in `.env.local`.

The generated `scripts/convex-setup.mjs` is a standalone Node script copied from `assets/setup`. It resolves the installed Convex CLI from the backend package and runs `convex dev --once` with inherited terminal output. Setup runs outside Turbo so account and deployment prompts have a terminal. Only a successful push triggers URL linking. The helper reads backend `.env` and `.env.local`, with local values taking precedence, and copies only `CONVEX_URL`. It preflights application paths, rejects symlinks, and appends a framework-specific assignment while preserving existing settings. Repeating the same link leaves files unchanged. Cancellation and failures return a nonzero exit status, preserve the project, and allow setup to be retried. `convex:link` runs just the linking stage. Both commands work without the generator installed. Development runs one persistent backend watcher and the selected apps with streamed logs. Build and typecheck tasks do not deploy or start watchers. Public environment variables participate in build inputs.

## Extension and compatibility policy

Registries and TypeScript unions make supported choices explicit. Dependencies are pinned in `src/templates/versions.ts` and in framework bindings where necessary. New adapters should add concrete capabilities, with install, type, and bundler evidence for each supported combination. Reject an unsupported combination clearly rather than emitting code known to fail.

`convex-monorepo.json` records a versioned description of the output. Workspace commands validate it before inspecting or planning edits. The exported API supports programmatic generation; custom runtime registry injection is not implemented.

## Starter content

`example` is independent of framework and auth selection. `messages` keeps the existing example; `none` selects blank apps and the empty backend assets. The backend template chooses the matching official generated declarations. App entry content comes from a shared helper, while framework setup and auth adapters keep their existing responsibilities. Auth adapters omit the demo's access helper in blank mode but still configure the selected provider.

Blank apps do not include tests that assume an empty API forever. The generated-project test runner injects temporary compile-time assertions for an exactly empty API and table list, rejects unknown modules, and checks for widened types. Those files belong only to the disposable test fixture.

## Workspace commands

Both binaries ship in `create-convex-monorepo`. `src/commands/entry.ts` routes the create binary to creation or workspace commands, so the same npm package works through npx without a local or global installation. With no arguments, existing workspace metadata selects an interactive management menu or noninteractive help. Explicit `create <name>` resolves reserved-name ambiguity. The separate `convex-monorepo` binary remains a management-only entry point. `src/commands/workspace.ts` parses command-specific options and prompts. Application logic lives in `src/workspace` and is exported for programmatic use.

`project.ts` walks upward to metadata, validates version 1, retains extension fields, and rejects unsafe file paths. `add.ts` renders temporary scaffolds with the existing app/auth adapters, then selects only the new app or authentication changes. Auth package updates merge only the fields changed by the adapter; source files must match the expected baseline before replacement. Comparison normalizes formatting with the same formatter to support older unformatted templates, preserving meaningful code and comment differences as conflicts. Apply-time snapshots still compare exact contents. Per-app example overrides survive later auth additions.

`env.ts` shares the standalone setup script's URL validation and dotenv linking helpers. A declaration file types that plain JavaScript module for the compiled CLI; the JavaScript implementation is separately checked by TypeScript. Generated projects still receive the standalone script and need no CLI dependency for initial Convex setup.

`changes.ts` applies file plans after checking snapshots, absent destinations, and path safety. Dry runs perform the same preflight without acquiring a lock or writing. Mutations hold a workspace lock, use exclusive creation or temporary-file replacement, and roll back only files that still match their written contents. The lock coordinates CLI instances, not editors; snapshot checks cannot make arbitrary external writers transactional. File plans contain before/after text and may include local environment values, so the CLI displays paths rather than serializing mutation plans.

`doctor.ts` checks local configuration and uses the app's installed TypeScript compiler for an in-memory API probe. It never emits probe files. `upgrade.ts` renders reference manifests through the shared `planning.ts` helpers and builds a guarded change plan for existing exact dependency pins, pnpm, and generator metadata. It preserves newer pins and unrelated fields, reports missing dependencies, and rejects non-exact customizations before writing. Template files are not migrated. The plan does not write the lockfile; optional installation runs after applying it. `upgrade --check` queries the fixed official npm package endpoint with cancellation and a timeout. Its dependency baseline belongs to the running CLI, and is not a compatibility claim about every newer upstream package.
