import {
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateProject } from '../src/generator/index.js';
import type { Auth, Example, Framework } from '../src/generator/types.js';
import {
  loadWorkspace,
  parseWorkspaceConfig,
} from '../src/workspace/project.js';
import { formatGeneratedFile } from '../src/generator/format.js';
import { versions } from '../src/templates/versions.js';
import { applyPlan } from '../src/workspace/changes.js';
import {
  planAddApp,
  planAddAuth,
  planAddPackage,
} from '../src/workspace/add.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  example: Example = 'messages',
  auth: Auth = 'none',
  framework: Framework = 'next',
) {
  const cwd = await mkdtemp(join(tmpdir(), 'ccm-add-test-'));
  temporary.push(cwd);
  const root = await generateProject(
    {
      name: 'sample',
      apps: [{ name: 'web', framework }],
      example,
      auth,
      install: false,
      git: false,
    },
    { cwd },
  );
  return loadWorkspace(root);
}
async function snapshot(
  root: string,
  prefix = '',
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
    else result[path] = await readFile(join(root, path), 'utf8');
  }
  return result;
}

const frameworks: Framework[] = ['next', 'vite', 'tanstack-start', 'expo'];
describe.each<Example>(['none', 'messages'])(
  'add app with %s content',
  (example) => {
    describe.each<Auth>(['none', 'clerk', 'convex-auth'])(
      'and %s auth',
      (auth) => {
        it.each(frameworks)(
          'adds %s without modifying the backend or existing app',
          async (framework) => {
            const workspace = await fixture(example, auth);
            const before = await snapshot(workspace.root);
            const plan = await planAddApp(workspace, {
              name: 'added',
              framework,
            });
            expect(await snapshot(workspace.root)).toEqual(before);
            await applyPlan(plan, { dryRun: true });
            expect(await snapshot(workspace.root)).toEqual(before);
            await applyPlan(plan);
            const after = await snapshot(workspace.root);
            for (const [path, contents] of Object.entries(before)) {
              if (!['package.json', 'convex-monorepo.json'].includes(path))
                expect(after[path], path).toBe(contents);
            }
            const pkg = JSON.parse(after['apps/added/package.json']!);
            expect(pkg.name).toBe('@sample/added');
            const root = JSON.parse(after['package.json']!);
            expect(root.scripts['dev:added']).toBe(
              'pnpm --filter @sample/added dev',
            );
            expect(root.scripts.dev).toContain('--concurrency=4');
            expect(after['apps/added/src/auth-controls.tsx']).toContain(
              auth === 'clerk'
                ? '@clerk/'
                : auth === 'convex-auth'
                  ? '@convex-dev/auth/react'
                  : 'return null',
            );
            const reloaded = await loadWorkspace(workspace.root);
            expect(reloaded.config.apps).toHaveLength(2);
            await expect(
              planAddApp(reloaded, { name: 'added', framework }),
            ).rejects.toThrow('already exists');
          },
        );
      },
    );
  },
);

describe.each<Example>(['none', 'messages'])(
  'add auth with %s content',
  (example) => {
    it.each(frameworks)(
      'integrates Clerk into %s and preserves schema and generated types',
      async (framework) => {
        const workspace = await fixture(example, 'none', framework);
        const pkgPath = join(workspace.root, 'apps/web/package.json');
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
        pkg.dependencies['my-custom-library'] = '1.2.3';
        pkg.scripts.custom = 'echo custom';
        await writeFile(pkgPath, JSON.stringify(pkg));
        await writeFile(
          join(workspace.root, 'README.md'),
          '# My documentation\n',
        );
        const before = await snapshot(workspace.root);
        const plan = await planAddAuth(workspace, 'clerk');
        await applyPlan(plan, { dryRun: true });
        expect(await snapshot(workspace.root)).toEqual(before);
        await applyPlan(plan);
        const after = await snapshot(workspace.root);
        for (const path of Object.keys(before).filter(
          (path) =>
            path.includes('/_generated/') ||
            path.endsWith('/schema.ts') ||
            path.endsWith('/messages.ts') ||
            path === 'README.md',
        ))
          expect(after[path], path).toBe(before[path]);
        const updated = JSON.parse(after['apps/web/package.json']!);
        expect(updated.dependencies['my-custom-library']).toBe('1.2.3');
        expect(updated.scripts.custom).toBe('echo custom');
        expect(after['apps/web/src/auth-controls.tsx']).toContain('@clerk/');
        expect(after['CLERK_SETUP.md']).toContain('CLERK_JWT_ISSUER_DOMAIN');
        expect(
          (await planAddAuth(await loadWorkspace(workspace.root), 'clerk'))
            .changes,
        ).toEqual([]);
      },
    );
  },
);

it('tracks per-app blank overrides when auth is added later', async () => {
  let workspace = await fixture();
  await applyPlan(
    await planAddApp(workspace, {
      name: 'blank',
      framework: 'vite',
      example: 'none',
    }),
  );
  workspace = await loadWorkspace(workspace.root);
  expect(workspace.config.apps[1]?.example).toBe('none');
  await applyPlan(await planAddAuth(workspace, 'clerk'));
  const files = await snapshot(workspace.root);
  expect(files['apps/blank/src/messages.tsx']).toBeUndefined();
  expect(files['apps/blank/src/auth-controls.tsx']).toContain('@clerk/react');
});
it('refuses missing or customized messages contracts while allowing blank apps', async () => {
  const workspace = await fixture('none');
  await expect(
    planAddApp(workspace, {
      name: 'messages',
      framework: 'vite',
      example: 'messages',
    }),
  ).rejects.toThrow('Incompatible messages backend');
  const plan = await planAddApp(workspace, {
    name: 'blank',
    framework: 'vite',
  });
  expect(plan.changes.some((file) => file.path.startsWith('apps/blank/'))).toBe(
    true,
  );
});
it.each(['../escape', 'CON', 'backend', 'invalid/name'])(
  'rejects invalid name %s',
  async (name) => {
    const workspace = await fixture();
    await expect(
      planAddApp(workspace, { name, framework: 'vite' }),
    ).rejects.toThrow();
  },
);
it('rejects existing empty app directories and custom dev script collisions', async () => {
  const workspace = await fixture();
  await mkdir(join(workspace.root, 'apps/taken'));
  await expect(
    planAddApp(workspace, { name: 'taken', framework: 'vite' }),
  ).rejects.toThrow('already exists');
  const path = join(workspace.root, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.scripts['dev:new'] = 'echo custom';
  await writeFile(path, JSON.stringify(pkg));
  await expect(
    planAddApp(workspace, { name: 'new', framework: 'vite' }),
  ).rejects.toThrow('already exists');
});
it('rejects custom package globs', async () => {
  const workspace = await fixture();
  await writeFile(
    join(workspace.root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - '!apps/private'\n",
  );
  await expect(
    planAddApp(workspace, { name: 'new', framework: 'vite' }),
  ).rejects.toThrow('Unsupported pnpm-workspace');
});
it.each(['code', 'dependency', 'backend', 'setup'])(
  'rejects an auth %s conflict without writes',
  async (conflict) => {
    const workspace = await fixture('messages', 'none', 'vite');
    if (conflict === 'code')
      await writeFile(
        join(workspace.root, 'apps/web/src/auth-controls.tsx'),
        'export const custom = true;\n',
      );
    if (conflict === 'backend')
      await writeFile(
        join(workspace.root, 'packages/backend/convex/access.ts'),
        'export const custom = true;\n',
      );
    if (conflict === 'setup')
      await writeFile(join(workspace.root, 'CLERK_SETUP.md'), '# Custom\n');
    if (conflict === 'dependency') {
      const path = join(workspace.root, 'apps/web/package.json');
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      pkg.dependencies['@clerk/react'] = 'custom';
      await writeFile(path, JSON.stringify(pkg));
    }
    const before = await snapshot(workspace.root);
    await expect(planAddAuth(workspace, 'clerk')).rejects.toThrow(
      /Conflict|Incompatible|already exists/,
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

it('supports v0.2.1 metadata without example and preserves unknown metadata', async () => {
  let workspace = await fixture();
  const path = join(workspace.root, 'convex-monorepo.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  delete metadata.example;
  metadata.generator = '0.2.1';
  metadata.custom = { keep: true };
  metadata.apps[0].custom = 'keep';
  await writeFile(path, JSON.stringify(metadata));
  workspace = await loadWorkspace(workspace.root);
  await applyPlan(
    await planAddApp(workspace, { name: 'extra', framework: 'vite' }),
  );
  const next = JSON.parse(await readFile(path, 'utf8'));
  expect(next.custom).toEqual({ keep: true });
  expect(next.apps[0].custom).toBe('keep');
  expect(
    await readFile(join(workspace.root, 'apps/extra/src/messages.tsx'), 'utf8'),
  ).toContain('api.messages');
});

it('checks backend contract guards again when an app plan is applied', async () => {
  const workspace = await fixture();
  const plan = await planAddApp(workspace, {
    name: 'extra',
    framework: 'vite',
  });
  const path = join(workspace.root, 'packages/backend/convex/messages.ts');
  await writeFile(
    path,
    `${await readFile(path, 'utf8')}\n// concurrent change\n`,
  );
  const before = await snapshot(workspace.root);
  await expect(applyPlan(plan)).rejects.toThrow('Workspace changed');
  expect(await snapshot(workspace.root)).toEqual(before);
});

it.each<Framework>([...frameworks, 'sveltekit'])(
  'links only the public URL into the new %s app',
  async (framework) => {
    const workspace = await fixture('none');
    await writeFile(
      join(workspace.root, 'packages/backend/.env'),
      'CONVEX_URL=https://older.convex.cloud\nCONVEX_DEPLOY_KEY=private-deploy-key\n',
    );
    await writeFile(
      join(workspace.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://current.convex.cloud\nCLERK_SECRET_KEY=private-clerk-key\n',
    );
    await writeFile(
      join(workspace.root, 'apps/web/.env.local'),
      'NEXT_PUBLIC_CONVEX_URL=https://preserved.convex.cloud\nCUSTOM=keep\n',
    );
    const before = await snapshot(workspace.root);
    const plan = await planAddApp(workspace, { name: 'extra', framework });
    await applyPlan(plan, { dryRun: true });
    expect(await snapshot(workspace.root)).toEqual(before);
    await applyPlan(plan);
    const after = await snapshot(workspace.root);
    const prefix =
      framework === 'next'
        ? 'NEXT_PUBLIC'
        : framework === 'expo'
          ? 'EXPO_PUBLIC'
          : framework === 'sveltekit'
            ? 'PUBLIC'
            : 'VITE';
    expect(after['apps/extra/.env.local']).toBe(
      `${prefix}_CONVEX_URL=https://current.convex.cloud\n`,
    );
    expect(after['apps/web/.env.local']).toBe(before['apps/web/.env.local']);
    expect(after['packages/backend/.env.local']).toBe(
      before['packages/backend/.env.local'],
    );
    expect(
      plan.changes.some((change) =>
        /private-deploy-key|private-clerk-key/.test(change.after),
      ),
    ).toBe(false);
  },
);

it('rejects invalid backend URLs without disclosing credentials', async () => {
  const workspace = await fixture('none');
  await writeFile(
    join(workspace.root, 'packages/backend/.env.local'),
    'CONVEX_URL=https://user:private-password@example.com\n',
  );
  const before = await snapshot(workspace.root);
  const result = await planAddApp(workspace, {
    name: 'extra',
    framework: 'vite',
  }).catch((error) => error as Error);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).not.toContain('private-password');
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('guards backend environment changes before applying an app addition', async () => {
  const workspace = await fixture('none');
  const path = join(workspace.root, 'packages/backend/.env.local');
  await writeFile(path, 'CONVEX_URL=https://old.convex.cloud\n');
  const plan = await planAddApp(workspace, {
    name: 'extra',
    framework: 'vite',
  });
  await writeFile(path, 'CONVEX_URL=https://new.convex.cloud\n');
  const before = await snapshot(workspace.root);
  await expect(applyPlan(plan)).rejects.toThrow('Workspace changed');
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('rejects an app directory created after planning', async () => {
  const workspace = await fixture('none');
  const plan = await planAddApp(workspace, {
    name: 'extra',
    framework: 'vite',
  });
  await mkdir(join(workspace.root, 'apps/extra'));
  await writeFile(join(workspace.root, 'apps/extra/custom.txt'), 'keep\n');
  const before = await snapshot(workspace.root);
  await expect(applyPlan(plan)).rejects.toThrow('Path appeared while planning');
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('accepts reordered backend export conditions and preserves extra exports', async () => {
  const workspace = await fixture('none');
  const path = join(workspace.root, 'packages/backend/package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.exports['./api'] = {
    default: './convex/_generated/api.js',
    types: './convex/_generated/api.d.ts',
    import: './convex/_generated/api.js',
  };
  pkg.exports['./custom'] = './custom.js';
  const before = JSON.stringify(pkg);
  await writeFile(path, before);
  await applyPlan(
    await planAddApp(workspace, { name: 'extra', framework: 'vite' }),
  );
  expect(await readFile(path, 'utf8')).toBe(before);
});

it('adds Clerk to a blank workspace without replacing a customized schema', async () => {
  const workspace = await fixture('none');
  const path = join(workspace.root, 'packages/backend/convex/schema.ts');
  const custom = `${await readFile(path, 'utf8')}\n// A customized blank backend\n`;
  await writeFile(path, custom);
  await applyPlan(await planAddAuth(workspace, 'clerk'));
  expect(await readFile(path, 'utf8')).toBe(custom);
});

it.each<Framework>([...frameworks, 'sveltekit'])(
  'assigns the workspace-index port to a new %s app',
  async (framework) => {
    const workspace = await fixture('none');
    const plan = await planAddApp(workspace, { name: 'extra', framework });
    await applyPlan(plan);
    if (framework === 'next' || framework === 'expo') {
      const pkg = JSON.parse(
        await readFile(join(workspace.root, 'apps/extra/package.json'), 'utf8'),
      );
      expect(pkg.scripts.dev).toBe(
        framework === 'next'
          ? 'next dev --port 3001'
          : 'expo start --port 8082',
      );
    } else {
      expect(
        await readFile(
          join(workspace.root, 'apps/extra/vite.config.ts'),
          'utf8',
        ),
      ).toContain('port: 3001, strictPort: true');
    }
  },
);

it('keeps unique development ports through sequential app additions', async () => {
  let workspace = await fixture('none');
  for (const [index, framework] of (
    ['vite', 'tanstack-start', 'next'] as const
  ).entries()) {
    const name = `added-${index}`;
    await applyPlan(await planAddApp(workspace, { name, framework }));
    workspace = await loadWorkspace(workspace.root);
  }
  const files = await snapshot(workspace.root);
  expect(JSON.parse(files['apps/web/package.json']!).scripts.dev).toBe(
    'next dev --port 3000',
  );
  expect(files['apps/added-0/vite.config.ts']).toContain('port: 3001');
  expect(files['apps/added-1/vite.config.ts']).toContain('port: 3002');
  expect(JSON.parse(files['apps/added-2/package.json']!).scripts.dev).toBe(
    'next dev --port 3003',
  );
});

it.each(['next', 'vite'] as const)(
  'rejects a new app port claimed by customized %s configuration',
  async (framework) => {
    const workspace = await fixture('none', 'none', framework);
    if (framework === 'next') {
      const path = join(workspace.root, 'apps/web/package.json');
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      pkg.scripts.dev = 'next dev --port 3001';
      await writeFile(path, JSON.stringify(pkg));
    } else {
      const path = join(workspace.root, 'apps/web/vite.config.ts');
      await writeFile(
        path,
        (await readFile(path, 'utf8')).replace('port: 3000', 'port: 3001'),
      );
    }
    const before = await snapshot(workspace.root);
    await expect(
      planAddApp(workspace, { name: 'extra', framework: 'vite' }),
    ).rejects.toThrow('Development port 3001 is already configured');
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

it('supports CRLF checkouts while preserving modified code line endings', async () => {
  let workspace = await fixture('messages');
  for (const [path, contents] of Object.entries(
    await snapshot(workspace.root),
  )) {
    await writeFile(
      join(workspace.root, path),
      contents.replace(/\r?\n/g, '\r\n'),
    );
  }
  workspace = await loadWorkspace(workspace.root);
  await applyPlan(
    await planAddApp(workspace, { name: 'extra', framework: 'vite' }),
  );
  workspace = await loadWorkspace(workspace.root);
  await applyPlan(await planAddAuth(workspace, 'clerk'));
  const providers = await readFile(
    join(workspace.root, 'apps/web/src/providers.tsx'),
    'utf8',
  );
  expect(providers).toContain('@clerk/nextjs');
  expect(providers).toContain('\r\n');
  expect(providers).not.toMatch(/(?<!\r)\n/);
  const access = await readFile(
    join(workspace.root, 'packages/backend/convex/access.ts'),
    'utf8',
  );
  expect(access).toContain('getUserIdentity');
  expect(access).not.toMatch(/(?<!\r)\n/);
  // An existing CRLF Clerk configuration remains compatible with later apps.
  const configPath = join(
    workspace.root,
    'packages/backend/convex/auth.config.ts',
  );
  await writeFile(
    configPath,
    (await readFile(configPath, 'utf8')).replace(/\r?\n/g, '\r\n'),
  );
  workspace = await loadWorkspace(workspace.root);
  await applyPlan(
    await planAddApp(workspace, { name: 'last', framework: 'tanstack-start' }),
  );
});

it('rejects substantive changes in CRLF auth code without writes', async () => {
  const workspace = await fixture('messages');
  const path = join(workspace.root, 'apps/web/src/auth-controls.tsx');
  await writeFile(
    path,
    'export function AuthControls() { return "custom"; }\r\n',
  );
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'clerk')).rejects.toThrow(
    'Conflict in apps/web/src/auth-controls.tsx',
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

describe('add package', () => {
  describe.each<Example>(['none', 'messages'])('%s content', (example) => {
    it.each<Auth>(['none', 'clerk', 'convex-auth'])(
      'adds formatted source with %s auth and preserves unrelated files',
      async (auth) => {
        const workspace = await fixture(example, auth);
        await writeFile(
          join(workspace.root, 'README.md'),
          '# Custom documentation\n',
        );
        const before = await snapshot(workspace.root);
        const plan = await planAddPackage(workspace, { name: 'shared' });
        expect(await snapshot(workspace.root)).toEqual(before);
        await applyPlan(plan, { dryRun: true });
        expect(await snapshot(workspace.root)).toEqual(before);
        const files = {
          'packages/shared/package.json': `${JSON.stringify(
            {
              name: '@sample/shared',
              version: '0.0.0',
              private: true,
              type: 'module',
              exports: { '.': './src/index.ts' },
              scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' },
              devDependencies: {
                typescript: versions.typescript,
                eslint: versions.eslint,
                '@sample/eslint-config': 'workspace:*',
                '@sample/typescript-config': 'workspace:*',
              },
            },
            null,
            2,
          )}\n`,
          'packages/shared/tsconfig.json': JSON.stringify(
            {
              extends: '@sample/typescript-config/base.json',
              include: ['src'],
            },
            null,
            2,
          ),
          'packages/shared/eslint.config.js':
            "export { default } from '@sample/eslint-config';\n",
          'packages/shared/src/index.ts':
            "// Replace this export with your shared code.\nexport const packageName = '@sample/shared';\n",
        };
        const expected = { ...before };
        for (const [path, contents] of Object.entries(files)) {
          expected[path] = await formatGeneratedFile(path, contents);
          expect(plan.changes.find((change) => change.path === path)).toEqual({
            path,
            before: null,
            after: expected[path],
          });
          expect(expected[path]).not.toContain('\r');
        }
        expected['apps/web/next.config.ts'] = await formatGeneratedFile(
          'next.config.ts',
          before['apps/web/next.config.ts']!.replace(
            "'@sample/backend'",
            "'@sample/backend', '@sample/shared'",
          ),
        );
        expected['convex-monorepo.json'] =
          `${JSON.stringify({ ...workspace.rawConfig, packages: [{ name: 'shared' }] }, null, 2)}\n`;
        expect(plan.notes).toEqual([
          'Add "@sample/shared": "workspace:*" to each app that should import it, then run pnpm install.',
        ]);
        await applyPlan(plan);
        expect(await snapshot(workspace.root)).toEqual(expected);
        expect((await loadWorkspace(workspace.root)).config.packages).toEqual([
          { name: 'shared' },
        ]);
        const tsconfigPackage = JSON.parse(
          before['packages/typescript-config/package.json']!,
        );
        expect(tsconfigPackage.exports['./base.json']).toBe('./base.json');
      },
    );
  });

  it('rejects invalid, reserved, app, and metadata names with specific errors', async () => {
    let workspace = await fixture('none');
    for (const name of [
      '',
      '../escape',
      'Invalid',
      '-bad',
      'a'.repeat(101),
      'nul',
      'com1',
      'node_modules',
    ]) {
      await expect(planAddPackage(workspace, { name })).rejects.toThrow(
        `Invalid package name "${name}"`,
      );
    }
    for (const name of ['backend', 'typescript-config', 'eslint-config']) {
      await expect(planAddPackage(workspace, { name })).rejects.toThrow(
        `Package name "${name}" is reserved`,
      );
    }
    await expect(planAddPackage(workspace, { name: 'web' })).rejects.toThrow(
      'Package name "web" is already used by an application',
    );
    const metadata = { ...workspace.rawConfig, packages: [{ name: 'taken' }] };
    await writeFile(
      join(workspace.root, 'convex-monorepo.json'),
      JSON.stringify(metadata),
    );
    workspace = await loadWorkspace(workspace.root);
    const before = await snapshot(workspace.root);
    await expect(planAddPackage(workspace, { name: 'taken' })).rejects.toThrow(
      'Package taken already exists in convex-monorepo.json',
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  });

  it.each(['directory', 'file', 'symlink'])(
    'rejects an existing %s at the destination',
    async (kind) => {
      const workspace = await fixture('none');
      const destination = join(workspace.root, 'packages/shared');
      if (kind === 'directory') await mkdir(destination);
      else if (kind === 'file') await writeFile(destination, 'keep\n');
      else await symlink(join(workspace.root, 'missing'), destination);
      await expect(
        planAddPackage(workspace, { name: 'shared' }),
      ).rejects.toThrow(
        kind === 'directory'
          ? 'Package path packages/shared already exists'
          : kind === 'file'
            ? 'Expected a directory in workspace path: packages/shared/package.json'
            : 'Refusing symlink in workspace path',
      );
    },
  );

  it.each(['customized', 'non-literal', 'missing'])(
    'leaves a %s Next config alone and still applies',
    async (kind) => {
      const workspace = await fixture('none');
      const path = join(workspace.root, 'apps/web/next.config.ts');
      if (kind === 'missing') await rm(path);
      else
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replace(
            "transpilePackages: ['@sample/backend']",
            kind === 'non-literal'
              ? "transpilePackages: ['@sample/backend', customPackage]"
              : "transpilePackages: ['@sample/backend'], reactStrictMode: true",
          ),
        );
      const before = await snapshot(workspace.root);
      const plan = await planAddPackage(workspace, { name: 'shared' });
      expect(plan.notes).toContain(
        "apps/web/next.config.ts is customized. Add '@sample/shared' to transpilePackages before importing it.",
      );
      expect(
        plan.changes.some(
          (change) => change.path === 'apps/web/next.config.ts',
        ),
      ).toBe(false);
      await applyPlan(plan);
      const after = await snapshot(workspace.root);
      expect(after['apps/web/next.config.ts']).toBe(
        before['apps/web/next.config.ts'],
      );
      expect(after['packages/shared/src/index.ts']).toContain('@sample/shared');
    },
  );

  it('leaves a Next config that already lists the package untouched', async () => {
    const workspace = await fixture('none');
    const path = join(workspace.root, 'apps/web/next.config.ts');
    const before = (await readFile(path, 'utf8'))
      .replace("'@sample/backend'", "'@sample/backend', '@sample/shared'")
      .replaceAll('\n', '\r\n');
    await writeFile(path, before);
    const plan = await planAddPackage(workspace, { name: 'shared' });
    expect(
      plan.changes.some((change) => change.path === 'apps/web/next.config.ts'),
    ).toBe(false);
    expect(plan.notes.some((note) => note.includes('next.config.ts'))).toBe(
      false,
    );
    await applyPlan(plan);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each(['', "'custom'", "\n  'first',\n  'second',\n", "'with,comma'"])(
    'appends to a Next config with string list %j',
    async (entries) => {
      const workspace = await fixture('none');
      const path = join(workspace.root, 'apps/web/next.config.ts');
      const before = (await readFile(path, 'utf8')).replace(
        "'@sample/backend'",
        entries,
      );
      await writeFile(path, before);
      const plan = await planAddPackage(workspace, { name: 'shared' });
      expect(plan.notes.some((note) => note.includes('next.config.ts'))).toBe(
        false,
      );
      await applyPlan(plan);
      expect(await readFile(path, 'utf8')).toBe(
        await formatGeneratedFile(
          path,
          before.replace(
            `[${entries}]`,
            `[${entries.trim().replace(/,$/, '')}${entries ? ', ' : ''}'@sample/shared']`,
          ),
        ),
      );
    },
  );

  it('preserves CRLF in updated Next configs', async () => {
    const workspace = await fixture('none');
    const path = join(workspace.root, 'apps/web/next.config.ts');
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace(/\r?\n/g, '\r\n'),
    );
    await applyPlan(await planAddPackage(workspace, { name: 'shared' }));
    const after = await readFile(path, 'utf8');
    expect(after).toContain('@sample/shared');
    expect(after).toContain('\r\n');
    expect(after).not.toMatch(/(?<!\r)\n/);
  });

  it('accepts older formatting while preserving code and comment customizations', async () => {
    const workspace = await fixture('none');
    const path = join(workspace.root, 'apps/web/next.config.ts');
    const baseline = await readFile(path, 'utf8');
    await writeFile(path, baseline.replaceAll("'", '"').replaceAll('\n', ' '));
    expect(
      (await planAddPackage(workspace, { name: 'shared' })).changes.some(
        (change) => change.path === 'apps/web/next.config.ts',
      ),
    ).toBe(true);
    await writeFile(path, `// Keep this comment.\n${baseline}`);
    expect(
      (await planAddPackage(workspace, { name: 'shared' })).notes,
    ).toContain(
      "apps/web/next.config.ts is customized. Add '@sample/shared' to transpilePackages before importing it.",
    );
  });

  it.each<Framework>(['vite', 'tanstack-start', 'expo'])(
    'does not change %s config',
    async (framework) => {
      const workspace = await fixture('none', 'none', framework);
      const before = await snapshot(workspace.root);
      const plan = await planAddPackage(workspace, { name: 'shared' });
      expect(plan.changes).toHaveLength(5);
      expect(
        plan.changes.some((change) => change.path.startsWith('apps/')),
      ).toBe(false);
      await applyPlan(plan);
      const after = await snapshot(workspace.root);
      for (const [path, contents] of Object.entries(before))
        if (path !== 'convex-monorepo.json')
          expect(after[path], path).toBe(contents);
    },
  );

  it('updates every unmodified Next app in a mixed workspace', async () => {
    let workspace = await fixture('none');
    for (const [name, framework] of [
      ['second', 'next'],
      ['admin', 'vite'],
    ] as const) {
      await applyPlan(await planAddApp(workspace, { name, framework }));
      workspace = await loadWorkspace(workspace.root);
    }
    const plan = await planAddPackage(workspace, { name: 'shared' });
    expect(
      plan.changes
        .filter((change) => change.path.startsWith('apps/'))
        .map((change) => change.path),
    ).toEqual(['apps/web/next.config.ts', 'apps/second/next.config.ts']);
    await applyPlan(plan);
  });

  it.each(['metadata', 'destination', 'next config'])(
    'rejects a concurrent %s change without writes',
    async (kind) => {
      const workspace = await fixture('none');
      const plan = await planAddPackage(workspace, { name: 'shared' });
      if (kind === 'metadata')
        await writeFile(
          join(workspace.root, 'convex-monorepo.json'),
          `${workspace.configText}\n`,
        );
      else if (kind === 'destination')
        await mkdir(join(workspace.root, 'packages/shared'));
      else
        await writeFile(
          join(workspace.root, 'apps/web/next.config.ts'),
          'export default {};\n',
        );
      const before = await snapshot(workspace.root);
      await expect(applyPlan(plan)).rejects.toThrow(
        kind === 'destination'
          ? 'Path appeared while planning'
          : 'Workspace changed while planning',
      );
      expect(await snapshot(workspace.root)).toEqual(before);
    },
  );

  it.each(['packages/shared/src/index.ts', 'convex-monorepo.json'])(
    'rolls back after cancellation at %s',
    async (stopAt) => {
      const workspace = await fixture('none');
      const before = await snapshot(workspace.root);
      const plan = await planAddPackage(workspace, { name: 'shared' });
      const controller = new AbortController();
      await expect(
        applyPlan(plan, {
          signal: controller.signal,
          onProgress: (path) => {
            if (path === stopAt) controller.abort(new Error('Interrupted'));
          },
        }),
      ).rejects.toThrow('Interrupted');
      expect(await snapshot(workspace.root)).toEqual(before);
      expect(await readdir(join(workspace.root, 'packages'))).not.toContain(
        'shared',
      );
    },
  );

  it('appends a second package and preserves unknown metadata fields', async () => {
    let workspace = await fixture('none');
    const path = join(workspace.root, 'convex-monorepo.json');
    await writeFile(
      path,
      JSON.stringify({
        ...workspace.rawConfig,
        custom: { keep: true },
        packages: [{ name: 'existing', custom: true }],
      }),
    );
    workspace = await loadWorkspace(workspace.root);
    await applyPlan(await planAddPackage(workspace, { name: 'shared' }));
    workspace = await loadWorkspace(workspace.root);
    const nextBefore = await readFile(
      join(workspace.root, 'apps/web/next.config.ts'),
      'utf8',
    );
    const plan = await planAddPackage(workspace, { name: 'other' });
    expect(plan.notes.some((note) => note.includes('next.config.ts'))).toBe(
      false,
    );
    await applyPlan(plan);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      version: 1,
      custom: { keep: true },
      packages: [
        { name: 'existing', custom: true },
        { name: 'shared' },
        { name: 'other' },
      ],
    });
    expect(
      await readFile(join(workspace.root, 'apps/web/next.config.ts'), 'utf8'),
    ).toBe(
      await formatGeneratedFile(
        'next.config.ts',
        nextBefore.replace(
          "'@sample/shared'",
          "'@sample/shared', '@sample/other'",
        ),
      ),
    );
  });

  it.each(['globs', 'shared package'])(
    'verifies workspace %s before planning',
    async (kind) => {
      const workspace = await fixture('none');
      if (kind === 'globs')
        await writeFile(
          join(workspace.root, 'pnpm-workspace.yaml'),
          "packages:\n  - 'apps/*'\n",
        );
      else
        await writeFile(
          join(workspace.root, 'packages/typescript-config/package.json'),
          '{"name":"@wrong/typescript-config"}',
        );
      const before = await snapshot(workspace.root);
      await expect(
        planAddPackage(workspace, { name: 'shared' }),
      ).rejects.toThrow(
        kind === 'globs'
          ? 'Unsupported pnpm-workspace.yaml'
          : 'Incompatible shared package',
      );
      expect(await snapshot(workspace.root)).toEqual(before);
    },
  );

  it('validates optional metadata packages', async () => {
    const workspace = await fixture('none');
    expect(parseWorkspaceConfig(workspace.rawConfig).packages).toEqual([]);
    expect(
      parseWorkspaceConfig({
        ...workspace.rawConfig,
        packages: [
          { name: 'shared', extra: 'kept in raw config' },
          { name: 'a'.repeat(100) },
        ],
      }).packages,
    ).toEqual([{ name: 'shared' }, { name: 'a'.repeat(100) }]);
    for (const packages of [
      null,
      {},
      'shared',
      [null],
      [[]],
      ['shared'],
      [{}],
      [{ name: 1 }],
      [{ name: '../bad' }],
      [{ name: 'CON' }],
      [{ name: 'a'.repeat(101) }],
    ]) {
      expect(() =>
        parseWorkspaceConfig({ ...workspace.rawConfig, packages }),
      ).toThrow(/Invalid package/);
    }
  });
});

it('rejects adding an app with an existing shared package name', async () => {
  let workspace = await fixture('none');
  await applyPlan(await planAddPackage(workspace, { name: 'shared' }));
  workspace = await loadWorkspace(workspace.root);
  const before = await snapshot(workspace.root);
  await expect(
    planAddApp(workspace, { name: 'shared', framework: 'vite' }),
  ).rejects.toThrow(
    'Application name "shared" is already used by a shared package.',
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

describe.each(['missing', 'customized'])(
  'add app with %s Convex Auth files',
  (state) => {
    it.each(['auth.config.ts', 'auth.ts', 'http.ts'])(
      'rejects %s when adding a blank app without writes',
      async (name) => {
        const workspace = await fixture('none', 'convex-auth');
        const path = `packages/backend/convex/${name}`;
        if (state === 'missing') await rm(join(workspace.root, path));
        else
          await writeFile(
            join(workspace.root, path),
            'export const customized = true;\n',
          );
        const before = await snapshot(workspace.root);
        await expect(
          planAddApp(workspace, { name: 'added', framework: 'vite' }),
        ).rejects.toThrow(path);
        expect(await snapshot(workspace.root)).toEqual(before);
      },
    );
  },
);

it.each(['none', 'messages'] as const)(
  'refuses to replace Convex Auth with Clerk in a %s workspace',
  async (example) => {
    const workspace = await fixture(example, 'convex-auth');
    const before = await snapshot(workspace.root);
    await expect(planAddAuth(workspace, 'clerk')).rejects.toThrow(
      'Switching authentication providers requires a manual migration',
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

describe.each<Example>(['none', 'messages'])(
  'add Convex Auth with %s content',
  (example) => {
    it.each(frameworks)(
      'integrates %s while preserving project-owned files and package entries',
      async (framework) => {
        const workspace = await fixture(example, 'none', framework);
        for (const path of [
          'package.json',
          'packages/backend/package.json',
          'apps/web/package.json',
        ]) {
          const fullPath = join(workspace.root, path);
          const pkg = JSON.parse(await readFile(fullPath, 'utf8'));
          pkg.dependencies = {
            ...pkg.dependencies,
            'my-custom-library': '1.2.3',
          };
          pkg.scripts = { ...pkg.scripts, custom: 'echo custom' };
          await writeFile(fullPath, JSON.stringify(pkg));
        }
        await writeFile(
          join(workspace.root, 'README.md'),
          '# My documentation\n',
        );
        const before = await snapshot(workspace.root);
        const plan = await planAddAuth(workspace, 'convex-auth');
        await applyPlan(plan, { dryRun: true });
        expect(await snapshot(workspace.root)).toEqual(before);
        expect(
          plan.changes.some(({ path }) => path.includes('/_generated/')),
        ).toBe(false);
        expect(plan.notes.join('\n')).toMatch(/pnpm convex:dev|convex codegen/);
        expect(plan.notes.join('\n')).toContain('pnpm convex:auth-keys');
        expect(plan.notes.join('\n')).toContain('pnpm install');
        expect(plan.notes.join('\n')).toContain('CONVEX_AUTH_SETUP.md');
        await applyPlan(plan);
        const after = await snapshot(workspace.root);
        for (const path of Object.keys(before).filter(
          (path) =>
            path.includes('/_generated/') ||
            path.endsWith('/messages.ts') ||
            path === 'README.md',
        ))
          expect(after[path], path).toBe(before[path]);
        for (const path of [
          'package.json',
          'packages/backend/package.json',
          'apps/web/package.json',
        ]) {
          const pkg = JSON.parse(after[path]!);
          expect(pkg.dependencies['my-custom-library']).toBe('1.2.3');
          expect(pkg.scripts.custom).toBe('echo custom');
        }
        const backend = JSON.parse(after['packages/backend/package.json']!);
        expect(backend.dependencies['@convex-dev/auth']).toBe(
          versions.convexAuth,
        );
        expect(backend.dependencies['@auth/core']).toBe(versions.authCore);
        const app = JSON.parse(after['apps/web/package.json']!);
        expect(app.dependencies['@convex-dev/auth']).toBe(versions.convexAuth);
        if (framework === 'expo') {
          expect(app.dependencies['expo-secure-store']).toBe('57.0.3');
          expect(after['apps/web/src/providers.tsx']).toContain(
            'expo-secure-store',
          );
        } else expect(app.dependencies['expo-secure-store']).toBeUndefined();
        expect(after['apps/web/src/providers.tsx']).toContain(
          'ConvexAuthProvider',
        );
        expect(after['apps/web/src/auth-controls.tsx']).toContain(
          '@convex-dev/auth/react',
        );
        expect(after['packages/backend/convex/auth.ts']).toContain(
          'providers: [Password]',
        );
        expect(after['packages/backend/convex/http.ts']).toContain(
          'auth.addHttpRoutes(http)',
        );
        expect(after['packages/backend/convex/auth.config.ts']).toContain(
          'CONVEX_SITE_URL',
        );
        expect(after['packages/backend/.env.convex-auth.example']).toContain(
          'JWT_PRIVATE_KEY',
        );
        const asset =
          example === 'messages'
            ? 'backend-convex-auth'
            : 'backend-blank-convex-auth';
        expect(after['packages/backend/convex/schema.ts']).toBe(
          await formatGeneratedFile(
            'schema.ts',
            await readFile(
              new URL(`../assets/${asset}/convex/schema.ts`, import.meta.url),
              'utf8',
            ),
          ),
        );
        if (example === 'messages')
          expect(after['packages/backend/convex/access.ts']).toContain(
            'getAuthUserId',
          );
        else expect(after['packages/backend/convex/access.ts']).toBeUndefined();
        expect(
          JSON.parse(after['package.json']!).scripts['convex:auth-keys'],
        ).toBe('node scripts/convex-auth-keys.mjs');
        expect(after['scripts/convex-auth-keys.mjs']).toContain(
          'JWT_PRIVATE_KEY',
        );
        expect(after['.gitignore']).toContain('!.env.convex-auth.example');
        expect(after['CONVEX_AUTH_SETUP.md']).toContain('## Convex Auth setup');
        expect(after['CONVEX_AUTH_SETUP.md']).toContain('pnpm install');
        if (example === 'messages')
          expect(after['CONVEX_AUTH_SETUP.md']).toContain(
            'does not migrate stored data',
          );
        const reloaded = await loadWorkspace(workspace.root);
        expect(reloaded.config.auth).toBe('convex-auth');
        const repeated = await planAddAuth(reloaded, 'convex-auth');
        expect(repeated.changes).toEqual([]);
        expect(repeated.notes.join('\n')).toMatch(/already configured/i);
      },
    );
  },
);

it('adds authTables first in a customized schema while retaining custom tables', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
// Preserve our custom tables.
export default defineSchema({ projects: defineTable({ name: v.string() }).index('by_name', ['name']) });
`,
  );
  await applyPlan(await planAddAuth(workspace, 'convex-auth'));
  const schema = await readFile(join(workspace.root, path), 'utf8');
  expect(schema).toContain(
    "import { authTables } from '@convex-dev/auth/server';",
  );
  expect(schema).toMatch(/defineSchema\(\{\s*\.\.\.authTables,\s*projects:/);
  expect(schema).toContain(".index('by_name', ['name'])");
  expect(schema).toContain('// Preserve our custom tables.');
  expect(schema).toBe(await formatGeneratedFile(path, schema));
});

it.each(['authTables', 'convexAuthTables'])(
  'preserves and guards a schema that spreads the imported %s',
  async (localName) => {
    const workspace = await fixture('none');
    const path = 'packages/backend/convex/schema.ts';
    const source = `import { authTables as ${localName} } from '@convex-dev/auth/server';
import { defineSchema } from 'convex/server';
export default defineSchema({ ...${localName} });
`;
    await writeFile(join(workspace.root, path), source);
    const plan = await planAddAuth(workspace, 'convex-auth');
    expect(plan.changes.some((change) => change.path === path)).toBe(false);
    await applyPlan(plan, { dryRun: true });
    await writeFile(
      join(workspace.root, path),
      `${source}\n// concurrent edit\n`,
    );
    await expect(applyPlan(plan)).rejects.toThrow('Workspace changed');
  },
);

it.each([
  '...customTables',
  '[key]: defineTable({})',
  "['projects']: defineTable({})",
  '123: defineTable({})',
])('rejects a schema with an unsafe table key: %s', async (property) => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema, defineTable } from 'convex/server';
const customTables = { users: defineTable({}) };
const key = 'users';
export default defineSchema({ ${property} });
`,
  );
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    `Conflict in ${path}: the schema contains a spread or computed table name, so Convex Auth tables cannot be merged safely. Add "...authTables" manually and rerun add auth convex-auth. No files were changed.`,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('does not report a variable named users as a literal table collision', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema, defineTable } from 'convex/server';
const users = 'projects';
export default defineSchema({ [users]: defineTable({}) });
`,
  );
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    `Conflict in ${path}: the schema contains a spread or computed table name, so Convex Auth tables cannot be merged safely. Add "...authTables" manually and rerun add auth convex-auth. No files were changed.`,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it.each([
  'const authTables = {};',
  "import type { authTables } from '@convex-dev/auth/server';",
  "import { type authTables } from '@convex-dev/auth/server';",
  "import { authTables } from './custom';",
  "import { other as authTables } from '@convex-dev/auth/server';",
  "import authTables from '@convex-dev/auth/server';",
])('does not accept an unrelated authTables spread: %s', async (binding) => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema } from 'convex/server';
${binding}
export default defineSchema({ ...authTables });
`,
  );
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    `Conflict in ${path}: the schema contains a spread or computed table name, so Convex Auth tables cannot be merged safely. Add "...authTables" manually and rerun add auth convex-auth. No files were changed.`,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('checks table collisions when imported authTables is only spread outside the schema', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema, defineTable } from 'convex/server';
import { authTables } from '@convex-dev/auth/server';
const tables = { ...authTables };
export default defineSchema({ users: defineTable({}) });
`,
  );
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    `Conflict in ${path}: table "users" collides with Convex Auth. Merge it with the Convex Auth users table definition manually. No files were changed.`,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('rejects an unused authTables binding instead of injecting a duplicate import', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema, defineTable } from 'convex/server';
import { authTables } from '@convex-dev/auth/server';
export default defineSchema({ projects: defineTable({}) });
`,
  );
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    `Conflict in ${path}: authTables is already declared but not spread into the exported schema. Insert "...authTables," as the first entry of the object passed to defineSchema. No files were changed.`,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

describe.each(['identifier', 'string literal'])(
  'Convex Auth table collision with a %s key',
  (keyType) => {
    it.each([
      'users',
      'authSessions',
      'authAccounts',
      'authRefreshTokens',
      'authVerificationCodes',
      'authVerifiers',
      'authRateLimits',
    ])('rejects the existing %s table without writes', async (table) => {
      const workspace = await fixture('none');
      const path = 'packages/backend/convex/schema.ts';
      const key = keyType === 'identifier' ? table : `'${table}'`;
      await writeFile(
        join(workspace.root, path),
        `import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
export default defineSchema({ ${key}: defineTable({ custom: v.string() }) });
`,
      );
      const before = await snapshot(workspace.root);
      await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
        `Conflict in ${path}: table "${table}" collides with Convex Auth. Merge it with the Convex Auth users table definition manually. No files were changed.`,
      );
      expect(await snapshot(workspace.root)).toEqual(before);
    });
  },
);

it('patches the default-exported schema through a renamed Convex import', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema as schema, defineTable } from 'convex/server';
import { v } from 'convex/values';
export default schema({ projects: defineTable({ name: v.string() }) });
`,
  );
  await applyPlan(await planAddAuth(workspace, 'convex-auth'));
  const schema = await readFile(join(workspace.root, path), 'utf8');
  expect(schema).toContain(
    "import { authTables } from '@convex-dev/auth/server';",
  );
  expect(schema).toMatch(
    /export default schema\(\{\s*\.\.\.authTables,\s*projects:/,
  );
});

it.each([
  "import { defineSchema } from 'convex/server'; const unused = defineSchema({}); export default {};",
  "import { defineSchema } from 'convex/server'; const schema = defineSchema({}); export default schema;",
  "import { defineSchema } from 'convex/server'; export default wrap(defineSchema({}));",
  'function defineSchema(tables: object) { return tables; } export default defineSchema({});',
  "import { defineSchema } from './custom'; export default defineSchema({});",
  "import { other as defineSchema } from 'convex/server'; export default defineSchema({});",
  "import defineSchema from 'convex/server'; export default defineSchema({});",
  "import type { defineSchema } from 'convex/server'; export default defineSchema({});",
  "import { type defineSchema } from 'convex/server'; export default defineSchema({});",
])('rejects an incorrectly bound or exported schema: %s', async (source) => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(join(workspace.root, path), source);
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    `Conflict in ${path}: add "import { authTables } from '@convex-dev/auth/server';" and insert "...authTables," as the first entry of the object passed to defineSchema. Then rerun add auth convex-auth. No files were changed.`,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('keeps leading comments and TypeScript directives above the authTables import', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  const leading = '// @ts-nocheck\n/* Project schema. Keep this header. */\n';
  await writeFile(
    join(workspace.root, path),
    `${leading}import { defineSchema } from 'convex/server';
export default defineSchema({});
`,
  );
  await applyPlan(await planAddAuth(workspace, 'convex-auth'));
  const schema = await readFile(join(workspace.root, path), 'utf8');
  expect(
    schema.startsWith(
      `${leading}import { authTables } from '@convex-dev/auth/server';\n`,
    ),
  ).toBe(true);
  expect(schema).toMatch(
    /export default defineSchema\(\{\s*\.\.\.authTables,?\s*\}\);/,
  );
  expect(schema).toBe(await formatGeneratedFile(path, schema));
});

it('does not mistake comments or strings for schema calls or authTables references', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/schema.ts';
  await writeFile(
    join(workspace.root, path),
    `import { defineSchema } from 'convex/server';
// TODO: add authTables using defineSchema({ ...authTables }).
export const description = 'authTables and defineSchema({})';
export default defineSchema({});
`,
  );
  await applyPlan(await planAddAuth(workspace, 'convex-auth'));
  const schema = await readFile(join(workspace.root, path), 'utf8');
  expect(schema).toContain(
    "import { authTables } from '@convex-dev/auth/server';",
  );
  expect(schema).toMatch(
    /export default defineSchema\(\{\s*\.\.\.authTables,?\s*\}\);/,
  );
  expect(schema).toContain("'authTables and defineSchema({})'");
});

it.each([
  "import { defineSchema } from 'convex/server'; const tables = {}; export default defineSchema(tables);",
  "import { defineSchema } from 'convex/server'; import { authTables } from '@convex-dev/auth/server'; const tables = { ...authTables }; export default defineSchema(tables);",
  "import { defineSchema } from 'convex/server'; const other = defineSchema({}); export default defineSchema({});",
  'export default {',
])('rejects a schema requiring manual edits: %s', async (source) => {
  const workspace = await fixture('none');
  await writeFile(
    join(workspace.root, 'packages/backend/convex/schema.ts'),
    source,
  );
  const before = await snapshot(workspace.root);
  const error = await planAddAuth(workspace, 'convex-auth').catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(
    'packages/backend/convex/schema.ts',
  );
  expect((error as Error).message).toContain(
    "import { authTables } from '@convex-dev/auth/server'",
  );
  expect((error as Error).message).toContain('...authTables,');
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('rejects custom HTTP routes with an actionable manual integration message', async () => {
  const workspace = await fixture();
  await writeFile(
    join(workspace.root, 'packages/backend/convex/http.ts'),
    "import { httpRouter } from 'convex/server';\nexport default httpRouter();\n",
  );
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    'auth.addHttpRoutes(http)',
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('guards an existing equivalent Convex Auth HTTP router', async () => {
  const workspace = await fixture('none');
  const path = 'packages/backend/convex/http.ts';
  const initial = await planAddAuth(workspace, 'convex-auth');
  const source = initial.changes.find((change) => change.path === path)!.after;
  await writeFile(join(workspace.root, path), source);
  const plan = await planAddAuth(workspace, 'convex-auth');
  expect(plan.changes.some((change) => change.path === path)).toBe(false);
  await writeFile(
    join(workspace.root, path),
    `${source}\n// concurrent edit\n`,
  );
  await expect(applyPlan(plan)).rejects.toThrow('Workspace changed');
});

it.each([
  'apps/web/src/providers.tsx',
  'apps/web/src/auth-controls.tsx',
  'packages/backend/convex/auth.ts',
  'packages/backend/convex/auth.config.ts',
  'packages/backend/convex/access.ts',
  'packages/backend/.env.convex-auth.example',
  'scripts/convex-auth-keys.mjs',
  'CONVEX_AUTH_SETUP.md',
])(
  'rejects customized %s during Convex Auth installation without writes',
  async (path) => {
    const workspace = await fixture();
    await writeFile(join(workspace.root, path), '// custom content\n');
    const before = await snapshot(workspace.root);
    await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
      /Conflict|already exists/,
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

it.each([
  ['apps/web/package.json', '@convex-dev/auth'],
  ['apps/web/package.json', 'expo-secure-store'],
  ['packages/backend/package.json', '@convex-dev/auth'],
  ['packages/backend/package.json', '@auth/core'],
])('rejects incompatible %s dependency %s', async (path, name) => {
  const workspace = await fixture('none', 'none', 'expo');
  const fullPath = join(workspace.root, path);
  const pkg = JSON.parse(await readFile(fullPath, 'utf8'));
  pkg.dependencies[name] = 'custom';
  await writeFile(fullPath, JSON.stringify(pkg));
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    /Conflict|Incompatible/,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('rejects a conflicting root auth key script', async () => {
  const workspace = await fixture();
  const path = join(workspace.root, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.scripts['convex:auth-keys'] = 'echo custom';
  await writeFile(path, JSON.stringify(pkg));
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    /Conflict|already exists/,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('refuses to replace Clerk with Convex Auth', async () => {
  const workspace = await fixture('messages', 'clerk');
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'convex-auth')).rejects.toThrow(
    /already configured.*manual migration/,
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('preserves custom gitignore content and notes the required Convex Auth exception', async () => {
  const workspace = await fixture();
  const path = join(workspace.root, '.gitignore');
  const source = `${await readFile(path, 'utf8')}\ncustom-output/\n`;
  await writeFile(path, source);
  const plan = await planAddAuth(workspace, 'convex-auth');
  expect(plan.notes.join('\n')).toContain('!.env.convex-auth.example');
  await applyPlan(plan);
  expect(await readFile(path, 'utf8')).toBe(source);
});

it('respects per-app blank overrides when adding Convex Auth', async () => {
  let workspace = await fixture();
  await applyPlan(
    await planAddApp(workspace, {
      name: 'blank',
      framework: 'vite',
      example: 'none',
    }),
  );
  workspace = await loadWorkspace(workspace.root);
  await applyPlan(await planAddAuth(workspace, 'convex-auth'));
  const files = await snapshot(workspace.root);
  expect(files['apps/blank/src/messages.tsx']).toBeUndefined();
  expect(files['apps/blank/src/auth-controls.tsx']).toContain(
    '@convex-dev/auth/react',
  );
  expect(files['apps/web/src/messages.tsx']).toContain('api.messages');
});

describe('SvelteKit workspace additions', () => {
  it.each<Example>(['none', 'messages'])(
    'adds the %s starter without changing existing files',
    async (example) => {
      const workspace = await fixture(example);
      const before = await snapshot(workspace.root);
      const plan = await planAddApp(workspace, {
        name: 'svelte',
        framework: 'sveltekit',
      });
      expect(await snapshot(workspace.root)).toEqual(before);
      await applyPlan(plan, { dryRun: true });
      expect(await snapshot(workspace.root)).toEqual(before);
      await applyPlan(plan);
      const after = await snapshot(workspace.root);
      for (const [path, contents] of Object.entries(before)) {
        if (!['package.json', 'convex-monorepo.json'].includes(path))
          expect(after[path], path).toBe(contents);
      }
      expect(after['apps/svelte/src/Providers.svelte']).toContain(
        'setupConvex',
      );
      expect(after['apps/svelte/src/providers.tsx']).toBeUndefined();
      expect(after['apps/svelte/src/routes/+page.svelte']).toContain(
        example === 'none' ? '<h1>svelte</h1>' : '<Messages',
      );
      expect(Boolean(after['apps/svelte/src/convex-api.type-test.ts'])).toBe(
        example === 'messages',
      );
      const reloaded = await loadWorkspace(workspace.root);
      expect(reloaded.config.apps).toContainEqual({
        name: 'svelte',
        framework: 'sveltekit',
      });
    },
  );
  it.each<Auth>(['clerk', 'convex-auth'])(
    'rejects an app addition to a %s workspace before writes',
    async (auth) => {
      const workspace = await fixture('messages', auth);
      const before = await snapshot(workspace.root);
      await expect(
        planAddApp(workspace, { name: 'svelte', framework: 'sveltekit' }),
      ).rejects.toThrow('SvelteKit currently supports only --auth none');
      expect(await snapshot(workspace.root)).toEqual(before);
    },
  );
  it.each(['clerk', 'convex-auth', 'custom'])(
    'rejects adding %s auth to a SvelteKit workspace before writes',
    async (auth) => {
      const workspace = await fixture('messages', 'none', 'sveltekit');
      const before = await snapshot(workspace.root);
      await expect(
        planAddAuth(workspace, auth as 'clerk' | 'convex-auth'),
      ).rejects.toThrow('SvelteKit currently supports only --auth none');
      expect(await snapshot(workspace.root)).toEqual(before);
    },
  );
});

it.each(['\n', '\r\n'])(
  'adds SvelteKit to a legacy workspace with %j line endings and preserves custom root configuration',
  async (newline) => {
    const workspace = await fixture('none');
    const setupPath = join(workspace.root, 'scripts/convex-setup.mjs');
    const legacySetup = (await readFile(setupPath, 'utf8'))
      .replace(/    case 'sveltekit':\n      return 'PUBLIC_CONVEX_URL';\n/, '')
      .replace(/\r?\n/g, newline);
    expect(legacySetup).not.toContain("case 'sveltekit'");
    await writeFile(setupPath, legacySetup);
    const ignorePath = join(workspace.root, '.prettierignore');
    const customIgnore =
      (await readFile(ignorePath, 'utf8'))
        .replace('**/.svelte-kit/\n', '')
        .replace('**/build/\n', '')
        .replace(/\r?\n/g, newline) +
      '# User settings' +
      newline +
      'custom-output/';
    await writeFile(ignorePath, customIgnore);
    const turboPath = join(workspace.root, 'turbo.json');
    const rootTurbo = JSON.parse(await readFile(turboPath, 'utf8'));
    rootTurbo.tasks.build.outputs = ['custom-dist/**'];
    rootTurbo.tasks.build.env = ['CUSTOM_BUILD_ENV'];
    rootTurbo.tasks.dev.passThroughEnv = ['CUSTOM_DEV_ENV'];
    rootTurbo.tasks.custom = { cache: false };
    const customTurbo = JSON.stringify(rootTurbo, null, 4) + newline;
    await writeFile(turboPath, customTurbo);
    const before = await snapshot(workspace.root);
    const plan = await planAddApp(workspace, {
      name: 'svelte',
      framework: 'sveltekit',
    });
    expect(await snapshot(workspace.root)).toEqual(before);
    await applyPlan(plan, { dryRun: true });
    expect(await snapshot(workspace.root)).toEqual(before);
    await applyPlan(plan);
    const after = await snapshot(workspace.root);
    for (const [path, contents] of Object.entries(before)) {
      if (
        ![
          'package.json',
          'convex-monorepo.json',
          'scripts/convex-setup.mjs',
          '.prettierignore',
        ].includes(path)
      )
        expect(after[path], path).toBe(contents);
    }
    expect(after['turbo.json']).toBe(customTurbo);
    expect(after['.prettierignore']).toBe(
      `${customIgnore}${newline}**/.svelte-kit/${newline}**/build/${newline}`,
    );
    expect(after['scripts/convex-setup.mjs']).toContain(
      `case 'sveltekit':${newline}      return 'PUBLIC_CONVEX_URL';`,
    );
    expect(JSON.parse(after['apps/svelte/turbo.json']!)).toEqual({
      extends: ['//'],
      tasks: {
        dev: { passThroughEnv: ['PUBLIC_*'] },
        build: {
          inputs: ['$TURBO_DEFAULT$', '.env*'],
          outputs: ['.svelte-kit/**', 'build/**'],
          env: ['PUBLIC_*'],
        },
        typecheck: { env: ['PUBLIC_*'] },
      },
    });
    expect(after['apps/svelte/prettier.config.js']).toContain(
      "createRequire(import.meta.url).resolve('prettier-plugin-svelte')",
    );
    await writeFile(
      join(workspace.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://legacy-linked.convex.cloud\n',
    );
    await promisify(execFile)(
      process.execPath,
      [await realpath(setupPath), '--link-only'],
      {
        cwd: workspace.root,
      },
    );
    expect(
      await readFile(join(workspace.root, 'apps/svelte/.env.local'), 'utf8'),
    ).toBe('PUBLIC_CONVEX_URL=https://legacy-linked.convex.cloud\n');
    const nextPlan = await planAddApp(await loadWorkspace(workspace.root), {
      name: 'second-svelte',
      framework: 'sveltekit',
    });
    expect(
      nextPlan.changes.some((change) =>
        ['scripts/convex-setup.mjs', '.prettierignore', 'turbo.json'].includes(
          change.path,
        ),
      ),
    ).toBe(false);
  },
);

it.each(['customized', 'missing'])(
  'rejects a %s setup script before adding SvelteKit without writes',
  async (state) => {
    const workspace = await fixture('none');
    const path = join(workspace.root, 'scripts/convex-setup.mjs');
    if (state === 'missing') await rm(path);
    else
      await writeFile(
        path,
        `${await readFile(path, 'utf8')}\n// Custom setup behavior must survive.\n`,
      );
    const before = await snapshot(workspace.root);
    await expect(
      planAddApp(workspace, { name: 'svelte', framework: 'sveltekit' }),
    ).rejects.toThrow(
      'Customized or missing scripts/convex-setup.mjs cannot be updated safely for SvelteKit',
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);
