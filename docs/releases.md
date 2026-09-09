# Releases

This repository uses Conventional Commits and release-please for versions, changelogs, release PRs, and GitHub releases. npm publication remains a separate maintainer action.

## Version policy

| Commit                                  | Bump from 0.1.0  |
| --------------------------------------- | ---------------- |
| `fix(cli): handle cancellation`         | 0.1.1            |
| `perf: reduce template reads`           | 0.1.1            |
| `feat(cli): initialize Convex`          | 0.2.0            |
| `feat(cli)!: replace application flags` | 1.0.0            |
| `docs: update setup instructions`       | No release alone |
| `chore: update tooling`                 | No release alone |

A `BREAKING CHANGE:` commit footer also requests a major bump. Explain migration steps when using it. The two pre-major downgrade options are explicitly disabled, so breaking changes still request a major before 1.0. For several commits, the largest requested bump wins. This follows the [release-please versioning strategy](https://github.com/googleapis/release-please/blob/main/src/versioning-strategies/default.ts).

The manifest records 0.1.0 as the existing baseline. `bootstrap-sha` points to the last committed v0.1 work, `0373d22b000dc9cba036a1d2f1cff689b217fd8b`, so initial history is not replayed as new features. This does not publish 0.1.0 or create a historical release. After the first automated release, release-please uses release history. See its [manifest documentation](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md).

## Set up the GitHub repository

1. Use `main` as the release branch. Enable Actions and allow GitHub Actions to create pull requests under Settings > Actions > General.
2. Enable squash merging. Set the default squash commit message to the PR title and description. Require the `Conventional PR title` check and existing CI jobs in branch protection. Disable other merge methods if every merged commit should follow this policy. Direct pushes still need Conventional Commit messages.
3. Add an Actions secret named `RELEASE_PLEASE_TOKEN` containing a repository-scoped automation token with write access to contents, issues, and pull requests. Restrict it to this repository and manage its expiry. A maintained GitHub App token workflow is another option if the project later needs one.

The release workflow falls back to `GITHUB_TOKEN` without that secret. It can create release PRs, but GitHub suppresses the follow-on workflow events created with this token, so the PR's CI checks will not run automatically. Configure the automation token before relying on required checks for release PRs. Do not bypass those checks to merge an untested release. The action documents this [token limitation and required permissions](https://github.com/googleapis/release-please-action#github-credentials).

Repository settings and secrets must be configured by a maintainer. Committing these files does not configure them.

## Release a version

Merge regular PRs with their Conventional Commit titles. Each push to `main` lets release-please update its release PR. Review its version, changelog, and passing CI before merging. The next workflow run creates a `vX.Y.Z` tag and GitHub release. Nothing in this workflow publishes to npm.

From a clean checkout of that release tag, run:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm pack
node scripts/pack-smoke.mjs
```

Run generated-project checks for the affected framework combinations as documented in [CONTRIBUTING.md](../CONTRIBUTING.md). Inspect the tarball contents and confirm the package name and version. A maintainer with npm access can then publish the exact checked tarball with `npm publish ./create-convex-monorepo-X.Y.Z.tgz --access public`, replacing `X.Y.Z` with the release version. npm authentication and package-name availability must be settled before the first publication.

Normal changes do not need manual version edits. If a release PR appears stuck, check the workflow logs, token permissions, and the PR's `autorelease` labels before changing configuration. Keep the release PR's generated title and body intact.
