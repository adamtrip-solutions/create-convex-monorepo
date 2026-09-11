import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { generateProject } from '../src/generator/index.js';
import { versions } from '../src/templates/versions.js';
import { getPackageVersion } from '../src/version.js';
import { planAddApp } from '../src/workspace/add.js';
import { applyPlan } from '../src/workspace/changes.js';
import { loadWorkspace } from '../src/workspace/project.js';
import { planUpgrade } from '../src/workspace/upgrade.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'ccm-upgrade-test-'));
  temporary.push(cwd);
  const root = await generateProject(
    {
      name: 'sample',
      apps: 'web:next,mobile:expo',
      auth: 'clerk',
      example: 'messages',
      install: false,
      git: false,
    },
    { cwd },
  );
  return loadWorkspace(root);
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files[path.slice(root.length + 1)] = await readFile(path, 'utf8');
    }
  }
  return files;
}
async function edit(
  root: string,
  path: string,
  change: (pkg: {
    [key: string]: unknown;
    dependencies: Record<string, unknown>;
    devDependencies: Record<string, unknown>;
    scripts: Record<string, string>;
  }) => void,
  crlf = false,
) {
  const file = join(root, path);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  change(pkg);
  const text = `${JSON.stringify(pkg, null, 2)}\n`;
  await writeFile(file, crlf ? text.replace(/\n/g, '\r\n') : text);
  return pkg;
}

it('upgrades stale pins and metadata while preserving unrelated content, key order, and CRLF', async () => {
  let workspace = await fixture();
  await edit(
    workspace.root,
    'convex-monorepo.json',
    (pkg) => {
      pkg.generator = '0.0.1';
      pkg.custom = { keep: true };
    },
    true,
  );
  const rootBefore = await edit(
    workspace.root,
    'package.json',
    (pkg) => {
      pkg.devDependencies.turbo = '1.0.0';
      pkg.devDependencies['user-added'] = '^2.0.0';
      pkg.scripts.custom = 'echo keep';
      pkg.custom = { z: 1, a: 2 };
    },
    true,
  );
  const appBefore = await edit(
    workspace.root,
    'apps/web/package.json',
    (pkg) => {
      pkg.dependencies.convex = '1.44.0';
      pkg.dependencies['@sample/backend'] = 'workspace:^';
      pkg.scripts.dev = 'custom dev command';
    },
    true,
  );
  await edit(
    workspace.root,
    'packages/backend/package.json',
    (pkg) => {
      pkg.dependencies.convex = '1.44.0';
    },
    true,
  );
  await writeFile(join(workspace.root, 'pnpm-lock.yaml'), '# keep lockfile\n');
  await writeFile(
    join(workspace.root, 'apps/web/.env.local'),
    'SECRET=never-print\n',
  );
  workspace = await loadWorkspace(workspace.root);
  const before = await snapshot(workspace.root);
  const plan = await planUpgrade(workspace);
  expect(await snapshot(workspace.root)).toEqual(before);
  expect(plan.changes.map(({ path }) => path)).toEqual([
    'package.json',
    'apps/web/package.json',
    'packages/backend/package.json',
    'convex-monorepo.json',
  ]);
  expect(plan.notes).toContain(
    'Run pnpm install to update the lockfile, then run doctor.',
  );
  await applyPlan(plan);
  const after = await snapshot(workspace.root);
  for (const [path, text] of Object.entries(before)) {
    if (!plan.changes.some((change) => change.path === path))
      expect(after[path], path).toBe(text);
    else expect(after[path], path).not.toMatch(/(?<!\r)\n/);
  }
  const rootAfter = JSON.parse(after['package.json']!);
  expect(rootAfter).toEqual({
    ...rootBefore,
    devDependencies: { ...rootBefore.devDependencies, turbo: versions.turbo },
  });
  expect(Object.keys(rootAfter)).toEqual(Object.keys(rootBefore));
  expect(Object.keys(rootAfter.devDependencies)).toEqual(
    Object.keys(rootBefore.devDependencies),
  );
  expect(JSON.parse(after['apps/web/package.json']!)).toEqual({
    ...appBefore,
    dependencies: { ...appBefore.dependencies, convex: versions.convex },
  });
  expect(
    JSON.parse(after['packages/backend/package.json']!).dependencies.convex,
  ).toBe(versions.convex);
  expect(JSON.parse(after['convex-monorepo.json']!)).toEqual({
    ...JSON.parse(before['convex-monorepo.json']!),
    generator: await getPackageVersion(),
  });
  expect(
    (await planUpgrade(await loadWorkspace(workspace.root))).changes,
  ).toEqual([]);
});

it('leaves an up-to-date workspace untouched, including customized JSON formatting', async () => {
  const workspace = await fixture();
  const path = join(workspace.root, 'package.json');
  await writeFile(
    path,
    JSON.stringify(JSON.parse(await readFile(path, 'utf8'))),
  );
  const before = await snapshot(workspace.root);
  const plan = await planUpgrade(workspace);
  expect(plan.changes).toEqual([]);
  await applyPlan(plan);
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('bumps only stale generator metadata and then becomes a no-op', async () => {
  const workspace = await fixture();
  await edit(workspace.root, 'convex-monorepo.json', (pkg) => {
    pkg.generator = '0.0.1';
  });
  const plan = await planUpgrade(await loadWorkspace(workspace.root));
  expect(plan.changes.map(({ path }) => path)).toEqual([
    'convex-monorepo.json',
  ]);
  await applyPlan(plan);
  expect(
    (await planUpgrade(await loadWorkspace(workspace.root))).changes,
  ).toEqual([]);
});

it('collects conflicts across manifests and aborts without writes', async () => {
  const workspace = await fixture();
  await edit(workspace.root, 'package.json', (pkg) => {
    pkg.devDependencies.turbo = '^1.0.0';
    pkg.packageManager = 'pnpm@latest';
  });
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.dependencies.convex = '^1.44.0';
  });
  await edit(workspace.root, 'packages/backend/package.json', (pkg) => {
    pkg.dependencies.convex = '1.44.0';
  });
  const before = await snapshot(workspace.root);
  const result = planUpgrade(workspace);
  await expect(result).rejects.toThrow(
    'package.json: devDependencies.turbo = ^1.0.0',
  );
  await expect(result).rejects.toThrow(
    'package.json: packageManager = pnpm@latest',
  );
  await expect(result).rejects.toThrow(
    'apps/web/package.json: dependencies.convex = ^1.44.0',
  );
  await expect(result).rejects.toThrow(
    'Pin these to exact versions or remove the customization, then run upgrade again. No files were changed.',
  );
  expect(await snapshot(workspace.root)).toEqual(before);
});

it.each([
  '~1.0.0',
  '>=1.0.0',
  '1.0.0 || 2.0.0',
  'latest',
  'workspace:*',
  'git+https://example.com/repo',
  'file:../local',
  'npm:other@1.0.0',
  '1.0.0-01',
  null,
])('rejects non-exact managed pin %s', async (value) => {
  const workspace = await fixture();
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.dependencies.convex = value;
  });
  await expect(planUpgrade(workspace)).rejects.toThrow(
    'apps/web/package.json: dependencies.convex =',
  );
});

it.each(['99.0.0', '99.0.0-rc.1'])(
  'keeps newer exact pin %s and reports it',
  async (value) => {
    const workspace = await fixture();
    await edit(workspace.root, 'apps/web/package.json', (pkg) => {
      pkg.dependencies.convex = value;
    });
    const plan = await planUpgrade(workspace);
    expect(plan.changes).toEqual([]);
    expect(plan.notes).toContain(
      `Kept convex@${value} in apps/web/package.json; it is newer than the tested ${versions.convex}.`,
    );
  },
);

it('upgrades a prerelease to the same core stable version', async () => {
  const workspace = await fixture();
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.dependencies.convex = `${versions.convex}-rc.1`;
  });
  await applyPlan(await planUpgrade(workspace));
  expect(
    JSON.parse(
      await readFile(join(workspace.root, 'apps/web/package.json'), 'utf8'),
    ).dependencies.convex,
  ).toBe(versions.convex);
});

it.each([
  'pnpm@1.0.0',
  'pnpm@99.0.0',
  'pnpm@10.34.5-rc.1',
  'pnpm@99.0.0-rc.1',
  'pnpm@10.34.5+build.1',
  'pnpm@latest',
  'npm@10.34.5',
  'pnpm@10.34.5-01',
  undefined,
])('handles packageManager %s', async (value) => {
  const workspace = await fixture();
  await edit(workspace.root, 'package.json', (pkg) => {
    pkg.packageManager = value;
  });
  const before = await snapshot(workspace.root);
  if (
    value === 'pnpm@latest' ||
    value === 'npm@10.34.5' ||
    value === 'pnpm@10.34.5-01'
  ) {
    await expect(planUpgrade(workspace)).rejects.toThrow(
      `package.json: packageManager = ${value}`,
    );
    expect(await snapshot(workspace.root)).toEqual(before);
    return;
  }
  const plan = await planUpgrade(workspace);
  if (value === undefined)
    expect(plan.notes).toContain(
      'package.json is missing packageManager. Add it manually if needed.',
    );
  if (value === 'pnpm@99.0.0' || value === 'pnpm@99.0.0-rc.1')
    expect(plan.notes).toContain(
      `Kept ${value} in package.json; it is newer than the tested ${versions.pnpm}.`,
    );
  if (value === 'pnpm@10.34.5+build.1') {
    expect(plan.changes).toEqual([]);
    expect(plan.notes).toEqual([
      'Template files are not migrated; review the release notes for manual changes.',
    ]);
  }
  await applyPlan(plan);
  expect(
    JSON.parse(await readFile(join(workspace.root, 'package.json'), 'utf8'))
      .packageManager,
  ).toBe(
    value === 'pnpm@1.0.0' || value === 'pnpm@10.34.5-rc.1'
      ? `pnpm@${versions.pnpm}`
      : value,
  );
});

it('reports missing tested dependencies without adding them or moving groups', async () => {
  const workspace = await fixture();
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    delete pkg.dependencies.convex;
    delete pkg.dependencies.react;
    pkg.optionalDependencies = { convex: '1.44.0' };
  });
  const before = await snapshot(workspace.root);
  const plan = await planUpgrade(workspace);
  expect(plan.changes.map(({ path }) => path)).toEqual([
    'apps/web/package.json',
  ]);
  expect(
    plan.notes.filter((note) => note.includes('missing tested dependencies')),
  ).toEqual([
    'apps/web/package.json is missing tested dependencies: react. Add them manually if needed.',
  ]);
  await applyPlan(plan);
  const after = await snapshot(workspace.root);
  expect(JSON.parse(after['apps/web/package.json']!)).toEqual({
    ...JSON.parse(before['apps/web/package.json']!),
    optionalDependencies: { convex: versions.convex },
  });
  expect({
    ...after,
    'apps/web/package.json': before['apps/web/package.json'],
  }).toEqual(before);
});

it.each(['devDependencies', 'peerDependencies', 'optionalDependencies'])(
  'rejects a managed range in %s even when dependencies has a stale exact pin',
  async (group) => {
    const workspace = await fixture();
    await edit(workspace.root, 'apps/web/package.json', (pkg) => {
      pkg.dependencies.convex = '1.44.0';
      pkg[group] = {
        ...(pkg[group] as Record<string, unknown>),
        convex: '^1.0.0',
      };
    });
    const before = await snapshot(workspace.root);
    await expect(planUpgrade(workspace)).rejects.toThrow(
      `apps/web/package.json: ${group}.convex = ^1.0.0`,
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  },
);

it.each(['devDependencies', 'peerDependencies', 'optionalDependencies'])(
  'upgrades a stale exact pin moved to %s in place',
  async (group) => {
    const workspace = await fixture();
    const before = await edit(
      workspace.root,
      'apps/web/package.json',
      (pkg) => {
        delete pkg.dependencies.convex;
        pkg[group] = {
          ...(pkg[group] as Record<string, unknown>),
          convex: '1.44.0',
        };
      },
    );
    const plan = await planUpgrade(workspace);
    expect(
      plan.notes.some((note) => note.includes('missing tested dependencies')),
    ).toBe(false);
    await applyPlan(plan);
    expect(
      JSON.parse(
        await readFile(join(workspace.root, 'apps/web/package.json'), 'utf8'),
      ),
    ).toEqual({
      ...before,
      [group]: {
        ...(before[group] as Record<string, unknown>),
        convex: versions.convex,
      },
    });
  },
);

it('upgrades the same managed package in both dependency groups', async () => {
  const workspace = await fixture();
  const before = await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.dependencies.convex = '1.44.0';
    pkg.optionalDependencies = { convex: '1.0.0' };
  });
  await applyPlan(await planUpgrade(workspace));
  expect(
    JSON.parse(
      await readFile(join(workspace.root, 'apps/web/package.json'), 'utf8'),
    ),
  ).toEqual({
    ...before,
    dependencies: { ...before.dependencies, convex: versions.convex },
    optionalDependencies: { convex: versions.convex },
  });
});

it.each(['99.0.0', '99.0.0-rc.1'])(
  'refuses a workspace generated by newer CLI %s',
  async (value) => {
    const workspace = await fixture();
    await edit(workspace.root, 'convex-monorepo.json', (pkg) => {
      pkg.generator = value;
    });
    await expect(
      planUpgrade(await loadWorkspace(workspace.root)),
    ).rejects.toThrow(
      `This workspace was generated by a newer CLI (${value}). Upgrade the CLI first.`,
    );
  },
);

it('refuses unsupported package managers explicitly', async () => {
  const workspace = await fixture();
  // Exercise the planner's runtime guard independently of metadata validation.
  Object.assign(workspace.config, { packageManager: 'npm' });
  await expect(planUpgrade(workspace)).rejects.toThrow('Only pnpm workspaces');
});

it.each([
  'package.json',
  'apps/web/package.json',
  'packages/backend/package.json',
  'packages/typescript-config/package.json',
  'packages/eslint-config/package.json',
])('names a missing manifest %s', async (path) => {
  const workspace = await fixture();
  await rm(join(workspace.root, path));
  await expect(planUpgrade(workspace)).rejects.toThrow(
    `Missing manifest: ${path}.`,
  );
});

it.each(['{', '[]', 'null', '{"dependencies":[]}'])(
  'rejects malformed manifest %s',
  async (contents) => {
    const workspace = await fixture();
    await writeFile(join(workspace.root, 'apps/web/package.json'), contents);
    await expect(planUpgrade(workspace)).rejects.toThrow(
      /JSON in apps\/web\/package.json|object in apps\/web\/package.json/,
    );
  },
);

it('dry-runs without writes and guards even manifests that needed no update', async () => {
  const workspace = await fixture();
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.dependencies.convex = '1.44.0';
  });
  const before = await snapshot(workspace.root);
  const plan = await planUpgrade(workspace);
  await applyPlan(plan, { dryRun: true });
  expect(await snapshot(workspace.root)).toEqual(before);
  await edit(
    workspace.root,
    'packages/typescript-config/package.json',
    (pkg) => {
      pkg.custom = true;
    },
  );
  const concurrent = await snapshot(workspace.root);
  await expect(applyPlan(plan, { dryRun: true })).rejects.toThrow(
    'Workspace changed while planning: packages/typescript-config/package.json',
  );
  await expect(applyPlan(plan)).rejects.toThrow(
    'Workspace changed while planning',
  );
  expect(await snapshot(workspace.root)).toEqual(concurrent);
});

it('guards changed manifests and metadata after planning', async () => {
  const workspace = await fixture();
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.dependencies.convex = '1.44.0';
  });
  const plan = await planUpgrade(workspace);
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.custom = true;
  });
  const before = await snapshot(workspace.root);
  await expect(applyPlan(plan)).rejects.toThrow(
    'Workspace changed while planning: apps/web/package.json',
  );
  expect(await snapshot(workspace.root)).toEqual(before);
  const next = await planUpgrade(workspace);
  await edit(workspace.root, 'convex-monorepo.json', (pkg) => {
    pkg.custom = true;
  });
  await expect(applyPlan(next)).rejects.toThrow(
    'Workspace changed while planning: convex-monorepo.json',
  );
});

it('rolls back an upgrade interrupted after its first write', async () => {
  const workspace = await fixture();
  await edit(workspace.root, 'apps/web/package.json', (pkg) => {
    pkg.dependencies.convex = '1.44.0';
  });
  await edit(workspace.root, 'packages/backend/package.json', (pkg) => {
    pkg.dependencies.convex = '1.44.0';
  });
  const before = await snapshot(workspace.root);
  const controller = new AbortController();
  await expect(
    applyPlan(await planUpgrade(workspace), {
      signal: controller.signal,
      onProgress() {
        controller.abort(new Error('Interrupted'));
      },
    }),
  ).rejects.toThrow('Interrupted');
  expect(await snapshot(workspace.root)).toEqual(before);
});

it('preserves mixed per-app examples and their Clerk dependencies', async () => {
  let workspace = await fixture();
  await applyPlan(
    await planAddApp(workspace, {
      name: 'blank',
      framework: 'vite',
      example: 'none',
    }),
  );
  workspace = await loadWorkspace(workspace.root);
  await edit(workspace.root, 'apps/blank/package.json', (pkg) => {
    pkg.dependencies['@clerk/react'] = '1.0.0';
  });
  const before = await snapshot(workspace.root);
  const plan = await planUpgrade(workspace);
  expect(
    plan.notes.some((note) => note.includes('missing tested dependencies')),
  ).toBe(false);
  await applyPlan(plan);
  const after = await snapshot(workspace.root);
  expect(
    JSON.parse(after['apps/blank/package.json']!).dependencies['@clerk/react'],
  ).toBe(versions.clerkReact);
  expect(after['convex-monorepo.json']).toBe(before['convex-monorepo.json']);
  expect(
    (await loadWorkspace(workspace.root)).config.apps.at(-1)?.example,
  ).toBe('none');
  expect(
    (await planUpgrade(await loadWorkspace(workspace.root))).changes,
  ).toEqual([]);
});
