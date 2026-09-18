# Adding a framework

Supported IDs are `next`, `vite`, `tanstack-start`, `react-router`, `expo`, `astro`, and `nuxt`.

Start with current framework and Convex documentation, then install a minimal upstream example. Record the exact versions and workspace constraints in `docs/research.md`. A successful single-package app is not enough evidence for a workspace adapter.

## Implement the adapter

1. Add the framework ID to `Framework` in `src/generator/types.ts` and to the accepted list in `src/generator/options.ts`.
2. Create `src/templates/apps/<id>/index.ts` exporting an `AppTemplate`. Use `context.write`, `context.json`, and shared manifest helpers. Generate framework files under `apps/${app.name}`.
3. Register it in `src/templates/apps/index.ts` and add the interactive label in `src/commands/create.ts`.
4. Generate the public Convex environment variable with the framework's required prefix. Use statically named environment access where the bundler requires it. Add its public variable to `publicVariable` in `assets/setup/convex-setup.mjs`, update the generated README environment table, and test URL linking for the new framework.
5. Provide a framework entry point that mounts `Providers`, `AuthControls`, and a typed message UI. Auth adapters own provider and auth-control files; the framework template must not write them. React uses `src/providers.tsx` and `src/auth-controls.tsx`. Nuxt uses `src/plugins/convex.client.ts`, `src/components/Providers.vue`, and `src/components/AuthControls.vue`.
6. Add runtime handling through `uiRuntime` in `src/integrations/auth/shared.ts`, currently `react` or `vue`, and platform handling or auth bindings where supported. If the integration cannot work, add explicit compatibility validation before output is written.
7. Add versions, development/build/typecheck/lint scripts, and any route-generation step the framework needs on a clean checkout.

Astro imports an auth-owned `auth.config.mjs` integration list from its framework-owned `astro.config.mjs`. The none and Convex Auth adapters export an empty list; Clerk exports `[clerk()]` and writes middleware. This lets `add auth` update authentication without replacing the framework config. Its static page mounts one React island with `client:only="react"`.

The existing Vite template is the smallest example. Next and Expo show framework-specific configuration; do not copy their environment prefixes or resolver behavior into another framework.

## Preserve the backend contract

Use a `workspace:*` dependency on `@${context.scope}/backend` and the same pinned Convex version as the backend. Import `api` from its `/api` subpath and document types from `/dataModel`. Include the compile-time contract from `common` in `src/templates/apps/shared.ts`.

Do not add a declaration bundler, a generic API cast, or copied backend code. Check that the frontend compiler can follow generated declaration imports into backend sources. Its runtime bundle should resolve the generated API JavaScript without bundling backend handlers.

## Verify before registration is considered supported

Generate the framework alone, with another frontend, and with every advertised auth provider. Cover both `--example messages` and `--example none`; use runtime-appropriate entry content so blank apps do not import demo files. Install from a clean directory, typecheck, lint, and run a production build. For a native framework, run its actual JavaScript bundler for supported platforms. Exercise the query and mutation against a development backend when credentials or local deployment tooling are available; report separately when that check was skipped.

Add focused output assertions, option-selection coverage, and representative generated-project CI coverage. Tests must catch missing generated declarations and widened argument/return types. Update README support notes and this guide if the framework introduces a new integration contract.

## Existing-workspace commands

Add the framework's dependency expectations and diagnostic checks to `src/workspace/doctor.ts`. Verify that `add app` renders the framework at its real workspace index so development ports remain distinct. Add command tests for a new app next to an existing customized app, both starter choices, inherited auth, automatic URL linking, and a dry run. Extend the command E2E matrix to install and build the added framework.

The add planner uses the same template as project creation. It copies the new application's files and updates workspace metadata and root scripts. The planner refreshes recognized unmodified setup helpers for every framework. Adding Nuxt also adds its Turbo environment and output settings and appends `.nuxt` ignore patterns. Astro adds its Turbo environment settings and output ignores. A customized setup helper causes a conflict before writes; restore the generated helper, add Nuxt, then reapply custom changes. Avoid reading external project state inside a template; the planner needs to render it independently in a temporary directory.

## Nuxt and Vue

Nuxt supports auth `none` only. Clerk, Convex Auth, and WorkOS have no integrated Vue binding here, so Nuxt rejects them and Convex Auth OAuth. `validateCompatibility` rejects other providers during option normalization and before `add auth` plans files, including when Nuxt is not the first app. Add-app validation uses the workspace's existing auth.

The none adapter selects Vue output through `uiRuntime`. Install `convex-vue` in a `.client.ts` plugin, and mount query components inside `ClientOnly`. Keep `ssr: true`; neither server rendering nor production builds should query Convex. Read `runtimeConfig.public.convexUrl`, populated by `NUXT_PUBLIC_CONVEX_URL`. Include that prefix in URL linking, doctor secret checks, and Turbo environment inputs.

The Nuxt app uses `srcDir: 'src/'` so the shared `src/convex-api.type-test.ts` belongs to its compiler program. `nuxt prepare && vue-tsc --noEmit` uses the generated Nuxt tsconfig without a frontend `rootDir`. Lint composes `eslint-plugin-vue` essential rules with the shared TypeScript rules, using `vue-eslint-parser` and the TypeScript parser for script blocks. Ignore `.nuxt` and `.output` in lint, formatting, and git.

## React Router root authentication

The `react-router` adapter uses the upstream `app/` route layout while retaining shared components and auth files in `src/`. `app/root.tsx` mounts `Providers` around the outlet and re-exports `loader` and `middleware` from adapter-owned `src/auth.server.ts`. Each auth adapter writes that module. Clerk supplies its SSR session loader and middleware; the other adapters return null and an empty middleware list. These hooks do not load Convex data. The home route mounts `AuthControls` and the shared starter content.

Keep `.react-router` type output and `build` output out of lint, formatting, and version control. The app's Turbo config records `build/**` even when it is added to an older workspace. Adding this framework also extends an older root `.prettierignore` without replacing existing settings.
