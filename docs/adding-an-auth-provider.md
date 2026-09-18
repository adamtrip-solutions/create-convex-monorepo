# Adding an auth provider

An auth adapter runs after framework generation and owns authentication wiring across the backend and selected apps. It must implement both frontend sessions and backend authorization. Hiding a screen is not sufficient.

## Implement the adapter

1. Add the provider ID to `Auth` in `src/generator/types.ts`, normalization in `src/generator/options.ts`, and prompt choices in `src/commands/create.ts`.
2. Create `src/integrations/auth/<id>/index.ts` exporting an `AuthAdapter`, then register it in `src/integrations/auth/index.ts`.
3. Write `packages/backend/convex/access.ts` with the `getOwner` function consumed by the example backend. Use a stable authenticated identity and reject unauthenticated access. Generate the provider's supported Convex auth configuration.
4. For each app, merge SDK dependencies through `context.mergePackage` and write `src/providers.tsx` and `src/auth-controls.tsx`. Add middleware or native configuration where the SDK requires it.
5. Generate safe environment examples and setup instructions. Separate public keys, framework server secrets, and environment variables configured on the Convex deployment.

The none adapter demonstrates file ownership. The Clerk adapter demonstrates a binding map that selects SDKs by framework. Keep provider-specific framework details in the adapter; do not introduce auth branches into every app template.

Convex Auth is the second adapter; its independent provider writer lives in `src/integrations/auth/convex-auth/providers.ts`.

`writeProviders` currently implements no-auth and Clerk-compatible provider wiring. A provider with a different session protocol should supply its own provider module or extend that helper with a concrete contract. Do not force an unrelated SDK through Clerk's `useAuth` shape.

## Required behavior

Wait for Convex authentication before mounting protected queries, handle loading and sign-in errors, and expose sign-out controls. Backend functions must verify the identity independently. Preserve the message API's arguments and return types so generated contract checks continue to apply.

Document the identity key used for ownership. Switching providers in a running deployment can change that key and requires a data migration; v0.1 does not implement auth replacement in existing projects.

For native apps, use supported secure token storage and implement redirects when the sign-in method requires them. Password-only Convex Auth does not use redirects. State whether the example supports additional verification, MFA, and session tasks. Avoid presenting a successful Metro export as proof of a working identity-provider flow.

## Tests and documentation

Test unauthenticated rejection and cross-user isolation on the backend. Generate each supported framework with the provider and run clean installation, typechecks, lint, and representative builds. Keep negative compile-time API assertions enabled. Check generated environment files for secret-prefix mistakes and ensure example files can be committed while `.env.local` remains ignored.

Use test credentials only for integration checks that need a provider account, and report those checks separately from static tests. Add provider-specific setup and troubleshooting to the generated README, repository README, and research notes. An unsupported framework combination must fail validation before generation rather than silently omitting auth.

Cover both starter-content choices in adapter tests. Blank projects retain authentication configuration and providers but omit example-specific access helpers and functions.

## Installing auth after generation

Existing-workspace auth installation renders the no-auth baseline and the selected provider, then plans their differences. The public commands are `add auth clerk`, `add auth convex-auth`, and `add auth better-auth`; adding another provider also requires extending CLI selection, metadata validation, doctor dependency checks, and `planAddAuth`.

Define the backend files the provider may add or change. Do not broaden the planner to overwrite every backend difference: schemas, user functions, and Convex generated internals remain under project ownership. Convex Auth adds `authTables` to a generated schema or conservatively patches a single `defineSchema` call with an object literal; unsupported shapes produce instructions for manual edits. Customized HTTP routers require a manual `auth.addHttpRoutes(http)` call. Generated types refresh on the next `pnpm convex:dev` or `convex codegen`. For changed app source files, require an unchanged baseline or return an actionable conflict. Merge manifest entries without replacing unrelated dependencies or scripts. Generate a separate setup guide instead of replacing the project's README. Convex Auth also adds the signing-key script and root command; follow `CONVEX_AUTH_SETUP.md` after running `pnpm install` and `pnpm convex:auth-keys`.

Test installation on existing apps for every framework and starter choice, customized-source conflicts, dependency conflicts, repeat installation, stored-data implications, and cancellation. A provider migration between identities needs a separate design; it is not implied by adding an auth adapter.

## Component providers

Better Auth uses the official `@convex-dev/better-auth` component. Follow `scripts/better-auth-assets.ts` when refreshing its messages and blank assets. Never edit `_generated` output by hand. Record the component version and codegen provenance with the assets. Component dependencies belong in the central version pins, including a compatible Better Auth release when the registry latest exceeds the component peer range.

Keep component tables out of the application schema. Add component registration through `convex.config.ts` and return an actionable conflict for an existing config that needs editing. Keep generated internals under project ownership when adding auth to an existing workspace; document the required codegen refresh. Configure deployment secrets through a generated root helper that does not print or store them, and account for every frontend origin and native scheme on the shared backend.

Test browser and native plugin selection separately. Better Auth uses `convexClient` in all clients, `crossDomainClient` in browsers, and `expoClient` with SecureStore on native platforms. Next.js and TanStack Start remain client-only. The blank starter can expose auth functions while retaining an empty application schema, so its type assertions must distinguish auth modules from example modules.
