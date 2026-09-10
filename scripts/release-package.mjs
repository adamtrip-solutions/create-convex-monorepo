// @ts-check
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} manifest @param {string} tag @param {string} repository */
export function validateReleaseManifest(manifest, tag, repository) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag))
    throw new Error('Expected a stable vX.Y.Z release tag.');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error('Missing GitHub repository.');
  if (
    !record(manifest) ||
    manifest.name !== 'create-convex-monorepo' ||
    manifest.version !== tag.slice(1)
  )
    throw new Error('Package name/version does not match this release.');
  if (
    !record(manifest.repository) ||
    manifest.repository.url !== `git+https://github.com/${repository}.git`
  )
    throw new Error(
      'Package repository must match the publishing GitHub repository.',
    );
  if (
    manifest.private === true ||
    !record(manifest.publishConfig) ||
    manifest.publishConfig.access !== 'public'
  )
    throw new Error('Expected a public npm package.');
  if (
    !record(manifest.bin) ||
    manifest.bin['create-convex-monorepo'] !== 'dist/cli/index.js' ||
    manifest.bin['convex-monorepo'] !== 'dist/cli/workspace.js'
  )
    throw new Error(
      'Missing create-convex-monorepo or convex-monorepo binary.',
    );
  return `create-convex-monorepo-${tag.slice(1)}.tgz`;
}

/** @param {unknown} metadata @param {string} integrity */
export function matchesPublishedPackage(metadata, integrity) {
  if (
    !record(metadata) ||
    !record(metadata.dist) ||
    metadata.dist.integrity !== integrity
  )
    throw new Error(
      'This version already exists on npm with different contents. Do not overwrite or retag it; create a new release.',
    );
  return true;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const tag = process.env.RELEASE_TAG ?? '';
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const source = JSON.parse(await readFile('package.json', 'utf8'));
  const tarball = validateReleaseManifest(source, tag, repository);
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
    }),
  );
  validateReleaseManifest(packed, tag, repository);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(tarball))
    .digest('base64')}`;
  const response = await fetch(
    `https://registry.npmjs.org/create-convex-monorepo/${tag.slice(1)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  let published = false;
  if (response.status === 200)
    published = matchesPublishedPackage(await response.json(), integrity);
  else if (response.status !== 404)
    throw new Error(`npm registry check failed (${response.status}).`);
  if (!process.env.GITHUB_OUTPUT)
    throw new Error('This publication check runs in GitHub Actions.');
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `tarball=${tarball}\npublished=${published}\n`,
  );
  console.log(
    published
      ? 'This exact tarball is already published; skipping.'
      : `Validated ${tarball} for publication.`,
  );
}
