import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateProject } from '../src/generator/index.js';
import type { Auth, Example, Framework } from '../src/generator/types.js';
import { loadWorkspace } from '../src/workspace/project.js';
import { applyPlan } from '../src/workspace/changes.js';
import { planAddApp, planAddAuth } from '../src/workspace/add.js';

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
    describe.each<Auth>(['none', 'clerk'])('and %s auth', (auth) => {
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
            auth === 'clerk' ? '@clerk/' : 'return null',
          );
          const reloaded = await loadWorkspace(workspace.root);
          expect(reloaded.config.apps).toHaveLength(2);
          await expect(
            planAddApp(reloaded, { name: 'added', framework }),
          ).rejects.toThrow('already exists');
        },
      );
    });
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
