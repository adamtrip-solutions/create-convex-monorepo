import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

it.each(frameworks)(
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

it.each(frameworks)(
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
