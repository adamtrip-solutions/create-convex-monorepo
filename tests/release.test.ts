import { describe, expect, it } from 'vitest';
import {
  validateReleaseManifest,
  matchesPublishedPackage,
} from '../scripts/release-package.mjs';
const repository = 'adamtrip-solutions/create-convex-monorepo';
const manifest = {
  name: 'create-convex-monorepo',
  version: '0.2.0',
  repository: { type: 'git', url: `git+https://github.com/${repository}.git` },
  publishConfig: { access: 'public' },
  bin: { 'create-convex-monorepo': 'dist/cli/index.js' },
};
describe('release package validation', () => {
  it('selects only the archive matching the stable release', () => {
    expect(validateReleaseManifest(manifest, 'v0.2.0', repository)).toBe(
      'create-convex-monorepo-0.2.0.tgz',
    );
  });
  it.each([
    'main',
    'v0.2.0-beta.1',
    'v01.2.0',
    'v0.2.0;echo bad',
    '../archive',
  ])('rejects unsafe or unstable tag %s', (tag) => {
    expect(() => validateReleaseManifest(manifest, tag, repository)).toThrow(
      'stable',
    );
  });
  it.each([
    { name: 'another-package' },
    { version: '0.1.0' },
    { repository: { url: 'git+https://github.com/someone/fork.git' } },
    { private: true },
    { publishConfig: { access: 'restricted' } },
    { bin: {} },
  ])('rejects mismatched release metadata %j', (patch) => {
    expect(() =>
      validateReleaseManifest({ ...manifest, ...patch }, 'v0.2.0', repository),
    ).toThrow();
  });
  it('rejects missing repository configuration', () => {
    expect(() => validateReleaseManifest(manifest, 'v0.2.0', '')).toThrow(
      'Missing GitHub',
    );
  });
  it('permits a retry only when npm already has identical archive contents', () => {
    expect(
      matchesPublishedPackage(
        { dist: { integrity: 'sha512-same' } },
        'sha512-same',
      ),
    ).toBe(true);
    expect(() =>
      matchesPublishedPackage(
        { dist: { integrity: 'sha512-other' } },
        'sha512-same',
      ),
    ).toThrow('different contents');
    expect(() => matchesPublishedPackage({}, 'sha512-same')).toThrow();
  });
});
