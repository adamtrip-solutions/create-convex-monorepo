# Contributing

Use Node.js 22.12 or newer and the pnpm version pinned in `package.json`.

```sh
pnpm install
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
```

`pnpm dev` runs the source CLI from this checkout:

```sh
pnpm dev fixture --apps web:next,mobile:expo --no-install --no-git
```

To check the package exactly as users receive it:

```sh
pnpm pack
pnpm test:package
```

The package smoke test installs the tarball in a temporary directory and exercises its binary, exports, starter assets and URL linker. Registry commands such as `pnpm create convex-monorepo` use the published package, not your checkout.

Install and check the generated project when changing templates. `pnpm test:e2e` runs the repository's generated-project checks; inspect its script and CI configuration for the current matrix. `pnpm test:backend` runs backend behavior tests. These commands can need network access and more time than unit tests. A template snapshot does not prove that its framework builds.

## Scope a change

Describe the failing behavior, the generated combination involved, and the expected result. Preserve unrelated changes. Keep framework-specific work in its template and provider-specific work in its auth adapter. Read [architecture](docs/architecture.md), [adding a framework](docs/adding-a-framework.md), or [adding auth](docs/adding-an-auth-provider.md) before changing those contracts.

Check current upstream documentation before changing Convex generation, exports, bundler resolution, or SDK versions. Record compatibility findings in `docs/research.md`. Do not edit Convex-generated internals, cast away shared API types, or suppress errors to pass a build. Refresh official generated assets through supported Convex tooling when the example backend changes.

## Tests and pull requests

Add focused regression tests for the behavior being fixed. Run generated-app typechecks and builds for affected frameworks and auth choices. For Expo, include Metro export evidence. Report exact checks run, failures, skipped checks, and whether real backend/auth interaction was exercised. Never include deployment keys or personal environment files in fixtures or logs.

Run `pnpm format` before the final checks. A pull request should state the concrete behavior change, compatibility impact, and verification. Keep snapshots small enough that reviewers can identify meaningful changes.

## Releases

Use Conventional Commits for commits and PR titles. For example, `feat(cli): initialize Convex after generation`, `fix(expo): resolve shared backend imports`, or `docs: clarify deployment setup`. The PR title check runs on each pull request. Maintainers squash merge with that title so release-please can read the resulting commit.

Use `fix:` for a patch, `feat:` for a minor, and `!` for a breaking change, such as `feat(cli)!: change application selection flags`. Explain breaking changes and migration steps in the PR body. These rules also apply before v1.0, so a breaking change from 0.1.0 proposes 1.0.0. `perf:` also triggers a patch; other ordinary maintenance commits do not trigger a release alone.

Release-please maintains a PR with the next version and changelog. Do not add changeset files or manually bump versions for normal changes. Maintainers review and merge the release PR to create a GitHub release, which starts the npm publishing workflow. It verifies the release commit and publishes the tested tarball once trusted publishing is enabled. See [release setup and publishing](docs/releases.md).

## Reporting problems

Use the issue templates for reproducible bugs and concrete feature requests. Include framework/auth choices, operating system, Node and pnpm versions, and the first useful error. Remove credentials and deployment secrets. Do not post vulnerabilities with exploitable private details in public issues; contact the repository maintainers privately through their published contact information.

Set `CCM_EXAMPLE=none` when running `pnpm test:e2e` to check blank starters. The default is `messages`. New framework and auth combinations must support both choices or reject unsupported options explicitly.
