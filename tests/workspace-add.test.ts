import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  mkdir,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  packageManager: 'pnpm' | 'bun' = 'pnpm',
) {
  const cwd = await mkdtemp(join(tmpdir(), 'ccm-add-test-'));
  temporary.push(cwd);
  const root = await generateProject(
    {
      name: 'sample',
      packageManager,
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

const frameworks: Framework[] = [
  'next',
  'vite',
  'tanstack-start',
  'expo',
  'react-router',
];

async function olderSetupHelper() {
  // Captured with git show main:assets/setup/convex-setup.mjs so this also
  // runs in shallow checkouts without a local main ref.
  const older = await readFile(
    new URL(
      './fixtures/convex-setup-before-react-router.mjs.txt',
      import.meta.url,
    ),
    'utf8',
  );
  return older.replace(/^\s*case ['"]react-router['"]:\r?\n/gm, '');
}

it.each(['react-router', 'expo'] as const)(
  'upgrades an older generated setup helper when adding %s',
  async (framework) => {
    const workspace = await fixture('none');
    const path = 'scripts/convex-setup.mjs';
    const target = await readFile(join(workspace.root, path), 'utf8');
    let older = await olderSetupHelper();
    if (framework === 'expo')
      older = older.replace(
        /    case 'expo':\n      return 'EXPO_PUBLIC_CONVEX_URL';\n/,
        '',
      );
    await writeFile(join(workspace.root, path), older);
    const plan = await planAddApp(workspace, {
      name: 'router',
      framework,
    });
    expect(plan.changes).toContainEqual({ path, before: older, after: target });
    expect(await readFile(join(workspace.root, path), 'utf8')).toBe(older);
    await applyPlan(plan);
    expect(await readFile(join(workspace.root, path), 'utf8')).toBe(target);
    await writeFile(
      join(workspace.root, 'packages/backend/.env.local'),
      'CONVEX_URL=https://test.convex.cloud\n',
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      await realpath(join(workspace.root, path)),
      '--link-only',
    ]);
    expect(stdout).toContain('Linked apps/router/.env.local');
    expect(
      await readFile(join(workspace.root, 'apps/router/.env.local'), 'utf8'),
    ).toBe(
      `${framework === 'expo' ? 'EXPO_PUBLIC' : 'VITE'}_CONVEX_URL=https://test.convex.cloud\n`,
    );
  },
);

describe.each(['pnpm', 'bun'] as const)(
  '%s setup helper guidance',
  (manager) => {
    it.each(['comment', 'mapping', 'extra case', 'invalid syntax'])(
      'preserves a setup helper with a custom %s and explains how to update it',
      async (customization) => {
        const workspace = await fixture('none', 'none', 'vite', manager);
        const path = 'scripts/convex-setup.mjs';
        const older = await olderSetupHelper();
        const customized =
          customization === 'comment'
            ? `${older}\n// Keep our custom setup.\n`
            : customization === 'mapping'
              ? older.replace('VITE_CONVEX_URL', 'CUSTOM_CONVEX_URL')
              : customization === 'extra case'
                ? older.replace(
                    "case 'vite':",
                    "case 'custom':\n    case 'vite':",
                  )
                : `${older}\nsyntax error!\n`;
        await writeFile(join(workspace.root, path), customized);
        const plan = await planAddApp(workspace, {
          name: 'router',
          framework: 'react-router',
        });
        expect(plan.changes.some((change) => change.path === path)).toBe(false);
        expect(plan.notes).toContain(
          `${path} is missing or customized. Copy the current helper from a fresh project or update its framework map to support react-router before running ${manager === 'bun' ? 'bun run' : 'pnpm'} convex:setup or ${manager === 'bun' ? 'bun run' : 'pnpm'} convex:link.`,
        );
        await applyPlan(plan);
        expect(await readFile(join(workspace.root, path), 'utf8')).toBe(
          customized,
        );
      },
    );
  },
);

it.each([
  ['LF with a trailing newline', '\n', true],
  ['CRLF with a trailing newline', '\r\n', true],
  ['LF without a trailing newline', '\n', false],
  ['CRLF without a trailing newline', '\r\n', false],
] as const)(
  'adds React Router artifact settings to a legacy workspace using %s',
  async (_label, newline, trailingNewline) => {
    const workspace = await fixture('none');
    const prettier =
      (await readFile(join(workspace.root, '.prettierignore'), 'utf8'))
        .split('\n')
        .filter(
          (line) => !['**/.react-router/', '**/build/', ''].includes(line),
        )
        .concat(['# Keep our custom output', 'custom-artifacts/'])
        .join(newline) + (trailingNewline ? newline : '');
    await writeFile(join(workspace.root, '.prettierignore'), prettier);
    const eslintPath = join(workspace.root, 'packages/eslint-config/index.js');
    const eslint =
      (await readFile(eslintPath, 'utf8'))
        .replace(/'\*\*\/\.react-router\/\*\*',?\s*/g, '')
        .replace(/'\*\*\/build\/\*\*',?\s*/g, '') +
      '\n// Keep our custom lint configuration.\n';
    await writeFile(eslintPath, eslint);
    const turboPath = join(workspace.root, 'turbo.json');
    const turbo = JSON.parse(await readFile(turboPath, 'utf8'));
    turbo.tasks.build.outputs = turbo.tasks.build.outputs.filter(
      (output: string) => output !== 'build/**',
    );
    turbo.tasks.build.outputs.push('custom-artifacts/**');
    await writeFile(turboPath, JSON.stringify(turbo));
    const gitignorePath = join(workspace.root, '.gitignore');
    await writeFile(
      gitignorePath,
      (await readFile(gitignorePath, 'utf8')).replace(
        /^\.react-router\/\n|^build\/\n/gm,
        '',
      ),
    );
    const before = await snapshot(workspace.root);
    const plan = await planAddApp(workspace, {
      name: 'router',
      framework: 'react-router',
    });
    await applyPlan(plan, { dryRun: true });
    expect(await snapshot(workspace.root)).toEqual(before);
    await applyPlan(plan);
    const after = await snapshot(workspace.root);
    expect(after['.prettierignore']).toBe(
      prettier +
        (trailingNewline ? '' : newline) +
        ['apps/router/.react-router/', 'apps/router/build/', ''].join(newline),
    );
    for (const [path, contents] of Object.entries(before)) {
      if (
        !['package.json', 'convex-monorepo.json', '.prettierignore'].includes(
          path,
        )
      )
        expect(after[path], path).toBe(contents);
    }
    expect(JSON.parse(after['apps/router/turbo.json']!)).toEqual({
      extends: ['//'],
      tasks: { build: { outputs: ['build/**'] } },
    });
    expect(after['apps/router/.gitignore']).toBe('/.react-router/\n/build/\n');
    expect(after['apps/router/eslint.config.js']).toMatch(
      /\{\s*ignores: \['\*\*\/\.react-router\/\*\*', '\*\*\/build\/\*\*'\],?\s*\}/,
    );
  },
);

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
            await writeFile(
              join(workspace.root, 'apps/web/src/app/page.tsx'),
              '// Customized existing page\n',
            );
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
    ['vite', 'tanstack-start', 'next', 'react-router'] as const
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
  expect(files['apps/added-3/vite.config.ts']).toContain('port: 3004');
  expect(JSON.parse(files['apps/added-2/package.json']!).scripts.dev).toBe(
    'next dev --port 3003',
  );
});

it.each(['next', 'vite', 'react-router'] as const)(
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

describe.each<Example>(['none', 'messages'])(
  'add WorkOS with %s content',
  (example) => {
    it.each<Framework>(['next', 'vite', 'tanstack-start'])(
      'adds %s with dry run and repeat no-op',
      async (framework) => {
        const workspace = await fixture(example, 'none', framework);
        const before = await snapshot(workspace.root);
        const plan = await planAddAuth(workspace, 'workos');
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
        expect(after['WORKOS_SETUP.md']).toContain('## WorkOS setup');
        expect(after['WORKOS_SETUP.md']).toContain('WORKOS_COOKIE_NAME');
        expect(after['WORKOS_SETUP.md']).toContain(
          'https://workos.com/docs/authkit/sessions#sign-out-uris',
        );
        if (framework === 'next') {
          expect(after['apps/web/src/proxy.ts']).toContain('authkitProxy');
          expect(after['apps/web/src/middleware.ts']).toBeUndefined();
          expect(after['apps/web/middleware.ts']).toBeUndefined();
        }
        expect(after['apps/web/.env.workos.example']).toBeDefined();
        expect(after['packages/backend/.env.workos.example']).toBeDefined();
        expect(after['apps/web/src/auth-controls.tsx']).toContain('workos');
        if (example === 'messages')
          expect(after['packages/backend/convex/access.ts']).toContain(
            'identity.subject',
          );
        else expect(after['packages/backend/convex/access.ts']).toBeUndefined();
        const turbo = JSON.parse(after['turbo.json']!);
        expect(turbo.tasks.dev.passThroughEnv).toContain('WORKOS_*');
        expect(turbo.tasks.build.passThroughEnv).toContain('WORKOS_*');
        expect(after['.gitignore']).toContain('!.env.workos.example');
        expect(
          (await planAddAuth(await loadWorkspace(workspace.root), 'workos'))
            .changes,
        ).toEqual([]);
      },
    );
  },
);

it.each([
  'apps/web/src/providers.tsx',
  'apps/web/src/auth-controls.tsx',
  'packages/backend/convex/access.ts',
  'packages/backend/convex/auth.config.ts',
])('refuses customized %s when adding WorkOS', async (path) => {
  const workspace = await fixture();
  await writeFile(join(workspace.root, path), '// Custom code\n');
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'workos')).rejects.toThrow(path);
  expect(await snapshot(workspace.root)).toEqual(before);
});

it.each(['src/middleware.ts', 'middleware.ts'])(
  'refuses existing Next.js %s before adding WorkOS without writes',
  async (relativePath) => {
    const workspace = await fixture();
    const path = `apps/web/${relativePath}`;
    await writeFile(
      join(workspace.root, path),
      '// Custom middleware\nexport default function middleware() {}\n',
    );
    const before = await snapshot(workspace.root);
    await expect(planAddAuth(workspace, 'workos')).rejects.toThrow(
      `Conflict in ${path}: manually migrate this middleware to apps/web/src/proxy.ts and integrate WorkOS AuthKit with authkitProxy. Next.js 16 cannot use both middleware.ts and proxy.ts. No files were changed.`,
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

it.each(['src/middleware.ts', 'middleware.ts'])(
  'refuses Next.js %s added after WorkOS planning without writes',
  async (relativePath) => {
    const workspace = await fixture();
    const plan = await planAddAuth(workspace, 'workos');
    const path = `apps/web/${relativePath}`;
    await writeFile(join(workspace.root, path), '// Concurrent middleware\n');
    const before = await snapshot(workspace.root);
    await expect(applyPlan(plan)).rejects.toThrow(
      `Workspace changed while planning: ${path}`,
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

it.each<Auth>(['clerk', 'convex-auth'])(
  'refuses WorkOS replacement of %s',
  async (auth) => {
    const workspace = await fixture('none', auth);
    const before = await snapshot(workspace.root);
    await expect(planAddAuth(workspace, 'workos')).rejects.toThrow(
      'manual migration',
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

it('validates every framework before adding WorkOS', async () => {
  let workspace = await fixture();
  await applyPlan(
    await planAddApp(workspace, { name: 'mobile', framework: 'expo' }),
  );
  workspace = await loadWorkspace(workspace.root);
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'workos')).rejects.toThrow(/expo/i);
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('preserves customized root settings and per-app ports while adding WorkOS', async () => {
  let workspace = await fixture();
  await applyPlan(
    await planAddApp(workspace, {
      name: 'admin',
      framework: 'next',
      example: 'none',
    }),
  );
  workspace = await loadWorkspace(workspace.root);
  const turboPath = join(workspace.root, 'turbo.json');
  const turbo = JSON.parse(await readFile(turboPath, 'utf8'));
  turbo.tasks.dev.passThroughEnv.push('CUSTOM_SECRET');
  turbo.tasks.build.custom = 'preserved';
  await writeFile(turboPath, JSON.stringify(turbo));
  await writeFile(
    join(workspace.root, '.gitignore'),
    '# Custom ignore\n.env*\ncustom-output/\n',
  );
  await applyPlan(await planAddAuth(workspace, 'workos'));
  const after = await snapshot(workspace.root);
  const updated = JSON.parse(after['turbo.json']!);
  expect(updated.tasks.dev.passThroughEnv).toContain('CUSTOM_SECRET');
  expect(updated.tasks.build.custom).toBe('preserved');
  expect(after['.gitignore']).toContain('custom-output/');
  expect(after['apps/admin/.env.workos.example']).toContain('3001');
  expect(after['apps/web/.env.workos.example']).toContain(
    'WORKOS_COOKIE_NAME=wos-session-web\n',
  );
  expect(after['apps/admin/.env.workos.example']).toContain(
    'WORKOS_COOKIE_NAME=wos-session-admin\n',
  );
  expect(after['apps/admin/src/messages.tsx']).toBeUndefined();
});

it('rejects incompatible Turbo environment configuration before adding WorkOS', async () => {
  const workspace = await fixture();
  const path = join(workspace.root, 'turbo.json');
  const turbo = JSON.parse(await readFile(path, 'utf8'));
  turbo.tasks.dev.passThroughEnv = 'CUSTOM_SECRET';
  await writeFile(path, JSON.stringify(turbo));
  const before = await snapshot(workspace.root);
  await expect(planAddAuth(workspace, 'workos')).rejects.toThrow(
    'tasks.dev.passThroughEnv',
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it.each<Framework>(['next', 'vite', 'tanstack-start'])(
  'adds a %s app to a WorkOS workspace',
  async (framework) => {
    const workspace = await fixture('messages', 'workos');
    await applyPlan(await planAddApp(workspace, { name: 'admin', framework }));
    expect(
      (await loadWorkspace(workspace.root)).config.apps.at(-1)?.framework,
    ).toBe(framework);
  },
);

describe.each(['pnpm', 'bun'] as const)(
  'unsupported React Router WorkOS integration with %s',
  (packageManager) => {
    it.each<Example>(['none', 'messages'])(
      'rejects adding WorkOS to React Router with %s without modifying files',
      async (example) => {
        const workspace = await fixture(
          example,
          'none',
          'react-router',
          packageManager,
        );
        const before = await snapshot(workspace.root);
        await expect(planAddAuth(workspace, 'workos')).rejects.toThrow(
          /framework "react-router"/,
        );
        expect(await snapshot(workspace.root)).toEqual(before);
      },
    );
    it.each<Example>(['none', 'messages'])(
      'rejects adding React Router to WorkOS with %s without modifying files',
      async (example) => {
        const workspace = await fixture(
          example,
          'workos',
          'vite',
          packageManager,
        );
        const before = await snapshot(workspace.root);
        await expect(
          planAddApp(workspace, { name: 'router', framework: 'react-router' }),
        ).rejects.toThrow(/framework "react-router"/);
        expect(await snapshot(workspace.root)).toEqual(before);
      },
    );
  },
);

it('rejects adding Expo to a WorkOS workspace', async () => {
  const workspace = await fixture('messages', 'workos');
  await expect(
    planAddApp(workspace, { name: 'mobile', framework: 'expo' }),
  ).rejects.toThrow(/expo/i);
});

describe.each<Example>(['none', 'messages'])(
  'bun workspace with %s starter',
  (example) => {
    it.each(['next', 'react-router'] as const)(
      'adds %s and packages with bun commands and preserves metadata',
      async (framework) => {
        let workspace = await fixture(example, 'none', 'vite', 'bun');
        const appPlan = await planAddApp(workspace, {
          name: 'added',
          framework,
        });
        expect(appPlan.notes.join('\n')).toContain('bun install');
        expect(appPlan.notes.join('\n')).toContain('bun run convex:setup');
        await applyPlan(appPlan);
        workspace = await loadWorkspace(workspace.root);
        expect(workspace.config).toMatchObject({
          version: 1,
          packageManager: 'bun',
        });
        const manifest = JSON.parse(
          await readFile(join(workspace.root, 'package.json'), 'utf8'),
        );
        expect(manifest.scripts['dev:added']).toBe(
          'bun run --filter @sample/added dev',
        );
        const packagePlan = await planAddPackage(workspace, { name: 'shared' });
        expect(packagePlan.notes).toContain(
          'Add "@sample/shared": "workspace:*" to each app that should import it, then run bun install.',
        );
        await applyPlan(packagePlan);
        expect(
          (await loadWorkspace(workspace.root)).config.packageManager,
        ).toBe('bun');
      },
    );
    it.each([
      ['clerk', 'vite'],
      ['convex-auth', 'vite'],
      ['workos', 'vite'],
      ['clerk', 'react-router'],
      ['convex-auth', 'react-router'],
    ] as const)(
      'adds %s to %s with bun setup guidance',
      async (provider, framework) => {
        const workspace = await fixture(example, 'none', framework, 'bun');
        const plan = await planAddAuth(workspace, provider);
        const guide = plan.changes.find((change) =>
          change.path.endsWith('_SETUP.md'),
        )!.after;
        expect(guide).toContain('bun install');
        expect(guide).not.toContain('pnpm');
        expect(plan.notes.join('\n')).toContain('bun install');
        if (provider === 'workos') {
          expect(guide).toContain(
            'bun run --cwd packages/backend convex env set WORKOS_CLIENT_ID',
          );
          expect(guide).toContain('bun run convex:setup');
          expect(plan.notes.join('\n')).toContain('WORKOS_SETUP.md');
        }
        if (provider === 'convex-auth')
          expect(plan.notes.join('\n')).toContain('bun run convex:auth-keys');
        await applyPlan(plan);
        expect((await loadWorkspace(workspace.root)).config).toMatchObject({
          auth: provider,
          packageManager: 'bun',
        });
      },
    );
    it('rejects a customized bun workspace layout before writing', async () => {
      const workspace = await fixture(example, 'none', 'vite', 'bun');
      const path = join(workspace.root, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.workspaces = ['apps/*'];
      await writeFile(path, JSON.stringify(manifest));
      const before = await snapshot(workspace.root);
      await expect(
        planAddPackage(workspace, { name: 'shared' }),
      ).rejects.toThrow('Unsupported package.json workspaces');
      expect(await snapshot(workspace.root)).toEqual(before);
    });
  },
);
it.each(['npm', 'yarn', 'unknown'])(
  'rejects unsupported metadata manager %s',
  async (packageManager) => {
    const workspace = await fixture('none', 'none', 'vite', 'bun');
    expect(() =>
      parseWorkspaceConfig({ ...workspace.rawConfig, packageManager }),
    ).toThrow(
      `Unsupported package manager in convex-monorepo.json: ${packageManager}`,
    );
  },
);
