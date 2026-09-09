# Changesets

Run `pnpm changeset` for changes that affect CLI users or generated projects. Choose a semantic version bump and describe the observable behavior.

Maintainers run `pnpm version-packages` to consume pending changesets and update the package version and changelog. Review and test the resulting tarball before publishing. This configuration assumes the default branch is `main`; update `config.json` if the repository uses a different release base.
