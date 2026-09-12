import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeOptions,
  validateProjectName,
} from '../src/generator/options.js';
import { createContext, mergeManifests } from '../src/generator/context.js';
import { generateProject, selectTemplate } from '../src/generator/index.js';
import { parseCommand } from '../src/commands/create.js';
import { pnpm } from '../src/package-manager/index.js';
import * as packageManager from '../src/package-manager/index.js';

const temporary: string[] = [];
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'ccm-core-'));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('options', () => {
  it.each([
    '../oops',
    '.',
    'foo/bar',
    'foo\\bar',
    '@scope/name',
    'CON',
    'con',
    'node_modules',
    '-name',
    'UPPER',
    'a.b',
    '',
  ])('rejects unsafe project name %s', (name) =>
    expect(validateProjectName(name)).toBeTypeOf('string'),
  );
  it('normalizes defaults and explicit booleans', () => {
    expect(normalizeOptions({})).toMatchObject({
      name: 'my-app',
      apps: [{ name: 'web', framework: 'next' }],
      install: false,
      git: false,
    });
    expect(normalizeOptions({ yes: true, install: false })).toMatchObject({
      install: false,
      git: true,
    });
  });
  it('supports multiple named applications of the same framework', () =>
    expect(
      normalizeOptions({
        apps: 'app:next,dashboard:next,mobile:expo',
      }).apps.map((app) => app.name),
    ).toEqual(['app', 'dashboard', 'mobile']));
  it('assigns distinct defaults', () =>
    expect(
      normalizeOptions({ apps: 'next,vite,expo,expo' }).apps.map(
        (app) => app.name,
      ),
    ).toEqual(['web', 'admin', 'mobile', 'mobile-2']));
  it.each([
    { apps: 'next,' },
    { apps: 'x:next,x:vite' },
    { apps: 'astro' },
    { apps: 'backend:next' },
    { apps: 'eslint-config:vite' },
    { apps: [] },
    { auth: 'custom' },
    { packageManager: 'npm' },
  ])('rejects invalid choices %j', (raw) =>
    expect(() => normalizeOptions(raw)).toThrow(),
  );
  it.each(['none', 'clerk', 'convex-auth'])(
    'accepts %s auth through CLI options',
    (auth) => {
      expect(normalizeOptions(parseCommand(['--auth', auth]).raw).auth).toBe(
        auth,
      );
    },
  );
  it('selects framework adapters', () =>
    expect(selectTemplate('next').id).toBe('next'));
  it('parses flag negation', () =>
    expect(
      parseCommand(['hello', '--yes', '--no-install', '--apps', 'next,expo'])
        .raw,
    ).toEqual({ name: 'hello', yes: true, install: false, apps: 'next,expo' }));
  it.each([['--install', '--no-install'], ['one', 'two'], ['--unknown']])(
    'rejects contradictory or unknown CLI arguments %j',
    (...args) => expect(() => parseCommand(args)).toThrow(),
  );
});
describe('context', () => {
  it('merges scripts and dependencies without discarding existing entries', () =>
    expect(
      mergeManifests(
        { name: 'test', dependencies: { a: '1' }, scripts: { dev: 'a' } },
        { dependencies: { b: '2' }, scripts: { build: 'b' } },
      ),
    ).toMatchObject({
      dependencies: { a: '1', b: '2' },
      scripts: { dev: 'a', build: 'b' },
    }));
  it('rejects conflicting dependencies', () =>
    expect(() =>
      mergeManifests(
        { name: 'test', dependencies: { a: '1' } },
        { dependencies: { a: '2' } },
      ),
    ).toThrow('Conflicting'));
  it('rejects traversal, symlinks, and collisions', async () => {
    const root = await temp();
    const ctx = createContext(root, normalizeOptions({}));
    await expect(ctx.write('../escape', '')).rejects.toThrow('Unsafe');
    await expect(ctx.write('/tmp/escape', '')).rejects.toThrow('Unsafe');
    await ctx.write('file', 'first');
    await expect(ctx.write('file', 'second')).rejects.toThrow('collision');
    await symlink(await temp(), join(root, 'link'), 'junction');
    await expect(ctx.write('link/file', '')).rejects.toThrow('symlink');
    expect(await readFile(join(root, 'file'), 'utf8')).toBe('first');
  });
  it('patches generated manifests', async () => {
    const ctx = createContext(await temp(), normalizeOptions({}));
    await ctx.json('package.json', {
      name: 'example',
      dependencies: { a: '1' },
    });
    await ctx.mergePackage('package.json', { dependencies: { b: '2' } });
    expect(
      JSON.parse(await readFile(join(ctx.root, 'package.json'), 'utf8'))
        .dependencies,
    ).toEqual({ a: '1', b: '2' });
  });
});
describe('generation safety', () => {
  it('refuses nonempty directories without modifying files', async () => {
    const cwd = await temp();
    await mkdir(join(cwd, 'existing'));
    await writeFile(join(cwd, 'existing', 'keep'), 'safe');
    await expect(
      generateProject({ name: 'existing' }, { cwd }),
    ).rejects.toThrow('overwrite');
    expect(await readFile(join(cwd, 'existing', 'keep'), 'utf8')).toBe('safe');
  });
  it('refuses symlink destinations', async () => {
    const cwd = await temp();
    await symlink(await temp(), join(cwd, 'linked'), 'junction');
    await expect(generateProject({ name: 'linked' }, { cwd })).rejects.toThrow(
      'overwrite',
    );
  });
  it('keeps existing empty destination and removes staging on template failure', async () => {
    const cwd = await temp();
    await mkdir(join(cwd, 'empty'));
    vi.spyOn(selectTemplate('next'), 'generate').mockRejectedValueOnce(
      new Error('template failed'),
    );
    await expect(generateProject({ name: 'empty' }, { cwd })).rejects.toThrow(
      'template failed',
    );
    expect(await readdir(join(cwd, 'empty'))).toEqual([]);
    expect(await readdir(cwd)).toEqual(['empty']);
  });
  it('preserves generated files when installation fails', async () => {
    const cwd = await temp();
    vi.spyOn(pnpm, 'install').mockRejectedValueOnce(new Error('offline'));
    await expect(
      generateProject({ name: 'ready', install: true }, { cwd }),
    ).rejects.toThrow('Project files are ready');
    expect(
      JSON.parse(await readFile(join(cwd, 'ready', 'package.json'), 'utf8'))
        .name,
    ).toBe('ready');
  });
});

describe('workspace output', () => {
  it('generates a workspace into an existing empty directory', async () => {
    const cwd = await temp();
    await mkdir(join(cwd, 'workspace'));
    const target = await generateProject(
      { name: 'workspace', apps: 'web:next,admin:vite' },
      { cwd },
    );
    expect(target).toBe(join(cwd, 'workspace'));
    const manifest = JSON.parse(
      await readFile(join(target, 'package.json'), 'utf8'),
    );
    expect(manifest).toMatchObject({ name: 'workspace', private: true });
    expect(manifest.scripts).toHaveProperty('dev');
    expect(
      await readFile(join(target, 'pnpm-workspace.yaml'), 'utf8'),
    ).toContain('apps/*');
    for (const name of ['web', 'admin']) {
      const app = JSON.parse(
        await readFile(join(target, 'apps', name, 'package.json'), 'utf8'),
      );
      expect(app.dependencies['@workspace/backend']).toBe('workspace:*');
    }
    expect(await readdir(cwd)).toEqual(['workspace']);
  });
  it('cleans staging after a failure without creating a destination', async () => {
    const cwd = await temp();
    vi.spyOn(selectTemplate('next'), 'generate').mockRejectedValueOnce(
      new Error('template failed'),
    );
    await expect(generateProject({ name: 'new-app' }, { cwd })).rejects.toThrow(
      'template failed',
    );
    expect(await readdir(cwd)).toEqual([]);
  });
});

describe('setup recovery and cancellation', () => {
  it('preserves generated files and identifies git recovery after a git failure', async () => {
    const cwd = await temp();
    vi.spyOn(pnpm, 'install').mockResolvedValueOnce();
    vi.spyOn(packageManager, 'runCommand').mockRejectedValueOnce(
      new Error('git unavailable'),
    );
    await expect(
      generateProject(
        { name: 'git-failed', install: true, git: true },
        { cwd },
      ),
    ).rejects.toThrow('Run git init');
    expect(
      await readFile(join(cwd, 'git-failed', 'package.json'), 'utf8'),
    ).toContain('git-failed');
  });
  it('cleans staging when aborted during generation and preserves an empty target', async () => {
    const cwd = await temp();
    await mkdir(join(cwd, 'cancelled'));
    const controller = new AbortController();
    await expect(
      generateProject(
        { name: 'cancelled' },
        {
          cwd,
          signal: controller.signal,
          onProgress() {
            controller.abort(new Error('cancelled'));
          },
        },
      ),
    ).rejects.toThrow('cancelled');
    expect(await readdir(cwd)).toEqual(['cancelled']);
    expect(await readdir(join(cwd, 'cancelled'))).toEqual([]);
  });
  it('refuses a destination populated while templates are running', async () => {
    const cwd = await temp();
    const target = join(cwd, 'changed');
    await mkdir(target);
    const template = selectTemplate('next');
    const generate = template.generate;
    vi.spyOn(template, 'generate').mockImplementationOnce(
      async (context, app) => {
        await generate(context, app);
        await writeFile(join(target, 'user-file'), 'keep me');
      },
    );
    await expect(generateProject({ name: 'changed' }, { cwd })).rejects.toThrow(
      'Destination changed',
    );
    expect(await readdir(target)).toEqual(['user-file']);
    expect(await readFile(join(target, 'user-file'), 'utf8')).toBe('keep me');
  });
});
