import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateProject } from '../src/generator/index.js';
import {
  loadWorkspace,
  parseWorkspaceConfig,
  readText,
} from '../src/workspace/project.js';
import { applyPlan, type ChangePlan } from '../src/workspace/changes.js';
import { planEnvSync } from '../src/workspace/env.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ccm-workspace-core-'));
  directories.push(dir);
  const root = await generateProject(
    { name: 'fixture', apps: 'next,vite,tanstack-start,expo', example: 'none' },
    { cwd: dir },
  );
  return loadWorkspace(root);
}
async function contents(root: string) {
  const result: Record<string, string> = {};
  for (const file of await readdir(root, { recursive: true })) {
    if ((await stat(join(root, file))).isFile())
      result[file] = await readFile(join(root, file), 'utf8');
  }
  return result;
}

describe('workspace metadata', () => {
  it('finds the root from an application and preserves extension metadata', async () => {
    const ws = await fixture();
    await writeFile(
      join(ws.root, 'convex-monorepo.json'),
      JSON.stringify({ ...ws.rawConfig, custom: { keep: true } }),
    );
    const loaded = await loadWorkspace(join(ws.root, 'apps/web/src'));
    expect(loaded.root).toBe(ws.root);
    expect(loaded.rawConfig.custom).toEqual({ keep: true });
  });
  it('supports legacy messages metadata and rejects unknown versions and traversal', async () => {
    const ws = await fixture();
    const legacy = { ...ws.rawConfig };
    delete legacy.example;
    expect(parseWorkspaceConfig(legacy).example).toBe('messages');
    expect(() => parseWorkspaceConfig({ ...legacy, version: 2 })).toThrow(
      'version',
    );
    expect(() =>
      parseWorkspaceConfig({
        ...legacy,
        apps: [{ name: '../outside', framework: 'next' }],
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceConfig({
        ...legacy,
        apps: [
          { name: 'web', framework: 'next' },
          { name: 'web', framework: 'vite' },
        ],
      }),
    ).toThrow('Duplicate');
    await expect(readText(ws.root, '../outside')).rejects.toThrow('Unsafe');
    await expect(readText(ws.root, 'apps\\outside')).rejects.toThrow('Unsafe');
  });
  it('loads valid semantic versions with prerelease and build metadata', async () => {
    const ws = await fixture();
    for (const generator of ['1.0.0+build', '1.0.0-beta.1+build.20']) {
      await writeFile(
        join(ws.root, 'convex-monorepo.json'),
        JSON.stringify({ ...ws.rawConfig, generator }),
      );
      expect((await loadWorkspace(ws.root)).config.generator).toBe(generator);
    }
    for (const generator of ['01.0.0', '1.0.0-01', '1.0.0-beta..1', '1.0.0+']) {
      expect(() =>
        parseWorkspaceConfig({ ...ws.rawConfig, generator }),
      ).toThrow();
    }
  });
  it('does not fall through malformed nested metadata to an ancestor', async () => {
    const ws = await fixture();
    await writeFile(
      join(ws.root, 'apps/web/convex-monorepo.json'),
      '{ secret text invalid',
    );
    await expect(loadWorkspace(join(ws.root, 'apps/web'))).rejects.toThrow(
      'Invalid JSON in convex-monorepo.json.',
    );
  });
});

describe('workspace transactions', () => {
  it('dry-run validates but makes no filesystem changes', async () => {
    const ws = await fixture();
    const before = await contents(ws.root);
    await applyPlan(
      {
        root: ws.root,
        changes: [{ path: 'new/file.txt', before: null, after: 'added' }],
        notes: [],
      },
      { dryRun: true },
    );
    expect(await contents(ws.root)).toEqual(before);
  });
  it('rejects a late conflict before modifying any files', async () => {
    const ws = await fixture();
    const plan: ChangePlan = {
      root: ws.root,
      changes: [
        { path: 'new.txt', before: null, after: 'new' },
        { path: 'README.md', before: 'not the original', after: 'replace' },
      ],
      notes: [],
    };
    const before = await contents(ws.root);
    await expect(applyPlan(plan)).rejects.toThrow('File conflict');
    expect(await contents(ws.root)).toEqual(before);
  });
  it('restores files and removes owned directories on cancellation', async () => {
    const ws = await fixture();
    const before = await contents(ws.root);
    const controller = new AbortController();
    const plan: ChangePlan = {
      root: ws.root,
      changes: [
        { path: 'created/deep/file', before: null, after: 'first' },
        {
          path: 'README.md',
          before: await readText(ws.root, 'README.md'),
          after: 'changed',
        },
      ],
      notes: [],
    };
    await expect(
      applyPlan(plan, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow();
    expect(await contents(ws.root)).toEqual(before);
    await expect(stat(join(ws.root, 'created'))).rejects.toThrow();
  });
  it('rolls back edited content and preserves its mode on failure', async () => {
    const ws = await fixture();
    const before = await readText(ws.root, 'README.md');
    const mode = (await stat(join(ws.root, 'README.md'))).mode;
    await expect(
      applyPlan(
        {
          root: ws.root,
          changes: [{ path: 'README.md', before, after: 'changed' }],
          notes: [],
        },
        {
          onProgress: () => {
            throw new Error('failure');
          },
        },
      ),
    ).rejects.toThrow('failure');
    expect(await readText(ws.root, 'README.md')).toBe(before);
    expect((await stat(join(ws.root, 'README.md'))).mode).toBe(mode);
  });
  it('preserves a concurrent user edit during rollback', async () => {
    const ws = await fixture();
    const plan: ChangePlan = {
      root: ws.root,
      changes: [{ path: 'new.txt', before: null, after: 'ours' }],
      notes: [],
    };
    await expect(
      applyPlan(plan, {
        onProgress: async () => {
          await writeFile(join(ws.root, 'new.txt'), 'user edit');
          throw new Error('stop');
        },
      }),
    ).rejects.toThrow('Concurrently changed files were preserved: new.txt');
    expect(await readText(ws.root, 'new.txt')).toBe('user edit');
  });
  it('honors workspace locks and duplicate output protection', async () => {
    const ws = await fixture();
    await writeFile(
      join(ws.root, '.convex-monorepo.lock'),
      'another invocation',
    );
    const change = { path: 'x', before: null, after: 'x' };
    await expect(
      applyPlan({ root: ws.root, changes: [change], notes: [] }),
    ).rejects.toThrow('Another workspace operation');
    expect(await readText(ws.root, '.convex-monorepo.lock')).toBe(
      'another invocation',
    );
    await expect(
      applyPlan({ root: ws.root, changes: [change, change], notes: [] }),
    ).rejects.toThrow('Duplicate');
  });
  it('rejects symlinked parents before writing outside the project', async () => {
    const ws = await fixture();
    const external = await mkdtemp(join(tmpdir(), 'ccm-external-'));
    directories.push(external);
    await symlink(external, join(ws.root, 'linked'), 'junction');
    await expect(
      applyPlan({
        root: ws.root,
        changes: [{ path: 'linked/file', before: null, after: 'wrong' }],
        notes: [],
      }),
    ).rejects.toThrow('symlink');
    expect(await readdir(external)).toEqual([]);
  });
});

describe('environment sync', () => {
  it('links only public URLs for all four frameworks, preserves settings, and is idempotent', async () => {
    const ws = await fixture();
    await writeFile(
      join(ws.root, 'packages/backend/.env'),
      'CONVEX_URL=https://old.convex.cloud\n',
    );
    await writeFile(
      join(ws.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://current.convex.cloud\nCONVEX_DEPLOY_KEY=private-never-print\n',
    );
    await writeFile(
      join(ws.root, 'apps/web/.env.local'),
      '# custom\nOTHER="first\nsecond"\nNEXT_PUBLIC_CONVEX_URL=https://old.convex.cloud\n',
    );
    const before = await contents(ws.root);
    const plan = await planEnvSync(ws);
    await applyPlan(plan, { dryRun: true });
    expect(await contents(ws.root)).toEqual(before);
    await applyPlan(plan);
    for (const app of ws.config.apps) {
      const env = await readText(ws.root, `apps/${app.name}/.env.local`);
      expect(env).toContain('https://current.convex.cloud');
      expect(env).not.toContain('private-never-print');
    }
    expect(await readText(ws.root, 'apps/web/.env.local')).toContain(
      'OTHER="first\nsecond"',
    );
    expect((await planEnvSync(ws)).changes).toEqual([]);
  });
  it('filters apps and reports missing backend configuration without writes', async () => {
    const ws = await fixture();
    await expect(planEnvSync(ws)).rejects.toThrow('CONVEX_URL is missing');
    await writeFile(
      join(ws.root, 'packages/backend/.env.local'),
      'CONVEX_URL=http://localhost:3210\n',
    );
    await expect(planEnvSync(ws, { app: 'absent' })).rejects.toThrow(
      'Unknown application',
    );
    const plan = await planEnvSync(ws, { app: 'mobile' });
    expect(plan.changes.map((change) => change.path)).toEqual([
      'apps/mobile/.env.local',
    ]);
    expect(plan.notes.join(' ')).toContain('Physical phones');
    await applyPlan(plan);
    expect(await readText(ws.root, 'apps/web/.env.local')).toBeNull();
  });
  it('rejects a changed backend URL or metadata between planning and applying', async () => {
    const ws = await fixture();
    await writeFile(
      join(ws.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://original.convex.cloud\n',
    );
    const plan = await planEnvSync(ws);
    await writeFile(
      join(ws.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://changed.convex.cloud\n',
    );
    await expect(applyPlan(plan)).rejects.toThrow('Workspace changed');
    expect(await readText(ws.root, 'apps/web/.env.local')).toBeNull();
  });
  it('preflights a missing app and an unsafe URL before editing any app', async () => {
    const ws = await fixture();
    await writeFile(
      join(ws.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://user:password@example.com\n',
    );
    await expect(planEnvSync(ws)).rejects.toThrow('without credentials');
    await writeFile(
      join(ws.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://valid.convex.cloud\n',
    );
    await rm(join(ws.root, 'apps/mobile/package.json'));
    await expect(planEnvSync(ws)).rejects.toThrow('Missing application');
    expect(await readText(ws.root, 'apps/web/.env.local')).toBeNull();
  });
});
