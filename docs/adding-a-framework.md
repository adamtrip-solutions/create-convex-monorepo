# Adding a framework

Start with current framework and Convex documentation, then install a minimal upstream example. Record the exact versions and workspace constraints in `docs/research.md`. A successful single-package app is not enough evidence for a workspace adapter.

## Implement the adapter

1. Add the framework ID to `Framework` in `src/generator/types.ts` and to the accepted list in `src/generator/options.ts`.
2. Create `src/templates/apps/<id>/index.ts` exporting an `AppTemplate`. Use `context.write`, `context.json`, and shared manifest helpers. Generate framework files under `apps/${app.name}`.
3. Register it in `src/templates/apps/index.ts` and add the interactive label in `src/commands/create.ts`.
4. Generate the public Convex environment variable with the framework's required prefix. Use statically named environment access where the bundler requires it. Add its public variable to `publicVariable` in `assets/setup/convex-setup.mjs`, update the generated README environment table, and test URL linking for the new framework.
5. Provide a framework entry point that mounts `Providers`, `AuthControls`, and a typed message UI. Auth adapters own `src/providers.tsx` and `src/auth-controls.tsx`; the framework template must not write those files.
6. Add platform handling in `src/integrations/auth/shared.ts` and a binding in the Clerk adapter. If the integration cannot work, add explicit compatibility validation before output is written.
7. Add versions, development/build/typecheck/lint scripts, and any route-generation step the framework needs on a clean checkout.

The existing Vite template is the smallest example. Next and Expo show framework-specific configuration; do not copy their environment prefixes or resolver behavior into another framework.

## Preserve the backend contract

Use a `workspace:*` dependency on `@${context.scope}/backend` and the same pinned Convex version as the backend. Import `api` from its `/api` subpath and document types from `/dataModel`. Include the compile-time contract from `common` in `src/templates/apps/shared.ts`.

Do not add a declaration bundler, a generic API cast, or copied backend code. Check that the frontend compiler can follow generated declaration imports into backend sources. Its runtime bundle should resolve the generated API JavaScript without bundling backend handlers.

## Verify before registration is considered supported

Generate the framework alone, with another frontend, and with every advertised auth provider. Cover both `--example messages` and `--example none`; use the shared entry-content helper so blank apps do not import demo files. Install from a clean directory, typecheck, lint, and run a production build. For a native framework, run its actual JavaScript bundler for supported platforms. Exercise the query and mutation against a development backend when credentials or local deployment tooling are available; report separately when that check was skipped.

Add focused output assertions, option-selection coverage, and representative generated-project CI coverage. Tests must catch missing generated declarations and widened argument/return types. Update README support notes and this guide if the framework introduces a new integration contract.

## Existing-workspace commands

Add the framework's dependency expectations and diagnostic checks to `src/workspace/doctor.ts`. Verify that `add app` renders the framework at its real workspace index so development ports remain distinct. Add command tests for a new app next to an existing customized app, both starter choices, inherited auth, automatic URL linking, and a dry run. Extend the command E2E matrix to install and build the added framework.

The add planner uses the same template as project creation. It copies only the new application's files and updates workspace metadata and root scripts. Avoid reading external project state inside a template; the planner needs to render it independently in a temporary directory.
