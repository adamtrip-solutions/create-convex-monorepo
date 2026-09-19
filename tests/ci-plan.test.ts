import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { planCi } from '../scripts/ci-plan.mjs';

type Entry = Record<string, string | boolean>;
const matrix = JSON.parse(
  await readFile('.github/ci-matrix.json', 'utf8'),
) as Entry[];
const both = ['ubuntu-latest', 'windows-latest'];
const releaseBranch =
  'release-please--branches--main--components--create-convex-monorepo';
const trigger = { eventName: 'pull_request', headRef: '', releaseRef: '' };

const frameworks = (entries: Entry[]) =>
  new Set(
    entries.flatMap((entry) =>
      String(entry.apps)
        .split(',')
        .map((app) => app.split(':').at(-1)),
    ),
  );
const values = (entries: Entry[], field: string, fallback: string) =>
  new Set(entries.map((entry) => String(entry[field] ?? fallback)));

describe('CI plan', () => {
  it('runs the smoke subset on a feature pull request', () => {
    const plan = planCi({ ...trigger, headRef: 'feat/nuxt' }, matrix);
    expect(plan.os).toEqual(both);
    expect(plan.projects).toHaveLength(10);
    expect(plan.projects.every((entry) => !('smoke' in entry))).toBe(true);
  });
  it('runs every generated project on the release pull request', () => {
    const plan = planCi({ ...trigger, headRef: releaseBranch }, matrix);
    expect(plan.os).toEqual(both);
    expect(plan.projects).toHaveLength(matrix.length);
  });
  it('runs every generated project on a manual dispatch', () => {
    const plan = planCi({ ...trigger, eventName: 'workflow_dispatch' }, matrix);
    expect(plan.os).toEqual(both);
    expect(plan.projects).toHaveLength(matrix.length);
  });
  it('only reruns the Linux generator checks on main', () => {
    const plan = planCi({ ...trigger, eventName: 'push' }, matrix);
    expect(plan).toEqual({ os: ['ubuntu-latest'], projects: [] });
  });
  it('builds the release tarball without generated projects', () => {
    // The publish workflow calls CI from a workflow_dispatch event.
    const plan = planCi(
      { eventName: 'workflow_dispatch', headRef: '', releaseRef: 'abc123' },
      matrix,
    );
    expect(plan).toEqual({ os: both, projects: [] });
  });
  it('rejects a matrix that would leave pull requests without smoke checks', () => {
    expect(() => planCi(trigger, [])).toThrow();
    expect(() => planCi(trigger, [{ apps: 'vite', auth: 'none' }])).toThrow();
  });
});

describe('CI smoke subset', () => {
  const smoke = matrix.filter((entry) => entry.smoke === true);
  it('covers every framework, auth provider and package manager', () => {
    expect(frameworks(smoke)).toEqual(frameworks(matrix));
    expect(values(smoke, 'auth', '')).toEqual(values(matrix, 'auth', ''));
    expect(values(smoke, 'packageManager', 'pnpm')).toEqual(
      values(matrix, 'packageManager', 'pnpm'),
    );
  });
  it('covers OAuth, blank examples and workspace commands', () => {
    expect(smoke.some((entry) => entry.oauth)).toBe(true);
    expect(smoke.some((entry) => entry.example === 'none')).toBe(true);
    expect(smoke.some((entry) => entry.workspaceCommands === '1')).toBe(true);
  });
});
