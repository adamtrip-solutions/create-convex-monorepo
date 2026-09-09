# Adding an auth provider

An auth adapter runs after framework generation and owns authentication wiring across the backend and selected apps. It must implement both frontend sessions and backend authorization. Hiding a screen is not sufficient.

## Implement the adapter

1. Add the provider ID to `Auth` in `src/generator/types.ts`, normalization in `src/generator/options.ts`, and prompt choices in `src/commands/create.ts`.
2. Create `src/integrations/auth/<id>/index.ts` exporting an `AuthAdapter`, then register it in `src/integrations/auth/index.ts`.
3. Write `packages/backend/convex/access.ts` with the `getOwner` function consumed by the example backend. Use a stable authenticated identity and reject unauthenticated access. Generate the provider's supported Convex auth configuration.
4. For each app, merge SDK dependencies through `context.mergePackage` and write `src/providers.tsx` and `src/auth-controls.tsx`. Add middleware or native configuration where the SDK requires it.
5. Generate safe environment examples and setup instructions. Separate public keys, framework server secrets, and environment variables configured on the Convex deployment.

The none adapter demonstrates file ownership. The Clerk adapter demonstrates a binding map that selects SDKs by framework. Keep provider-specific framework details in the adapter; do not introduce auth branches into every app template.

`writeProviders` currently implements no-auth and Clerk-compatible provider wiring. A provider with a different session protocol should supply its own provider module or extend that helper with a concrete contract. Do not force an unrelated SDK through Clerk's `useAuth` shape.

## Required behavior

Wait for Convex authentication before mounting protected queries, handle loading and sign-in errors, and expose sign-out controls. Backend functions must verify the identity independently. Preserve the message API's arguments and return types so generated contract checks continue to apply.

Document the identity key used for ownership. Switching providers in a running deployment can change that key and requires a data migration; v0.1 does not implement auth replacement in existing projects.

For native apps, use supported secure token storage and a real redirect flow. State whether the example supports additional verification, MFA, and session tasks. Avoid presenting a successful Metro export as proof of a working identity-provider flow.

## Tests and documentation

Test unauthenticated rejection and cross-user isolation on the backend. Generate each supported framework with the provider and run clean installation, typechecks, lint, and representative builds. Keep negative compile-time API assertions enabled. Check generated environment files for secret-prefix mistakes and ensure example files can be committed while `.env.local` remains ignored.

Use test credentials only for integration checks that need a provider account, and report those checks separately from static tests. Add provider-specific setup and troubleshooting to the generated README, repository README, and research notes. An unsupported framework combination must fail validation before generation rather than silently omitting auth.
