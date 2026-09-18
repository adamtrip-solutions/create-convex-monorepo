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

## Generated formatting and npx management

On 2026-09-11, the formatting and launcher follow-up passed lint, typecheck, formatting, all 282 tests, build, pack, and installed-tarball checks. The formatter matrix covers every framework with both auth and content choices, verifies unchanged official Convex generated assets, and rejects project-config execution. A captured v0.3.0 fixture verifies that unformatted apps still accept app additions and Clerk migration without rewriting existing schema or message functions.

Both command-driven all-four-framework scenarios passed generated formatting checks, doctor with no issues, typecheck, lint, web builds, and Expo iOS/Android Metro exports. One adds Clerk after creating the messages apps; the other adds blank apps after Clerk setup. These checks now exercise the create binary for workspace commands. The packed CLI also runs management through npx from a nested app directory without installing dependencies in the generated workspace.

A manual PTY check displayed all five management actions from an app's src directory and cancelled without applying changes. A fresh read-only review found no material issues and independently passed 101 focused tests. Native device execution and real Clerk login were not repeated for this change.

## SvelteKit

Verified on 2026-09-18 with Node 24.17.0 and pnpm 10.34.5. All required checks passed. No commits or pushes were made.

Repository commands, run from the feature worktree:

```sh
pnpm format
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

The final test run passed 544 unit tests and 7 backend tests. Windows execution was not available locally; the existing Windows CI job runs these unit tests. The generated Svelte files use the same plain TypeScript backend contract as React apps.

The following built-CLI commands ran from `/tmp/ccm-svelte-verification`:

```sh
node /tmp/ccm-wt/sveltekit/dist/cli/index.js create svelte-final --apps sveltekit --auth none --example messages --no-git --install
node /tmp/ccm-wt/sveltekit/dist/cli/index.js create svelte-vite-blank --apps sveltekit,vite --auth none --example none --no-git --install
node /tmp/ccm-wt/sveltekit/dist/cli/index.js create add-svelte --apps vite --auth none --example messages --no-git --install
```

The add-app fixture then ran these commands from its workspace root:

```sh
node /tmp/ccm-wt/sveltekit/dist/cli/index.js add app portal --framework sveltekit --dry-run
node /tmp/ccm-wt/sveltekit/dist/cli/index.js add app portal --framework sveltekit --install
node scripts/convex-setup.mjs --link-only
node /tmp/ccm-wt/sveltekit/dist/cli/index.js doctor --json
```

Before adding the app, this fixture received the pre-feature setup script from Git and had the new Svelte Turbo settings and formatter ignores removed. This exercised an older workspace rather than relying on the updated root template. The root Turbo config remained unchanged by app addition. The dry run listed the setup-script and ignore updates; the applied command linked the new app's `PUBLIC_CONVEX_URL`. Doctor's final report had no issues.

Each fixture received `CONVEX_URL=https://example.convex.cloud` in its backend `.env.local`, then linked frontend URLs with `node scripts/convex-setup.mjs --link-only`. This was test configuration, not a live deployment. In each completed workspace, the following commands passed:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
```

| Combination                           | Install | Typecheck                    | Lint   | Build  | Formatting |
| ------------------------------------- | ------- | ---------------------------- | ------ | ------ | ---------- |
| SvelteKit, messages, none             | Passed  | Passed, zero Svelte warnings | Passed | Passed | Passed     |
| SvelteKit + Vite, blank, none         | Passed  | Passed, zero Svelte warnings | Passed | Passed | Passed     |
| Add SvelteKit to Vite, messages, none | Passed  | Passed, zero Svelte warnings | Passed | Passed | Passed     |

The new CI paths also passed locally, including blank API assertions, shared-package imports, doctor for workspace commands, and browser-bundle checks for backend implementation text:

```sh
CCM_APPS=sveltekit,next CCM_AUTH=none CCM_EXAMPLE=none pnpm test:e2e
CCM_APPS=vite,sveltekit CCM_AUTH=none CCM_EXAMPLE=messages CCM_WORKSPACE_COMMANDS=1 pnpm test:e2e
```

A frontend-only negative check changed the backend mutation's validator to require an additional boolean argument in a disposable fixture, without touching its generated declarations:

```sh
pnpm --filter @svelte-messages/web exec svelte-check --tsconfig ./tsconfig.json
```

It exited 1 as expected, reporting the missing argument in `Messages.svelte` and the argument-type assertion in `convex-api.type-test.ts`. The backend file was restored. The clean standalone fixture then passed its positive checks.

The legacy fixture also ran:

```sh
PUBLIC_CONVEX_URL=https://shell.convex.cloud pnpm exec turbo run build --filter=@add-svelte/portal --dry=json
```

The resolved task included the public URL hash and `.svelte-kit/**` and `build/**` outputs. Production preview returned HTTP 200 with the messages heading, loading state, and form:

```sh
pnpm --filter @svelte-final/web preview --host 127.0.0.1 --port 4178
curl --fail --silent http://127.0.0.1:4178/
```

The preview was stopped after the check. Adapter-auto completed the builds and reported that the local environment had no detected hosting adapter. No deployment was attempted. Live query and mutation execution was skipped because no live Convex deployment was configured. No required verification was blocked.

Failures found and resolved during implementation:

- The first `pnpm build` rejected the Svelte formatter plugin's published TypeScript declarations. Resolving the installed plugin path explicitly fixed it.
- The first generated `pnpm format:check` could not resolve a plugin named in an app-local JSON config from the workspace root. The app now resolves its plugin from `prettier.config.js`.
- The first add-app doctor and workspace E2E run reported TS2688. Supplying the app's tsconfig filename to the in-memory compiler fixed explicit app-local type-package resolution; a regression test covers it.
- Focused tests initially ran before the Svelte template existed, and formatter tests initially omitted the Svelte parser. Both were corrected. A direct `pnpm exec tsc --noEmit` ran before generated backend fixtures existed; the required `pnpm typecheck` creates those fixtures and passed.
- Two legacy-script tests initially used the macOS temporary-directory alias and missed the setup script's existing direct-execution guard. Passing the script's real path fixed the tests. A manually rewritten fixture Turbo JSON needed formatting before its final format check.

Independent technical review found the older-workspace setup, Turbo, and formatter compatibility gap. The implementation and tests were extended, and focused re-review found no remaining material issue. Fable was unavailable, so no independent UI design review was performed; the starter keeps the existing messages and blank content without a visual redesign.

## Astro framework checks

Executed 2026-09-18 on macOS with Node 24.17.0 and pnpm 10.34.5. All five Astro acceptance criteria passed local checks. Windows and hosted GitHub Actions remain CI checks. No commit or push was made.

Repository commands passed:

```sh
pnpm format
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

`pnpm test` passed 552 unit tests and 7 backend tests. The independent reviewer ran `pnpm exec tsc -p tsconfig.build.json --noEmit` successfully. Review found older-workspace URL linking and Turbo environment gaps; guarded migrations fixed both, and focused re-review found no unresolved material defects.

The built CLI generated these projects in a fresh temporary directory. Every command installed dependencies successfully:

```sh
node /tmp/ccm-wt/astro/dist/cli/index.js create astro-none --apps astro --auth none --example messages --no-git --install
node /tmp/ccm-wt/astro/dist/cli/index.js create astro-clerk --apps astro,expo --auth clerk --example messages --no-git --install
node /tmp/ccm-wt/astro/dist/cli/index.js create astro-auth --apps astro,next --auth convex-auth --example none --no-git --install
node /tmp/ccm-wt/astro/dist/cli/index.js create astro-added --apps vite --auth none --example messages --no-git --install
node /tmp/ccm-wt/astro/dist/cli/index.js create astro-none-blank --apps astro --auth none --example none --no-git --install
node /tmp/ccm-wt/astro/dist/cli/index.js create astro-clerk-blank --apps astro --auth clerk --example none --no-git --install
node /tmp/ccm-wt/astro/dist/cli/index.js create astro-auth-messages --apps astro --auth convex-auth --example messages --no-git --install
```

Within every project, `pnpm typecheck` and `pnpm lint` passed. Production builds passed with these exact commands:

| Project                                           | Build command                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| astro-none, astro-none-blank, astro-auth-messages | `PUBLIC_CONVEX_URL=https://example.convex.cloud pnpm build`                                                                                                                                                                                                                               |
| astro-clerk                                       | `CI=1 EXPO_NO_TELEMETRY=1 PUBLIC_CONVEX_URL=https://example.convex.cloud PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk EXPO_PUBLIC_CONVEX_URL=https://example.convex.cloud EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk pnpm build` |
| astro-auth                                        | `NEXT_TELEMETRY_DISABLED=1 PUBLIC_CONVEX_URL=https://example.convex.cloud NEXT_PUBLIC_CONVEX_URL=https://example.convex.cloud pnpm build`                                                                                                                                                 |
| astro-clerk-blank                                 | `PUBLIC_CONVEX_URL=https://example.convex.cloud PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_dGVzdC5jbGVyay5hY2NvdW50cy5kZXYk pnpm build`                                                                                                                                                         |
| astro-added                                       | `pnpm build`                                                                                                                                                                                                                                                                              |

The Clerk build includes Expo iOS and Android JavaScript exports. Its dependency graph emitted the existing optional native accelerator and TypeScript peer warnings; installation and checks passed. Convex Auth dependencies emitted upstream deprecation warnings.

Before adding Astro to `astro-added`, the fixture removed Astro support from its copied setup helper, Turbo settings, and ignore files to reproduce an older workspace. Its Vite entry point was customized, and its backend `.env.local` received a synthetic public URL. These commands then passed from that workspace:

```sh
node /tmp/ccm-wt/astro/dist/cli/index.js add app island --framework astro --dry-run
node /tmp/ccm-wt/astro/dist/cli/index.js add app island --framework astro --install
pnpm convex:link
pnpm typecheck
pnpm lint
pnpm build
node /tmp/ccm-wt/astro/dist/cli/index.js doctor --json
```

Doctor returned no issues. Unit tests separately check dry-run preservation, inherited auth for both starters, customized-source preservation, conflict rejection, and URL linking.

Both E2E commands passed installation, formatting, typecheck, lint, build, and client bundle checks. The workspace case also passed doctor; the blank case includes temporary API assertions:

```sh
CCM_APPS=vite,astro CCM_AUTH=none CCM_WORKSPACE_COMMANDS=1 pnpm test:e2e
CCM_APPS=astro,next CCM_AUTH=convex-auth CCM_EXAMPLE=none pnpm test:e2e
```

A negative probe temporarily added an invalid `FunctionArgs<typeof api.messages.send>` assignment in the Astro app. App-local `pnpm typecheck` failed with TS2322 as expected. Temporarily removing the backend `api.d.ts` also made that command fail. Both files were restored. Output scans found the static client-only island in all seven fixtures and no backend validation text, owner-index name, or synthetic server-secret marker in Astro's client JavaScript.

Initial failures were resolved:

- The upstream prototype's first `pnpm install` selected pnpm 11 outside the repository and rejected unapproved esbuild scripts. A subsequent install refused to replace that modules directory without a terminal. Pinning pnpm 10.34.5, allowing esbuild in the temporary workspace, and running `CI=1 pnpm --dir /tmp/ccm-astro-upstream-sUwG8o install --no-frozen-lockfile` passed. Its `pnpm --dir /tmp/ccm-astro-upstream-sUwG8o check` and static `build` then passed with the official Clerk integration.
- `pnpm exec vitest run tests/generator.test.ts tests/core.test.ts tests/blank.test.ts tests/setup.test.ts tests/workspace-core.test.ts tests/workspace-add.test.ts` initially passed 313 tests and failed one port assertion that assumed every non-Next web app had Vite config. Updating it to inspect Astro's `--port` script resolved the failure.
- The reviewer's initial `pnpm exec tsc --noEmit` failed on missing `tests/.generated` fixture imports. The required `pnpm typecheck` generates those fixtures and passed.

Live Clerk sessions, Convex Auth sign-in, and query/mutation execution against a deployed backend were not tested in this task. Build keys and URLs were synthetic. No production deployment or native binary build was attempted. The runtime identifies GPT-6; it does not separately attest the Astra variant requested for independent review.
