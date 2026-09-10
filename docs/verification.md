# v0.1 verification

Executed on 2026-09-09 on macOS with Node 24.17.0 and pnpm 10.34.5. Results refer to the implementation in this repository, not every future upstream release.

## Repository checks

| Command                          | Result                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Passed                                                                                                                                                    |
| `pnpm lint`                      | Passed                                                                                                                                                    |
| `pnpm format:check`              | Passed                                                                                                                                                    |
| `pnpm typecheck`                 | Passed                                                                                                                                                    |
| `pnpm test`                      | 98 passed: 41 core, 13 generator/golden, 14 setup, 11 blank, 14 release, 5 backend                                                                        |
| `pnpm build`                     | Passed                                                                                                                                                    |
| `pnpm pack`                      | Passed                                                                                                                                                    |
| `node scripts/pack-smoke.mjs`    | Installed the tarball outside the checkout and generated Next + Expo + Clerk through its bin; official generated assets and standalone URL linking passed |

The twelve golden combinations cover every requested fixture plus Vite + Clerk and Start + Clerk. An additional regression test covers numeric-leading names, matching native auth redirects, ten applications, dev concurrency and tracked environment examples. Filesystem tests cover traversal, symlinks, existing content, cancellation, collisions, and failed install/git recovery.

Backend tests execute generated functions with `convex-test`. They check persistence, trimming, input length, the fifty-message bound, unauthenticated rejection and isolation between identities.

## Generated-project checks

`pnpm test:e2e` generates into a fresh OS temporary directory, installs dependencies, and runs root `pnpm typecheck`, `pnpm lint` and `pnpm build`. It supplies syntactically valid public test configuration so bundlers compile the actual providers. Test Clerk keys are synthetic and cannot authenticate. Set `CCM_APPS` and `CCM_AUTH` to choose the case. A failed fixture is retained and its path printed; successful fixtures are removed unless `CCM_KEEP_FIXTURE` is set.

Completed all-four-framework workspaces with both `none` and `clerk`. Next builds used Turbopack; Vite produced client bundles; Start produced client and server bundles. Expo exported iOS and Android Metro/Hermes bundles using isolated pnpm workspace links and the default Metro resolver. Client output scans also reject the backend index name, backend validation text and synthetic server-secret marker in shipped JavaScript or Hermes bundles. Each frontend's standalone TypeScript program checked the concrete shared API argument, document and return types, plus negative API-key assertions.

The six definition-of-done combinations are also checked individually: Next, Vite, Start, Expo, Next + Expo, and Next + Expo + Clerk. The GitHub Actions matrix repeats these combinations and adds Vite + Start + Clerk. CI has been authored but has not run on a hosted GitHub runner in this session.

## Live checks

`CONVEX_AGENT_MODE=anonymous convex dev --once` compiled and pushed the example to a local deployment using Convex 1.45.0. The unmodified official generated files were captured from that workflow. The generated workspace's `pnpm convex:setup` also pushed successfully from packages/backend.

The generated all-four workspace's `pnpm dev` started Convex, Next, Vite, Start and Metro together with streamed logs. A `ConvexHttpClient` sent and queried a message; a separate `ConvexClient` subscription observed that mutation. The Next, Vite and Start development servers each returned HTTP 200. Creating environment files during a Start server restart caused one transient request failure; a subsequent request succeeded.

The interactive CLI was exercised in a PTY and created a Next + Expo project. The noninteractive CLI and installed tarball bin were also exercised.

## Limits

No browser was available through the browser-control tool, so page interaction and visual review were not performed. Fable was unavailable; no independent UI/UX review is claimed. Fresh technical review found scheme and task-concurrency defects, which were fixed and checked again.

Real Clerk sessions, Google OAuth, MFA/session tasks, native Xcode/Gradle builds and physical devices were not tested. Metro exports prove JavaScript module resolution and bundling, not native binary execution. Start's Convex data is client-driven; authenticated server prefetching is not configured. Optional upstream peer warnings are recorded in research.md.

Windows and Node 22 checks are configured in CI but were not executed locally. No npm publication, remote repository creation or production deployment occurred.

## Initialization and release automation checks

The initialization follow-up passed repository install, lint, formatting, typecheck, all 73 tests, build, pack, and installed-tarball smoke checks. Setup tests cover option conflicts, dependency ordering, preserving failed projects, all four environment prefixes, existing multiline settings, secret exclusion, invalid URLs, symlinks, child-process failure, and cancellation. The tarball test runs the copied URL linker without installing the generated project's dependencies.

Ran the built CLI with `--apps web:next,admin:vite,app:tanstack-start,mobile:expo --auth none --init-convex --no-git` in a fresh temporary directory with `CONVEX_AGENT_MODE=anonymous`. It installed dependencies, pushed to a real local Convex deployment and linked every frontend. Each generated environment file contained exactly its public URL assignment. Re-running `pnpm convex:link` preserved their modification times. The resulting root `pnpm typecheck`, `pnpm lint` and `pnpm build` passed for all four apps, including iOS and Android Metro/Hermes exports.

A separate PTY run accepted the new initialization prompt for Next + Expo. Dependencies installed automatically, Convex pushed successfully, and both URLs linked. Anonymous mode exercised local setup; browser account login and cloud project selection were not tested.

Fresh technical review reproduced a cancellation race during URL linking. The fix passes the abort signal through the linking stage and checks it before each write and before reporting completion. A focused reviewer follow-up reran the reproduction and confirmed rejection after cancellation, with the remaining app untouched. Partial completed writes stay available and linking can be rerun.

The release-please configuration passed validation against its upstream schema, and the PR-title rule accepted five valid titles and rejected five invalid titles. CLI and generated metadata versions now come from package.json. GitHub Actions, repository permissions and release creation have not been exercised on a remote repository.

## Blank starter checks

The blank starter follow-up passed lint, formatting, typecheck, all 84 tests, build, pack, and the installed-tarball smoke test for both starter choices. Eleven new tests cover selection/defaults, invalid values, all four frameworks individually, and combined workspaces with no auth and Clerk. They check for absent demo files and stale imports while retaining providers and auth configuration.

`CCM_EXAMPLE=none CCM_AUTH=none pnpm test:e2e` and `CCM_EXAMPLE=none CCM_AUTH=clerk pnpm test:e2e` both passed installation, typecheck, lint and build for all four frameworks. Builds included Next, Vite, Start client/server, and Expo iOS/Android Metro exports. The test runner injected exact empty API/table-name assertions, non-any assertions and negative unknown-module assertions into each disposable frontend. Those test files are not included in normal blank generation. Clerk build configuration was synthetic; real sign-in remains untested.

The empty schema and unmodified generated assets came from a successful official `convex dev --once` run. A generated blank workspace then completed its own `pnpm convex:setup` against an anonymous local deployment and linked all four frontend URLs. The interactive starter-content prompt also created a blank Next + Expo project in a PTY.

Fresh technical review independently compiled the empty API/data-model assertions and found a Windows path-separator error in the new file assertions. That error was fixed before the final test run. Windows execution and hosted CI remain untested locally.

## npm publishing preparation

On 2026-09-10, the publishing follow-up passed frozen installation, lint, formatting, typecheck, all 98 tests, build, package smoke tests and `actionlint`. The packed CLI ran through npx and pnpm dlx using the local tarball. The release package validator checked its real manifest and registry status, and `npm publish --dry-run --ignore-scripts --access public` accepted the archive without publishing.

Fresh review checked the release dispatch, provenance commit identity, bootstrap flow, artifact transfer and publishing permissions. It identified a cross-version publishing race; the publish job now serializes npm updates across releases. The repository was created at `adamtrip-solutions/create-convex-monorepo`, with the npm environment restricted to release tags and automated npm publishing disabled pending account/trust setup. Hosted [CI run 34415619159](https://github.com/adamtrip-solutions/create-convex-monorepo/actions/runs/34415619159) passed all jobs on release infrastructure commit `3e1943b`, including Windows and Linux generator checks and every generated-project build. The first hosted run exposed CRLF checkout formatting on Windows; `.gitattributes` now fixes LF endings across platforms. The automatically generated changelog uses release-please formatting and is excluded from Prettier. Actual npm OIDC publication remains untested until account and trusted-publisher setup is complete.

## CI bootstrap publishing

Compared both the local checkout and GitHub workflow of `adamtrip-solutions/convex-cloudflare-email`, whose first npm release workflow succeeded. Its publish step supports `NPM_BOOTSTRAP_TOKEN` for initial package creation. This repository now supports the same token-to-OIDC transition and no longer gates publishing behind `NPM_PUBLISHING_ENABLED`. The token is passed only to the final npm publish step. No secret values were read or transferred from the reference repository, and this package has not been published.

A later Windows run exposed an intermittent cancellation failure: setup rejected on the child's abort error before the process closed, leaving the backend directory locked during cleanup. The regression test reproduced the early return locally. Setup now waits for the child close event before settling, preserving the original error. The corrected test and all 98 repository tests passed, together with typecheck, lint, formatting, build, and package smoke checks. Hosted [CI run 34416758903](https://github.com/adamtrip-solutions/create-convex-monorepo/actions/runs/34416758903) confirmed the fix on Windows and passed every generated-project build.

## First npm publication

GitHub Actions [run 34417030866](https://github.com/adamtrip-solutions/create-convex-monorepo/actions/runs/34417030866) published `create-convex-monorepo@0.2.0` from release commit `406b6dec137ba521a23ebc6d78965f0373e1ba98`. The release ran all 98 tests on Windows and Linux, package smoke checks, and the complete generated-project build matrix before publishing the tested tarball. The registry reports `latest` as `0.2.0` and includes a provenance attestation.

Registry checks ran outside the source checkout:

- `pnpm create convex-monorepo@0.2.0 smoke --apps next,expo --auth clerk --example none --no-install --no-git` generated the blank workspace successfully.
- `npx --yes create-convex-monorepo@0.2.0 --version` returned `0.2.0`, using both the default npm cache and a fresh cache.
- `npx --yes create-convex-monorepo@0.2.0 npx-smoke --apps next,vite,tanstack-start,expo --auth none --no-install --no-git` generated all four apps successfully.

An initial npx invocation from inside this package's own checkout failed to find the executable. The same registry command succeeded from the temporary directory. These post-publication smoke checks skipped generated dependency installation; the release workflow had already tested the generated builds. The bootstrap token authenticated the first publish. Token-free OIDC publishing still needs npm trusted-publisher configuration and verification.

## Trusted publishing verification

GitHub Actions [run 34417938658](https://github.com/adamtrip-solutions/create-convex-monorepo/actions/runs/34417938658) published `create-convex-monorepo@0.2.1` from release commit `72527d37eca8f7bd6ced87440e005253bbaa87bc`. This release removed the bootstrap-token reference from the workflow before publishing, so there was no npm token fallback. All Windows, Linux, and generated-project checks passed, and the registry lists 0.2.1 as latest with provenance.

The repository's `NPM_BOOTSTRAP_TOKEN` secret was deleted after publication succeeded. Repository and npm-environment secret listings then contained no npm secret. Revoking the original token in the npm account remains an account-owner action; check whether another repository still uses it first.

## Workspace management commands

The workspace-command implementation passed frozen installation, formatting, lint, typecheck, all 237 tests, build, pack, installed-package smoke checks, and actionlint. Tests cover all five command routes, interactive choices, strict flags, typed API diagnostics, mocked registry responses, conflicts, cancellation, rollback, CRLF checkouts, port allocation, secret exclusion, and dry runs.

`pnpm test:workspace:e2e` and `CCM_EXAMPLE=none pnpm test:workspace:e2e` both passed. The messages case starts with Next.js, adds Vite, TanStack Start, and Expo, then installs Clerk across all existing apps. The blank case installs Clerk first and then adds the remaining apps. Both sync URLs, install dependencies, run doctor, typecheck, lint, and build all four apps. Builds include Next, Vite, Start client/server, and Expo iOS/Android Metro exports. API contract assertions remain enabled for the messages case, and the blank case receives test-only empty API assertions.

The packed package exposes both binaries. Its smoke test exercises `convex-monorepo` through the installed executable and pnpm dlx, adds an app and Clerk, and syncs one frontend URL. The live npm upgrade check returned the current stable release from the official registry. Doctor also passed from a nested application directory in an installed four-app workspace. A PTY run exercised interactive app, framework, and starter selection with `--dry-run`; the proposed directory was not created.

Independent technical review covered mutation plans and CLI integration. Follow-up checks confirmed fixes for workspace-membership diagnostics and semantic-version build metadata. Integration checks also caught development-port collisions, which now have regression tests. Filesystem conflict detection remains optimistic for unrelated external writers; the lock coordinates CLI invocations. No real Clerk login, stored-data migration, or native Xcode/Gradle build was performed. Hosted CI includes the two command-based build scenarios and Windows unit/package checks.
