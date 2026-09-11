import { mkdtemp, readdir, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateProject, normalizeOptions } from '../generator/index.js';
import type { Auth, Example, Framework, AppSpec } from '../generator/types.js';
import { readText, type Workspace } from './project.js';
import type { ChangePlan } from './changes.js';
import { equivalentGeneratedFile } from '../generator/format.js';
import { readBackendEnvironment } from './env.js';
import {
  deploymentUrl,
  linkEnvironment,
  publicVariable,
} from '../../assets/setup/convex-setup.mjs';

type Files = Map<string, string>;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const retainNewlines = (text: string, original: string | null) =>
  original?.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;

async function render(
  workspace: Workspace,
  apps: AppSpec[],
  example: Example,
  auth: Auth,
): Promise<Files> {
  const temporary = await mkdtemp(join(tmpdir(), 'ccm-add-'));
  try {
    const root = await generateProject(
      {
        name: workspace.config.name,
        apps,
        example,
        auth,
        install: false,
        git: false,
        initConvex: false,
      },
      { cwd: temporary },
    );
    const files: Files = new Map();
    async function visit(dir: string) {
      for (const entry of await readdir(join(root, dir), {
        withFileTypes: true,
      })) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path);
        else files.set(path, await readFile(join(root, path), 'utf8'));
      }
    }
    await visit('');
    return files;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function initialPlan(workspace: Workspace): ChangePlan {
  return {
    root: workspace.root,
    changes: [],
    notes: [],
    guards: [{ path: 'convex-monorepo.json', contents: workspace.configText }],
  };
}
async function guardedRead(
  workspace: Workspace,
  plan: ChangePlan,
  path: string,
) {
  const contents = await readText(workspace.root, path);
  plan.guards!.push({ path, contents });
  return contents;
}
async function verifyWorkspace(workspace: Workspace, plan: ChangePlan) {
  const yaml = await guardedRead(workspace, plan, 'pnpm-workspace.yaml');
  // Support the generated workspace layout, including comments and unrelated
  // pnpm settings. Refuse aliases, inline lists, exclusions and custom globs.
  const section = yaml?.match(
    /^packages:\s*(?:#.*)?\n((?:[ \t]+[^\n]*\n|\s*\n)*)/m,
  )?.[1];
  const patterns = section
    ?.split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => /^-\s+['"]?(apps\/\*|packages\/\*)['"]?$/.exec(line)?.[1]);
  if (
    (yaml?.match(/^packages:/gm)?.length ?? 0) !== 1 ||
    !patterns ||
    patterns.length !== 2 ||
    !patterns.includes('apps/*') ||
    !patterns.includes('packages/*')
  )
    throw new Error(
      'Unsupported pnpm-workspace.yaml packages configuration. Expected apps/* and packages/* without exclusions or other globs.',
    );
  for (const name of ['backend', 'typescript-config', 'eslint-config']) {
    const path = `packages/${name}/package.json`;
    const contents = await guardedRead(workspace, plan, path);
    const manifest =
      contents === null
        ? null
        : (JSON.parse(contents) as Record<string, unknown>);
    if (manifest?.name !== `@${workspace.config.name}/${name}`)
      throw new Error(
        `Incompatible shared package ${path}. Expected @${workspace.config.name}/${name}.`,
      );
    if (name === 'backend') {
      const expected = {
        './api': {
          types: './convex/_generated/api.d.ts',
          default: './convex/_generated/api.js',
        },
        './dataModel': { types: './convex/_generated/dataModel.d.ts' },
      };
      const actual = manifest.exports as Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(expected)) {
        if (
          Object.entries(value).some(
            ([condition, target]) =>
              object(actual?.[key], path)[condition] !== target,
          )
        )
          throw new Error(
            `Incompatible backend export ${key} in ${path}. Restore the generated backend export before adding an app.`,
          );
      }
    }
  }
}
async function verifyMessages(
  workspace: Workspace,
  plan: ChangePlan,
  baseline: Files,
) {
  for (const name of ['schema.ts', 'messages.ts', 'access.ts']) {
    const path = `packages/backend/convex/${name}`;
    const contents = await guardedRead(workspace, plan, path);
    if (
      contents === null ||
      !(await equivalentGeneratedFile(path, contents, baseline.get(path)))
    )
      throw new Error(
        `Incompatible messages backend: ${path} is missing or customized. Restore the generated messages contract, or add an app with --example none.`,
      );
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Expected an object in ${path}.`);
  return value as Record<string, unknown>;
}
function mergePackage(
  currentText: string,
  beforeText: string,
  afterText: string,
  path: string,
): string {
  const current = object(JSON.parse(currentText), path);
  const before = object(JSON.parse(beforeText), path);
  const after = object(JSON.parse(afterText), path);
  const result = { ...current };
  const groups = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'scripts',
  ];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (!groups.includes(key))
      throw new Error(`Unsupported package change ${path}: ${key}.`);
    const prev = object(before[key], path);
    const next = object(after[key], path);
    const existing = object(current[key], path);
    const merged = { ...existing };
    for (const entry of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (prev[entry] === next[entry]) continue;
      if (next[entry] === undefined)
        throw new Error(`Unsupported package removal ${path}: ${entry}.`);
      if (existing[entry] !== prev[entry] && existing[entry] !== next[entry])
        throw new Error(`Conflict in ${path}: ${key}.${entry} is customized.`);
      if (key !== 'scripts') {
        for (const other of groups.filter(
          (group) => group !== 'scripts' && group !== key,
        )) {
          const value = object(current[other], path)[entry];
          if (value !== undefined && value !== next[entry])
            throw new Error(`Conflicting dependency ${entry} in ${path}.`);
        }
      }
      Object.defineProperty(merged, entry, {
        value: next[entry],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    result[key] = merged;
  }
  return json(result);
}
async function metadata(
  workspace: Workspace,
  plan: ChangePlan,
  patch: Record<string, unknown>,
) {
  plan.changes.push({
    path: 'convex-monorepo.json',
    before: workspace.configText,
    after: json({ ...workspace.rawConfig, ...patch }),
  });
}

export async function planAddApp(
  workspace: Workspace,
  options: { name: string; framework: Framework; example?: Example },
): Promise<ChangePlan> {
  const example = options.example ?? workspace.config.example;
  const normalized = normalizeOptions({
    name: workspace.config.name,
    apps: [{ name: options.name, framework: options.framework }],
    example,
    auth: workspace.config.auth,
  });
  const app = normalized.apps[0]!;
  if (workspace.config.apps.some((existing) => existing.name === app.name))
    throw new Error(`Application ${app.name} already exists.`);
  const plan = initialPlan(workspace);
  await verifyWorkspace(workspace, plan);
  const dir = `apps/${app.name}`;
  plan.absentPaths = [dir];
  // readText checks every parent for symlinks; lstat additionally detects an
  // existing empty directory, which must never become owned by this command.
  await readText(workspace.root, `${dir}/package.json`);
  try {
    await lstat(join(workspace.root, dir));
    throw new Error(`Application path ${dir} already exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const generated = await render(
    workspace,
    [...workspace.config.apps, app],
    example,
    workspace.config.auth,
  );
  const newPort =
    (app.framework === 'expo' ? 8081 : 3000) + workspace.config.apps.length;
  for (const existing of workspace.config.apps) {
    const packagePath = `apps/${existing.name}/package.json`;
    const packageText = await guardedRead(workspace, plan, packagePath);
    if (packageText === null)
      throw new Error(`Missing application manifest: ${packagePath}.`);
    const scripts = object(
      object(JSON.parse(packageText), packagePath).scripts,
      packagePath,
    );
    const dev = typeof scripts.dev === 'string' ? scripts.dev : '';
    const ports = [...dev.matchAll(/--port(?:=|\s+)(\d+)\b/g)].map((match) =>
      Number(match[1]),
    );
    if (
      existing.framework === 'vite' ||
      existing.framework === 'tanstack-start'
    ) {
      const configPath = `apps/${existing.name}/vite.config.ts`;
      const config = await guardedRead(workspace, plan, configPath);
      ports.push(
        ...[...(config ?? '').matchAll(/\bport\s*:\s*(\d+)\b/g)].map((match) =>
          Number(match[1]),
        ),
      );
    }
    if (ports.includes(newPort))
      throw new Error(
        `Development port ${newPort} is already configured in apps/${existing.name}. Choose a different port there before adding this app.`,
      );
  }
  if (example === 'messages') await verifyMessages(workspace, plan, generated);
  if (workspace.config.auth === 'clerk') {
    const path = 'packages/backend/convex/auth.config.ts';
    if (
      !(await equivalentGeneratedFile(
        path,
        await guardedRead(workspace, plan, path),
        generated.get(path),
      ))
    )
      throw new Error(`Incompatible Clerk configuration in ${path}.`);
  }
  for (const [path, after] of generated) {
    if (path.startsWith(`${dir}/`))
      plan.changes.push({ path, before: null, after });
  }
  const path = 'package.json';
  const before = await guardedRead(workspace, plan, path);
  if (before === null) throw new Error('Missing root package.json.');
  const manifest = object(JSON.parse(before), path);
  const scripts = { ...object(manifest.scripts, path) };
  const script = `dev:${app.name}`;
  if (Object.hasOwn(scripts, script))
    throw new Error(`Root script ${script} already exists.`);
  scripts[script] = `pnpm --filter @${workspace.config.name}/${app.name} dev`;
  const previousDev = `turbo run dev --ui=stream --concurrency=${workspace.config.apps.length + 2}`;
  if (scripts.dev !== previousDev)
    throw new Error(
      'Root dev script is customized. Restore the generated Turbo dev script before adding an app.',
    );
  scripts.dev = `turbo run dev --ui=stream --concurrency=${workspace.config.apps.length + 3}`;
  plan.changes.push({ path, before, after: json({ ...manifest, scripts }) });
  const rawApps = workspace.rawConfig.apps as unknown[];
  await metadata(workspace, plan, {
    apps: [
      ...rawApps,
      { ...app, ...(options.example === undefined ? {} : { example }) },
    ],
  });
  const backend = await readBackendEnvironment(workspace);
  plan.guards!.push(...backend.guards);
  if (backend.values.CONVEX_URL) {
    const url = deploymentUrl(backend.values.CONVEX_URL);
    plan.changes.push({
      path: `${dir}/.env.local`,
      before: null,
      after: linkEnvironment('', publicVariable(app.framework), url),
      mode: 0o600,
    });
    plan.notes.push(
      `Will link the public Convex URL into ${dir}/.env.local. Run pnpm install before starting the app.`,
    );
    if (
      app.framework === 'expo' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
    )
      plan.notes.push(
        'Physical phones need a reachable Convex URL. localhost points to the phone itself.',
      );
  } else {
    plan.notes.push(
      `Run pnpm install, then pnpm convex:setup or pnpm convex:link to configure ${dir}/.env.local.`,
    );
  }
  if (workspace.config.auth === 'clerk')
    plan.notes.push(
      `Add the Clerk keys listed in apps/${app.name}/.env.clerk.example.`,
    );
  return plan;
}

export async function planAddAuth(
  workspace: Workspace,
  provider: 'clerk',
): Promise<ChangePlan> {
  if (provider !== 'clerk')
    throw new Error(`Unsupported authentication provider: ${provider}.`);
  const plan = initialPlan(workspace);
  if (workspace.config.auth === 'clerk') {
    plan.notes.push('Clerk is already configured.');
    return plan;
  }
  await verifyWorkspace(workspace, plan);
  const first = workspace.config.apps[0]!;
  const backendBefore = await render(
    workspace,
    [first],
    workspace.config.example,
    'none',
  );
  const backendAfter = await render(
    workspace,
    [first],
    workspace.config.example,
    'clerk',
  );
  if (workspace.config.example === 'messages')
    await verifyMessages(workspace, plan, backendBefore);
  async function patchFiles(
    before: Files,
    after: Files,
    select: (path: string) => boolean,
  ) {
    for (const [path, target] of after) {
      if (!select(path) || before.get(path) === target) continue;
      const baseline = before.get(path) ?? null;
      const current = await readText(workspace.root, path);
      if (await equivalentGeneratedFile(path, current, target)) {
        plan.guards!.push({ path, contents: current });
        continue;
      }
      let next = target;
      if (
        path.endsWith('/package.json') &&
        current !== null &&
        baseline !== null
      )
        next = mergePackage(current, baseline, target, path);
      else if (!(await equivalentGeneratedFile(path, current, baseline)))
        throw new Error(
          `Conflict in ${path}: file is customized or already exists. No files were changed.`,
        );
      plan.changes.push({
        path,
        before: current,
        after: retainNewlines(next, current),
      });
    }
  }
  await patchFiles(backendBefore, backendAfter, (path) =>
    [
      'packages/backend/convex/access.ts',
      'packages/backend/convex/auth.config.ts',
      'packages/backend/.env.clerk.example',
    ].includes(path),
  );
  for (const app of workspace.config.apps) {
    const example = app.example ?? workspace.config.example;
    const baseline = await render(workspace, [app], example, 'none');
    const target = await render(workspace, [app], example, 'clerk');
    await patchFiles(baseline, target, (path) =>
      path.startsWith(`apps/${app.name}/`),
    );
  }
  const readme = backendAfter.get('README.md')!;
  const start = readme.indexOf('## Clerk setup');
  const end = readme.indexOf('\n## Development', start);
  const setup = `${readme.slice(start, end).trim()}\n\nRun pnpm install after applying this change. Existing public messages have no owner and will not appear in authenticated accounts. This command does not migrate stored data.\n`;
  const existing = await readText(workspace.root, 'CLERK_SETUP.md');
  if (existing !== null && existing !== setup)
    throw new Error(
      'CLERK_SETUP.md already exists with different content. No files were changed.',
    );
  if (existing === null)
    plan.changes.push({ path: 'CLERK_SETUP.md', before: null, after: setup });
  await metadata(workspace, plan, { auth: 'clerk' });
  plan.notes.push(
    'Run pnpm install and follow CLERK_SETUP.md to configure Clerk keys and the Convex issuer.',
  );
  return plan;
}
