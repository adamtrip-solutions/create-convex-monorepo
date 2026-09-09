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

`pnpm dev` runs the source CLI. Run the built binary from a temporary directory to inspect output without nesting generated projects in the checkout:

```sh
node /absolute/path/to/create-convex-monorepo/dist/cli/index.js fixture --apps web:next,mobile:expo --no-install --no-git
```

Install and check the generated project when changing templates. `pnpm test:e2e` runs the repository's generated-project checks; inspect its script and CI configuration for the current matrix. `pnpm test:backend` runs backend behavior tests. These commands can need network access and more time than unit tests. A template snapshot does not prove that its framework builds.

## Scope a change

Describe the failing behavior, the generated combination involved, and the expected result. Preserve unrelated changes. Keep framework-specific work in its template and provider-specific work in its auth adapter. Read [architecture](docs/architecture.md), [adding a framework](docs/adding-a-framework.md), or [adding auth](docs/adding-an-auth-provider.md) before changing those contracts.

Check current upstream documentation before changing Convex generation, exports, bundler resolution, or SDK versions. Record compatibility findings in `docs/research.md`. Do not edit Convex-generated internals, cast away shared API types, or suppress errors to pass a build. Refresh official generated assets through supported Convex tooling when the example backend changes.

## Tests and pull requests

Add focused regression tests for the behavior being fixed. Run generated-app typechecks and builds for affected frameworks and auth choices. For Expo, include Metro export evidence. Report exact checks run, failures, skipped checks, and whether real backend/auth interaction was exercised. Never include deployment keys or personal environment files in fixtures or logs.

Run `pnpm format` before the final checks. A pull request should state the concrete behavior change, compatibility impact, and verification. Keep snapshots small enough that reviewers can identify meaningful changes.

## Releases

Run `pnpm changeset` for a user-visible change and choose the appropriate semantic version bump. Describe the generated behavior users will receive. The package starts at v0.1; document breaking changes explicitly even during pre-1.0 development.

Maintainers run `pnpm version-packages`, review the version and changelog changes, and verify a package tarball with `pnpm pack`. Test the packaged CLI from outside the repository before publishing. Publishing is a separate maintainer action; no generation command publishes packages. Registry usage becomes available only after `create-convex-monorepo` is published with its matching executable.

## Reporting problems

Use the issue templates for reproducible bugs and concrete feature requests. Include framework/auth choices, operating system, Node and pnpm versions, and the first useful error. Remove credentials and deployment secrets. Do not post vulnerabilities with exploitable private details in public issues; contact the repository maintainers privately through their published contact information.
