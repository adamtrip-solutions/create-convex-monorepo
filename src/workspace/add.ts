import { createHash } from 'node:crypto';
import { scriptCommand, workspaceScript } from '../package-manager/index.js';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { parsers } from 'prettier/plugins/typescript';
import type { ParserOptions } from 'prettier';
import { normalizeOptions } from '../generator/index.js';
import type { Example, Framework } from '../generator/types.js';
import { readText, type Workspace } from './project.js';
import type { ChangePlan } from './changes.js';
import {
  equivalentGeneratedFile,
  formatGeneratedFile,
} from '../generator/format.js';
import { validateProjectName } from '../generator/options.js';
import { versions } from '../templates/versions.js';
import { readBackendEnvironment } from './env.js';
import {
  render,
  initialPlan,
  guardedRead,
  object,
  json,
  retainNewlines,
  metadata,
  type Files,
} from './planning.js';
import {
  deploymentUrl,
  linkEnvironment,
  publicVariable,
} from '../../assets/setup/convex-setup.mjs';

async function verifyWorkspace(workspace: Workspace, plan: ChangePlan) {
  if (workspace.config.packageManager === 'bun') {
    const contents = await guardedRead(workspace, plan, 'package.json');
    const manifest = object(JSON.parse(contents ?? '{}'), 'package.json');
    const patterns = manifest.workspaces;
    if (
      !Array.isArray(patterns) ||
      patterns.length !== 2 ||
      !patterns.includes('apps/*') ||
      !patterns.includes('packages/*')
    )
      throw new Error(
        'Unsupported package.json workspaces configuration. Expected apps/* and packages/* without exclusions or other globs.',
      );
  } else {
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
  }
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
/** Recognize the unmodified pnpm setup helper shipped before Bun support. */
async function isPreBunSetup(source: string | null): Promise<boolean> {
  if (source === null) return false;
  try {
    // Captured from 9feda2a; tests/fixtures/pre-bun-setup.txt preserves the source.
    return (
      createHash('sha256')
        .update(await formatGeneratedFile('scripts/convex-setup.mjs', source))
        .digest('hex') ===
      'c3c2bff852f8f60822acb03b6338cd9e963f094db18487fa9f96da10b72efd63'
    );
  } catch {
    return false;
  }
}

/** Bring pre-Astro workspaces up to the environment contract needed by the new app. */
async function planAstroSupport(
  workspace: Workspace,
  plan: ChangePlan,
  generated: Files,
) {
  const setupPath = 'scripts/convex-setup.mjs';
  const setup = await guardedRead(workspace, plan, setupPath);
  const target = generated.get(setupPath)!;
  const previous = target.replace(
    "    case 'astro':\n      return 'PUBLIC_CONVEX_URL';\n",
    '',
  );
  if (!(await equivalentGeneratedFile(setupPath, setup, target))) {
    if (
      !(await equivalentGeneratedFile(setupPath, setup, previous)) &&
      !(
        workspace.config.packageManager === 'pnpm' &&
        (await isPreBunSetup(setup))
      )
    )
      throw new Error(
        `Conflict in ${setupPath}: restore the generated setup helper before adding Astro so convex:link can recognize PUBLIC_CONVEX_URL. No files were changed.`,
      );
    plan.changes.push({
      path: setupPath,
      before: setup,
      after: retainNewlines(target, setup),
    });
  }
  const turboPath = 'turbo.json';
  const before = await guardedRead(workspace, plan, turboPath);
  if (before === null)
    throw new Error(
      'Missing turbo.json. Restore the workspace task configuration before adding Astro.',
    );
  const turbo = object(JSON.parse(before), turboPath);
  const tasks = { ...object(turbo.tasks, turboPath) };
  let changed = false;
  for (const [task, field] of [
    ['build', 'env'],
    ['dev', 'passThroughEnv'],
  ] as const) {
    const config = { ...object(tasks[task], turboPath) };
    const values = config[field] ?? [];
    if (
      !Array.isArray(values) ||
      values.some((value) => typeof value !== 'string')
    )
      throw new Error(
        `Conflict in turbo.json: tasks.${task}.${field} must be a string array before adding Astro.`,
      );
    if (
      values.includes('!PUBLIC_*') ||
      values.some(
        (value) => typeof value === 'string' && value.startsWith('!PUBLIC_'),
      )
    )
      throw new Error(
        `Conflict in turbo.json: tasks.${task}.${field} excludes Astro public variables. Remove the exclusion before adding Astro.`,
      );
    if (!values.includes('PUBLIC_*')) {
      config[field] = [...values, 'PUBLIC_*'];
      tasks[task] = config;
      changed = true;
    }
  }
  if (changed)
    plan.changes.push({
      path: turboPath,
      before,
      after: json({ ...turbo, tasks }),
    });
  for (const [path, pattern] of [
    ['.gitignore', '.astro/'],
    ['.prettierignore', '**/.astro/'],
  ]) {
    const before = await guardedRead(workspace, plan, path!);
    if (!(before ?? '').split(/\r?\n/).includes(pattern!)) {
      const after = `${before ?? ''}${before && !before.endsWith('\n') ? '\n' : ''}${pattern}\n`;
      plan.changes.push({
        path: path!,
        before,
        after: retainNewlines(after, before),
      });
    }
  }
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
    packageManager: workspace.config.packageManager,
  });
  const app = normalized.apps[0]!;
  if (workspace.config.apps.some((existing) => existing.name === app.name))
    throw new Error(`Application ${app.name} already exists.`);
  if (workspace.config.packages?.some((pkg) => pkg.name === app.name))
    throw new Error(
      `Application name "${app.name}" is already used by a shared package.`,
    );
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
  if (app.framework === 'astro')
    await planAstroSupport(workspace, plan, generated);
  if (example === 'messages') await verifyMessages(workspace, plan, generated);
  if (workspace.config.auth !== 'none') {
    const files =
      workspace.config.auth !== 'convex-auth'
        ? ['auth.config.ts']
        : ['auth.config.ts', 'auth.ts', 'http.ts'];
    const label =
      workspace.config.auth === 'clerk'
        ? 'Clerk'
        : workspace.config.auth === 'workos'
          ? 'WorkOS AuthKit'
          : 'Convex Auth';
    for (const name of files) {
      const path = `packages/backend/convex/${name}`;
      if (
        !(await equivalentGeneratedFile(
          path,
          await guardedRead(workspace, plan, path),
          generated.get(path),
        ))
      )
        throw new Error(`Incompatible ${label} configuration in ${path}.`);
    }
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
  scripts[script] = workspaceScript(
    workspace.config.packageManager,
    workspace.config.name,
    app.name,
    'dev',
  );
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
      `Will link the public Convex URL into ${dir}/.env.local. Run ${workspace.config.packageManager} install before starting the app.`,
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
      `Run ${workspace.config.packageManager} install, then ${scriptCommand(workspace.config.packageManager, 'convex:setup')} or ${scriptCommand(workspace.config.packageManager, 'convex:link')} to configure ${dir}/.env.local.`,
    );
  }
  if (workspace.config.auth === 'clerk')
    plan.notes.push(
      `Add the Clerk keys listed in apps/${app.name}/.env.clerk.example.`,
    );
  if (workspace.config.auth === 'workos')
    plan.notes.push(
      `Add the WorkOS settings listed in apps/${app.name}/.env.workos.example.`,
    );
  return plan;
}

export async function planAddPackage(
  workspace: Workspace,
  options: { name: string },
): Promise<ChangePlan> {
  const { name } = options;
  const error = validateProjectName(name);
  if (error) throw new Error(`Invalid package name "${name}". ${error}`);
  if (['backend', 'typescript-config', 'eslint-config'].includes(name))
    throw new Error(`Package name "${name}" is reserved for a shared package.`);
  if (workspace.config.apps.some((app) => app.name === name))
    throw new Error(
      `Package name "${name}" is already used by an application.`,
    );
  if (workspace.config.packages?.some((pkg) => pkg.name === name))
    throw new Error(`Package ${name} already exists in convex-monorepo.json.`);
  const plan = initialPlan(workspace);
  await verifyWorkspace(workspace, plan);
  const dir = `packages/${name}`;
  plan.absentPaths = [dir];
  await readText(workspace.root, `${dir}/package.json`);
  try {
    await lstat(join(workspace.root, dir));
    throw new Error(`Package path ${dir} already exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const scope = workspace.config.name;
  const packageName = `@${scope}/${name}`;
  const files = {
    'package.json': json({
      name: packageName,
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' },
      devDependencies: {
        typescript: versions.typescript,
        eslint: versions.eslint,
        [`@${scope}/eslint-config`]: 'workspace:*',
        [`@${scope}/typescript-config`]: 'workspace:*',
      },
    }),
    'tsconfig.json': json({
      extends: `@${scope}/typescript-config/base.json`,
      include: ['src'],
    }),
    'eslint.config.js': `export { default } from '@${scope}/eslint-config';\n`,
    'src/index.ts': `// Replace this export with your shared code.\nexport const packageName = '${packageName}';\n`,
  };
  for (const [file, contents] of Object.entries(files)) {
    const path = `${dir}/${file}`;
    plan.changes.push({
      path,
      before: null,
      after: await formatGeneratedFile(path, contents),
    });
  }
  const nextApps = workspace.config.apps.filter(
    (app) => app.framework === 'next',
  );
  if (nextApps.length) {
    const generated = await render(
      workspace,
      workspace.config.apps,
      workspace.config.example,
      workspace.config.auth,
    );
    for (const app of nextApps) {
      const path = `apps/${app.name}/next.config.ts`;
      const before = await guardedRead(workspace, plan, path);
      const baseline = generated.get(path)!;
      let current = null;
      if (before !== null) {
        try {
          current = await formatGeneratedFile(path, before);
        } catch {
          // Invalid configs need a manual edit as well.
        }
      }
      const arrayPattern = /transpilePackages:\s*\[([^\]]*)\]/;
      const array = current?.match(arrayPattern);
      if (
        array &&
        /^(?:\s*'[^']*'\s*(?:,\s*'[^']*'\s*)*,?)?\s*$/.test(array[1]!) &&
        (await equivalentGeneratedFile(
          path,
          current,
          baseline.replace(arrayPattern, () => array[0]),
        ))
      ) {
        const entries: string[] = array[1]!.match(/'[^']*'/g) ?? [];
        if (entries.includes(`'${packageName}'`)) continue;
        entries.push(`'${packageName}'`);
        const after = await formatGeneratedFile(
          path,
          current!.replace(
            arrayPattern,
            () => `transpilePackages: [${entries.join(', ')}]`,
          ),
        );
        plan.changes.push({
          path,
          before,
          after: retainNewlines(after, before),
        });
      } else {
        plan.notes.push(
          `${path} is customized. Add '${packageName}' to transpilePackages before importing it.`,
        );
      }
    }
  }
  await metadata(workspace, plan, {
    packages: [
      ...((workspace.rawConfig.packages as unknown[] | undefined) ?? []),
      { name },
    ],
  });
  plan.notes.push(
    `Add "${packageName}": "workspace:*" to each app that should import it, then run ${workspace.config.packageManager} install.`,
  );
  return plan;
}

class AuthSchemaConflict extends Error {}

async function patchAuthSchema(
  source: string,
  path: string,
): Promise<string | null> {
  // Parse with the formatter's bundled parser so comments, strings and nested
  // expressions cannot be mistaken for the schema call. No project code runs.
  type Node = {
    type?: string;
    name?: string;
    callee?: Node;
    argument?: Node;
    arguments?: Node[];
    body?: Node[];
    declaration?: Node;
    source?: Node;
    specifiers?: Node[];
    imported?: Node;
    local?: Node;
    importKind?: string;
    properties?: Node[];
    key?: Node;
    value?: unknown;
    range?: [number, number];
    [key: string]: unknown;
  };
  const program = (await parsers.typescript.parse(source, {
    filepath: path,
  } as ParserOptions)) as Node;
  const bindings = new Set(
    program.body
      ?.filter(
        (node) =>
          node.type === 'ImportDeclaration' &&
          node.source?.value === 'convex/server' &&
          node.importKind !== 'type',
      )
      .flatMap((node) => node.specifiers ?? [])
      .filter(
        (node) =>
          node.type === 'ImportSpecifier' &&
          node.imported?.name === 'defineSchema' &&
          node.importKind !== 'type' &&
          node.local?.type === 'Identifier',
      )
      .map((node) => node.local!.name!),
  );
  const authTablesBindings = new Set(
    program.body
      ?.filter(
        (node) =>
          node.type === 'ImportDeclaration' &&
          node.source?.value === '@convex-dev/auth/server' &&
          node.importKind !== 'type',
      )
      .flatMap((node) => node.specifiers ?? [])
      .filter(
        (node) =>
          node.type === 'ImportSpecifier' &&
          (node.imported?.name ?? node.imported?.value) === 'authTables' &&
          node.importKind !== 'type' &&
          node.local?.type === 'Identifier',
      )
      .map((node) => node.local!.name!),
  );
  const calls: Node[] = [];
  let declaresAuthTables = false;
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const node = value as Node;
    if (node.type === 'Identifier' && node.name === 'authTables')
      declaresAuthTables = true;
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      bindings.has(node.callee.name!)
    )
      calls.push(node);
    for (const child of Object.values(value)) visit(child);
  }
  visit(program);
  const call = program.body?.find(
    (node) => node.type === 'ExportDefaultDeclaration',
  )?.declaration;
  const argument = call?.arguments?.[0];
  const importOffset = program.body?.[0]?.range?.[0];
  if (
    calls.length !== 1 ||
    calls[0] !== call ||
    call?.arguments?.length !== 1 ||
    argument?.type !== 'ObjectExpression' ||
    !argument.range ||
    importOffset === undefined
  )
    throw new Error('Unsupported schema expression.');
  const hasAuthTables = argument.properties?.some(
    (property) =>
      property.type === 'SpreadElement' &&
      property.argument?.type === 'Identifier' &&
      authTablesBindings.has(property.argument.name!),
  );
  if (hasAuthTables) return null;
  const authTableNames = new Set([
    'users',
    'authSessions',
    'authAccounts',
    'authRefreshTokens',
    'authVerificationCodes',
    'authVerifiers',
    'authRateLimits',
  ]);
  for (const property of argument.properties ?? []) {
    const key = property.key;
    if (
      property.type === 'SpreadElement' ||
      property.computed === true ||
      (key?.type !== 'Identifier' &&
        !(key?.type === 'Literal' && typeof key.value === 'string'))
    )
      throw new AuthSchemaConflict(
        `Conflict in ${path}: the schema contains a spread or computed table name, so Convex Auth tables cannot be merged safely. Add "...authTables" manually and rerun add auth convex-auth. No files were changed.`,
      );
    const name = key?.type === 'Identifier' ? key.name : key?.value;
    if (typeof name === 'string' && authTableNames.has(name))
      throw new AuthSchemaConflict(
        `Conflict in ${path}: table "${name}" collides with Convex Auth. Merge it with the Convex Auth users table definition manually. No files were changed.`,
      );
  }
  if (declaresAuthTables)
    throw new AuthSchemaConflict(
      `Conflict in ${path}: authTables is already declared but not spread into the exported schema. Insert "...authTables," as the first entry of the object passed to defineSchema. No files were changed.`,
    );
  const offset = argument.range[0] + 1;
  return formatGeneratedFile(
    path,
    `${source.slice(0, importOffset)}import { authTables } from '@convex-dev/auth/server';\n${source.slice(importOffset, offset)}\n...authTables,${source.slice(offset)}`,
  );
}

export async function planAddAuth(
  workspace: Workspace,
  provider: 'clerk' | 'convex-auth' | 'workos',
): Promise<ChangePlan> {
  if (
    provider !== 'clerk' &&
    provider !== 'convex-auth' &&
    provider !== 'workos'
  )
    throw new Error(
      'Choose add auth clerk, add auth convex-auth, or add auth workos.',
    );
  const label = (auth: 'clerk' | 'convex-auth' | 'workos') =>
    auth === 'clerk' ? 'Clerk' : auth === 'workos' ? 'WorkOS' : 'Convex Auth';
  if (workspace.config.auth !== 'none' && workspace.config.auth !== provider)
    throw new Error(
      `${label(workspace.config.auth)} is already configured. Switching authentication providers requires a manual migration.`,
    );
  const plan = initialPlan(workspace);
  if (workspace.config.auth === provider) {
    plan.notes.push(`${label(provider)} is already configured.`);
    return plan;
  }
  await verifyWorkspace(workspace, plan);
  normalizeOptions({
    name: workspace.config.name,
    apps: workspace.config.apps,
    example: workspace.config.example,
    auth: provider,
  });
  if (provider === 'workos') {
    for (const app of workspace.config.apps) {
      if (app.framework !== 'next') continue;
      for (const location of ['src/middleware.ts', 'middleware.ts']) {
        const path = `apps/${app.name}/${location}`;
        if ((await guardedRead(workspace, plan, path)) !== null)
          throw new Error(
            `Conflict in ${path}: manually migrate this middleware to apps/${app.name}/src/proxy.ts and integrate WorkOS AuthKit with authkitProxy. Next.js 16 cannot use both middleware.ts and proxy.ts. No files were changed.`,
          );
      }
    }
  }
  const backendBefore = await render(
    workspace,
    workspace.config.apps,
    workspace.config.example,
    'none',
  );
  const backendAfter = await render(
    workspace,
    workspace.config.apps,
    workspace.config.example,
    provider,
  );
  if (provider !== 'convex-auth' && workspace.config.example === 'messages')
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
        (path === 'package.json' || path.endsWith('/package.json')) &&
        current !== null &&
        baseline !== null
      )
        next = mergePackage(current, baseline, target, path);
      else if (!(await equivalentGeneratedFile(path, current, baseline)))
        throw new Error(
          path === 'packages/backend/convex/http.ts'
            ? `Conflict in ${path}: call auth.addHttpRoutes(http) manually in your existing router. No files were changed.`
            : `Conflict in ${path}: file is customized or already exists. No files were changed.`,
        );
      plan.changes.push({
        path,
        before: current,
        after: retainNewlines(next, current),
      });
    }
  }
  await patchFiles(backendBefore, backendAfter, (path) =>
    (provider !== 'convex-auth'
      ? [
          'packages/backend/convex/access.ts',
          'packages/backend/convex/auth.config.ts',
          `packages/backend/.env.${provider}.example`,
        ]
      : [
          'packages/backend/convex/access.ts',
          'packages/backend/convex/auth.ts',
          'packages/backend/convex/http.ts',
          'packages/backend/convex/auth.config.ts',
          'packages/backend/.env.convex-auth.example',
          'packages/backend/package.json',
          'scripts/convex-auth-keys.mjs',
          'package.json',
        ]
    ).includes(path),
  );
  if (provider === 'convex-auth') {
    const path = 'packages/backend/convex/schema.ts';
    const current = await guardedRead(workspace, plan, path);
    let next: string | null;
    if (await equivalentGeneratedFile(path, current, backendBefore.get(path)))
      next = backendAfter.get(path)!;
    else {
      try {
        if (current === null) throw new Error('Missing schema.');
        next = await patchAuthSchema(current, path);
      } catch (error) {
        if (error instanceof AuthSchemaConflict) throw error;
        throw new Error(
          `Conflict in ${path}: add "import { authTables } from '@convex-dev/auth/server';" and insert "...authTables," as the first entry of the object passed to defineSchema. Then rerun add auth convex-auth. No files were changed.`,
        );
      }
    }
    if (next !== null)
      plan.changes.push({
        path,
        before: current,
        after: retainNewlines(next, current),
      });
    const ignorePath = '.gitignore';
    const ignore = await guardedRead(workspace, plan, ignorePath);
    if (
      await equivalentGeneratedFile(
        ignorePath,
        ignore,
        backendBefore.get(ignorePath),
      )
    )
      plan.changes.push({
        path: ignorePath,
        before: ignore,
        after: retainNewlines(backendAfter.get(ignorePath)!, ignore),
      });
    else
      plan.notes.push(
        'Add !.env.convex-auth.example to your customized .gitignore so the backend environment example can be committed.',
      );
    plan.notes.push(
      `Generated types refresh on the next ${scriptCommand(workspace.config.packageManager, 'convex:dev')} or convex codegen. Sign-in needs ${scriptCommand(workspace.config.packageManager, 'convex:auth-keys')}.`,
    );
  }
  if (provider === 'workos') {
    const path = 'turbo.json';
    const current = await guardedRead(workspace, plan, path);
    if (current === null) throw new Error('Missing turbo.json.');
    const config = object(JSON.parse(current), path);
    const tasks = { ...object(config.tasks, path) };
    const beforeTasks = object(
      object(JSON.parse(backendBefore.get(path)!), path).tasks,
      path,
    );
    const afterTasks = object(
      object(JSON.parse(backendAfter.get(path)!), path).tasks,
      path,
    );
    let changed = false;
    for (const name of ['dev', 'build']) {
      const previous = object(beforeTasks[name], path).passThroughEnv;
      const target = object(afterTasks[name], path).passThroughEnv;
      if (tasks[name] === undefined)
        throw new Error(
          `Conflict in ${path}: tasks.${name} is missing. No files were changed.`,
        );
      const task = object(tasks[name], path);
      const existing = task.passThroughEnv;
      if (
        !Array.isArray(previous) ||
        !Array.isArray(target) ||
        (existing !== undefined &&
          (!Array.isArray(existing) ||
            existing.some((value) => typeof value !== 'string')))
      )
        throw new Error(
          `Conflict in ${path}: tasks.${name}.passThroughEnv must be a string array. No files were changed.`,
        );
      const additions = target.filter((value) => !previous.includes(value));
      const values = [...((existing as string[] | undefined) ?? [])];
      for (const value of additions) {
        if (!values.includes(value)) {
          values.push(value);
          changed = true;
        }
      }
      tasks[name] = { ...task, passThroughEnv: values };
    }
    if (changed)
      plan.changes.push({
        path,
        before: current,
        after: retainNewlines(json({ ...config, tasks }), current),
      });
    const ignorePath = '.gitignore';
    const ignore = await guardedRead(workspace, plan, ignorePath);
    if (ignore === null) throw new Error('Missing .gitignore.');
    if (!ignore.split(/\r?\n/).includes('!.env.workos.example'))
      plan.changes.push({
        path: ignorePath,
        before: ignore,
        after: retainNewlines(
          `${ignore.replace(/\r?\n/g, '\n')}${ignore.endsWith('\n') || ignore.length === 0 ? '' : '\n'}!.env.workos.example\n`,
          ignore,
        ),
      });
  }
  for (const app of workspace.config.apps) {
    const example = app.example ?? workspace.config.example;
    const baseline = await render(
      workspace,
      workspace.config.apps,
      example,
      'none',
    );
    const target = await render(
      workspace,
      workspace.config.apps,
      example,
      provider,
    );
    await patchFiles(baseline, target, (path) =>
      path.startsWith(`apps/${app.name}/`),
    );
  }
  const readme = backendAfter.get('README.md')!;
  const start = readme.indexOf(`## ${label(provider)} setup`);
  const end = readme.indexOf('\n## Shared backend types', start);
  if (start === -1 || end === -1)
    throw new Error('Generated authentication setup instructions are missing.');
  const setup = `${readme.slice(start, end).trim()}\n\nRun ${workspace.config.packageManager} install after applying this change.${workspace.config.example === 'messages' ? ' Existing public messages have no owner and will not appear in authenticated accounts. This command does not migrate stored data.' : ''}\n`;
  const setupPath =
    provider === 'clerk'
      ? 'CLERK_SETUP.md'
      : provider === 'workos'
        ? 'WORKOS_SETUP.md'
        : 'CONVEX_AUTH_SETUP.md';
  const existing = await guardedRead(workspace, plan, setupPath);
  if (existing !== null && existing !== setup)
    throw new Error(
      `${setupPath} already exists with different content. No files were changed.`,
    );
  if (existing === null)
    plan.changes.push({ path: setupPath, before: null, after: setup });
  await metadata(workspace, plan, { auth: provider });
  plan.notes.push(
    provider === 'clerk'
      ? `Run ${workspace.config.packageManager} install and follow CLERK_SETUP.md to configure Clerk keys and the Convex issuer.`
      : provider === 'workos'
        ? `Run ${workspace.config.packageManager} install and follow WORKOS_SETUP.md to configure AuthKit and the Convex issuer.`
        : `Run ${workspace.config.packageManager} install, then ${scriptCommand(workspace.config.packageManager, 'convex:auth-keys')}, and follow CONVEX_AUTH_SETUP.md.`,
  );
  return plan;
}
