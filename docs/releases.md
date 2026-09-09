# Releases

This repository uses Conventional Commits and release-please for versions, changelogs, release PRs, and GitHub releases. GitHub Actions tests and publishes the release tarball to npm. The first publication used a bootstrap token. The workflow now uses trusted publishing without a token fallback. This follows the publishing model in [convex-cloudflare-email](https://github.com/adamtrip-solutions/convex-cloudflare-email/blob/main/.github/workflows/release.yml).

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

The initial manifest recorded 0.1.0 as the existing baseline. `bootstrap-sha` points to the last committed v0.1 work, `0373d22b000dc9cba036a1d2f1cff689b217fd8b`, so initial history is not replayed as new features. This does not publish 0.1.0 or create a historical release. After the first automated release, release-please uses release history. See its [manifest documentation](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md).

## GitHub configuration

The public repository is `adamtrip-solutions/create-convex-monorepo`. The package's repository URL must match it for npm provenance.

- Use `main` as the release branch. Enable Actions and allow GitHub Actions to create pull requests.
- Enable squash merging with the PR title as the commit title. Require the Conventional PR title check and `CI passed` before merging.
- Create a GitHub environment named `npm`. Restrict deployments to tags matching `v*`. Protect release tags against updates and deletion.
- Configure npm trusted publishing as described below. No npm secret or publishing-enable variable is required.

The release workflow uses `GITHUB_TOKEN` by default. GitHub may require approval before running CI on a bot-created release PR. An optional `RELEASE_PLEASE_TOKEN` with repository contents, issues and pull-request write permissions can avoid that interruption. The npm dispatch step always uses `GITHUB_TOKEN` with `actions: write`; it does not require Actions permission on the optional token. [GitHub token event rules](https://docs.github.com/en/actions/concepts/security/github_token).

## First npm publication

Version 0.2.0 created the package through GitHub Actions using `NPM_BOOTSTRAP_TOKEN`. The workflow no longer reads that secret. Subsequent releases authenticate through npm trusted publishing.

## Trusted publisher configuration

In the npm package settings, add a GitHub Actions trusted publisher with these exact values:

| Field             | Value                       |
| ----------------- | --------------------------- |
| Organization/user | `adamtrip-solutions`        |
| Repository        | `create-convex-monorepo`    |
| Workflow filename | `publish.yml`               |
| Environment       | `npm`                       |
| Allowed action    | Enable direct `npm publish` |

The workflow requests a short-lived OIDC credential from GitHub. npm verifies the repository, workflow, and environment against this configuration. There is no stored npm token in the publishing step. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Verify the migration with a new release through the workflow. Retrying an already published version skips publication and does not test authentication. After an OIDC publication succeeds, delete the old GitHub bootstrap secret and revoke the corresponding npm token. If that token is shared with another package, migrate that package or replace its credential before revoking it.

## Automated release flow

Merge regular PRs with Conventional Commit titles. Release-please maintains the version/changelog PR. Merging it creates a GitHub release and explicitly dispatches `publish.yml` at its tag. Dispatch works even when the release was created with `GITHUB_TOKEN`.

The publishing workflow rejects branches, prereleases, missing releases, moved tags, and commits outside `main` history. It runs reusable CI against the exact release SHA: lint, formatting, typecheck, unit/generator tests, tarball smoke tests, Windows checks, and the generated-project build matrix. The Linux job uploads the tarball only after its smoke test passes.

A separate job in the `npm` environment downloads that same artifact, validates its package name/version/bin/repository, and publishes it with provenance. It does not rebuild the archive. Publishing is serialized across versions so concurrent releases cannot race to update the latest tag. Node 24 and an OIDC-capable npm CLI are configured explicitly. No PR job receives npm publishing credentials or an OIDC write permission.

The dispatch uses the tag rather than checking out a tag inside a workflow started on `main`. npm provenance reads the workflow event's commit, so both the event and checked-out source must identify the release. [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Retry a failed publication

Fix account, environment or registry configuration, then rerun **Publish npm package** at the same release tag:

```sh
gh workflow run publish.yml --repo adamtrip-solutions/create-convex-monorepo --ref vX.Y.Z
```

Select the tag in the Actions UI when triggering manually. Running from a branch is rejected. If npm already contains that exact tarball, the publish step skips it. A version with different contents fails explicitly; release a new version instead of moving tags or trying to overwrite npm history. If the workflow itself needs a code fix, include it in a new release because retries execute the workflow stored at the original tag.

Normal changes do not need manual version edits. If the release PR stalls, inspect the workflow logs, token permissions and `autorelease` labels. Keep release-please's generated title and body intact.
