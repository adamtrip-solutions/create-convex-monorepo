# Releases

This repository uses Conventional Commits and release-please for versions, changelogs, release PRs, and GitHub releases. GitHub Actions tests and publishes the release tarball to npm through trusted publishing. The first publication needs account setup.

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

## GitHub configuration

The public repository is `adamtrip-solutions/create-convex-monorepo`. The package's repository URL must match it for npm provenance.

- Use `main` as the release branch. Enable Actions and allow GitHub Actions to create pull requests.
- Enable squash merging with the PR title as the commit title. Require the Conventional PR title check and `CI passed` before merging.
- Create a GitHub environment named `npm`. Restrict deployments to tags matching `v*`. Protect release tags against updates and deletion.
- Keep the repository variable `NPM_PUBLISHING_ENABLED` unset or `false` until the first package publication and npm trust configuration are complete.

The release workflow uses `GITHUB_TOKEN` by default. GitHub may require approval before running CI on a bot-created release PR. An optional `RELEASE_PLEASE_TOKEN` with repository contents, issues and pull-request write permissions can avoid that interruption. The npm dispatch step always uses `GITHUB_TOKEN` with `actions: write`; it does not require Actions permission on the optional token. [GitHub token event rules](https://docs.github.com/en/actions/concepts/security/github_token).

## First npm publication

1. Create an account on [npmjs.com](https://www.npmjs.com/signup), verify your email, and enable two-factor authentication. The package is unscoped, so an npm organization is not needed for the `create-convex-monorepo` name.
2. Merge the first release-please PR after its CI passes. The release workflow creates the version tag and dispatches **Publish npm package** at that tag. With publishing disabled, it still runs the complete test matrix and saves the tested `npm-package` artifact.
3. Download that artifact from the successful publishing workflow run. It contains `create-convex-monorepo-X.Y.Z.tgz`. Authenticate locally and publish that exact archive, replacing `X.Y.Z` with the release version:

   ```sh
   npm login
   npm publish ./create-convex-monorepo-X.Y.Z.tgz --access public --ignore-scripts
   ```

   Complete npm's authentication prompts in your own terminal. Do not paste passwords, tokens or 2FA codes into issues or chat. This initial local publication creates the package and does not have GitHub provenance.

4. Open the package settings on npm and add a GitHub Actions trusted publisher with these exact values:

   | Field             | Value                                                   |
   | ----------------- | ------------------------------------------------------- |
   | Organization/user | `adamtrip-solutions`                                    |
   | Repository        | `create-convex-monorepo`                                |
   | Workflow filename | `publish.yml`                                           |
   | Environment       | `npm`                                                   |
   | Allowed action    | Enable direct `npm publish`, not only staged publishing |

5. Set the GitHub repository variable `NPM_PUBLISHING_ENABLED` to `true`. Subsequent releases publish automatically using OIDC, without an npm token stored in GitHub.

Current npm documentation requires a package to exist before configuring trust. Use the real tested release for this first publish; no placeholder package is needed. [Account setup](https://docs.npmjs.com/creating-a-new-npm-user-account/), [trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites), [trusted publisher configuration](https://docs.npmjs.com/trusted-publishers/).

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

Normal changes do not need manual version edits. If the release PR stalls, inspect the workflow logs, token permissions and `autorelease` labels. Keep release-please's generated title and body intact. After the first successful npm publication, remove the prepublication notice in README.md.
