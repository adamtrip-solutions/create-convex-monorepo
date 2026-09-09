# Releases

This repository uses Conventional Commits and release-please for versions, changelogs, release PRs, and GitHub releases. GitHub Actions tests and publishes the release tarball to npm. The first publication uses a bootstrap token; subsequent releases use trusted publishing. This follows the publishing model in [convex-cloudflare-email](https://github.com/adamtrip-solutions/convex-cloudflare-email/blob/main/.github/workflows/release.yml).

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
- Configure `NPM_BOOTSTRAP_TOKEN` in the `npm` environment before the first release, or configure npm trusted publishing if the package already exists. No publishing-enable variable is required.

The release workflow uses `GITHUB_TOKEN` by default. GitHub may require approval before running CI on a bot-created release PR. An optional `RELEASE_PLEASE_TOKEN` with repository contents, issues and pull-request write permissions can avoid that interruption. The npm dispatch step always uses `GITHUB_TOKEN` with `actions: write`; it does not require Actions permission on the optional token. [GitHub token event rules](https://docs.github.com/en/actions/concepts/security/github_token).

## First npm publication

1. Use your existing npm account with a verified email and two-factor authentication. The package is unscoped, so a separate npm organization is not required.
2. Create a short-lived granular npm token with Read and write package permissions that allow creation of `create-convex-monorepo`. Enable Bypass two-factor authentication for this first unattended publish. A token limited to the existing `convex-cloudflare-email` package cannot create this new package.
3. Save it as `NPM_BOOTSTRAP_TOKEN` in this repository's [npm environment](https://github.com/adamtrip-solutions/create-convex-monorepo/settings/environments). Use GitHub's secret UI, or run the following command in your own terminal and paste the token at its hidden prompt:

   ```sh
   gh secret set NPM_BOOTSTRAP_TOKEN --env npm --repo adamtrip-solutions/create-convex-monorepo
   ```

   GitHub secrets are write-only; a stored token in another repository cannot be read back and copied. Do not paste it into chat or commit it.

4. Merge the first release-please PR after CI passes. The release workflow creates the version tag and dispatches **Publish npm package**. It tests the release commit and automatically publishes the verified archive with provenance. There is no local `npm publish` or archive download step.
5. After that first publication succeeds, configure a GitHub Actions trusted publisher in the npm package settings:

   | Field             | Value                                                   |
   | ----------------- | ------------------------------------------------------- |
   | Organization/user | `adamtrip-solutions`                                    |
   | Repository        | `create-convex-monorepo`                                |
   | Workflow filename | `publish.yml`                                           |
   | Environment       | `npm`                                                   |
   | Allowed action    | Enable direct `npm publish`, not only staged publishing |

6. Delete the `NPM_BOOTSTRAP_TOKEN` GitHub secret and revoke that npm token. Subsequent releases use OIDC without a stored npm credential. Once OIDC is configured, npm can require two-factor authentication and disallow token-based publishing.

The bootstrap token is available only to the final publish step, after all validation jobs pass. Current npm documentation requires the package to exist before configuring its trusted publisher; the bootstrap token lets CI create it. [Token setup](https://docs.npmjs.com/creating-and-viewing-access-tokens/), [trusted publisher configuration](https://docs.npmjs.com/trusted-publishers/).

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
