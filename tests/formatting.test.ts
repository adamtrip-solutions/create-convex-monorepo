import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  access,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { check } from 'prettier';
import { generateProject } from '../src/generator/index.js';
import { createContext } from '../src/generator/context.js';
import { normalizeOptions } from '../src/generator/options.js';
import {
  formatGeneratedFile,
  formattingOptions,
} from '../src/generator/format.js';
import { loadWorkspace } from '../src/workspace/project.js';
import { planAddApp, planAddAuth } from '../src/workspace/add.js';
import { applyPlan } from '../src/workspace/changes.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'ccm-format-'));
  directories.push(dir);
  return dir;
}

it.each([
  ['none', 'none'],
  ['none', 'messages'],
  ['clerk', 'none'],
  ['clerk', 'messages'],
])(
  'formats every authored file for %s auth and %s content without installing',
  async (auth, example) => {
    const root = await generateProject(
      {
        name: 'formatted',
        apps: 'next,admin:vite,portal:tanstack-start,expo',
        auth,
        example,
        install: false,
        git: false,
      },
      { cwd: await temporary() },
    );
    await expect(access(join(root, 'node_modules'))).rejects.toThrow();
    const config = JSON.parse(
      await readFile(join(root, '.prettierrc.json'), 'utf8'),
    );
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.format).toBe('prettier --write .');
    expect(pkg.scripts['format:check']).toBe('prettier --check .');
    expect(pkg.devDependencies.prettier).toBe('3.8.3');
    for (const entry of await readdir(root, { recursive: true })) {
      const path = entry.split(sep).join('/');
      if (!/\.(?:[cm]?[jt]sx?|json|css|html|md|ya?ml)$/.test(path)) continue;
      const source = await readFile(join(root, path), 'utf8');
      if (path.includes('/_generated/')) {
        const asset = example === 'none' ? 'backend-blank' : 'backend';
        expect(source).toBe(
          await readFile(
            new URL(
              `../assets/${asset}/convex/_generated/${path.split('/').at(-1)}`,
              import.meta.url,
            ),
            'utf8',
          ),
        );
      } else {
        expect(await check(source, { ...config, filepath: path }), path).toBe(
          true,
        );
      }
    }
    const main = await readFile(join(root, 'apps/admin/src/main.tsx'), 'utf8');
    expect(main).toMatch(/render\(\n\s+<StrictMode>/);
    expect(main).not.toContain('<StrictMode><main>');
  },
);

it('does not load project formatter configuration, format secrets or change upstream generated files', async () => {
  const root = await temporary();
  await writeFile(
    join(root, 'prettier.config.mjs'),
    'throw new Error("must not execute config");',
  );
  const ctx = createContext(root, normalizeOptions({ name: 'safe' }));
  await ctx.write(
    'src/main.tsx',
    'export const App=()=> <main><h1>Hello</h1><p>World</p></main>',
  );
  expect(
    await check(await readFile(join(root, 'src/main.tsx'), 'utf8'), {
      ...formattingOptions,
      filepath: 'main.tsx',
    }),
  ).toBe(true);
  for (const path of [
    '.env.local',
    'packages/backend/convex/_generated/api.js',
    'apps/web/src/routeTree.gen.ts',
  ]) {
    const text = 'leave exactly as-is\r\n';
    expect(await formatGeneratedFile(path, text)).toBe(text);
  }
  await expect(ctx.write('src/broken.ts', 'export const =')).rejects.toThrow();
  await expect(access(join(root, 'src/broken.ts'))).rejects.toThrow();
});

// This integration case renders multiple complete projects during auth migration.
it('adds apps and auth to an unformatted v0.3 starter without rewriting existing backend files', async () => {
  const root = await generateProject(
    {
      name: 'legacy',
      apps: 'web:next,dashboard:vite,portal:tanstack-start,mobile:expo',
    },
    { cwd: await temporary() },
  );
  // Captured from the v0.3.0 generator, before formatting was introduced.
  const legacy: Record<string, string> = JSON.parse(
    await readFile(
      new URL('./golden/legacy-unformatted.json', import.meta.url),
      'utf8',
    ),
  );
  for (const [path, source] of Object.entries(legacy))
    await writeFile(join(root, path), source);
  await applyPlan(
    await planAddApp(await loadWorkspace(root), {
      name: 'added',
      framework: 'vite',
    }),
  );
  for (const [path, source] of Object.entries(legacy))
    expect(await readFile(join(root, path), 'utf8')).toBe(source);
  await applyPlan(await planAddAuth(await loadWorkspace(root), 'clerk'));
  for (const app of ['web', 'dashboard', 'portal', 'mobile', 'added']) {
    const path = `apps/${app}/src/providers.tsx`;
    const source = await readFile(join(root, path), 'utf8');
    expect(source).toContain('ConvexProviderWithClerk');
    expect(await check(source, { ...formattingOptions, filepath: path })).toBe(
      true,
    );
  }
  for (const name of ['schema.ts', 'messages.ts']) {
    const path = `packages/backend/convex/${name}`;
    expect(await readFile(join(root, path), 'utf8')).toBe(legacy[path]);
  }
}, 30_000);

it('still rejects substantive edits and comments in previously unformatted auth files', async () => {
  const root = await generateProject(
    { name: 'custom', apps: 'vite', example: 'none' },
    { cwd: await temporary() },
  );
  const path = join(root, 'apps/web/src/auth-controls.tsx');
  const custom =
    'export function AuthControls() { /* keep this */ return null; }\n';
  await writeFile(path, custom);
  await expect(planAddAuth(await loadWorkspace(root), 'clerk')).rejects.toThrow(
    'Conflict',
  );
  expect(await readFile(path, 'utf8')).toBe(custom);
});
