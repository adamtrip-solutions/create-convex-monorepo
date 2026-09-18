import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { format } from 'prettier';
import { normalizeOptions } from '../dist/index.js';

const apps =
  process.env.CCM_APPS ?? 'next,admin:vite,portal:tanstack-start,expo';
const auth = process.env.CCM_AUTH ?? 'none';
const example = process.env.CCM_EXAMPLE ?? 'messages';
const packageManager = process.env.CCM_PACKAGE_MANAGER ?? 'pnpm';
const workspaceCommands = process.env.CCM_WORKSPACE_COMMANDS === '1';
const selections = normalizeOptions({
  apps,
  auth,
  example,
  packageManager,
}).apps;
const directory = await mkdtemp(join(tmpdir(), 'ccm-e2e-'));
const project = join(directory, 'fixture');
const creation = spawn.sync(
  process.execPath,
  [
    fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)),
    'create',
    'fixture',
    '--apps',
    (workspaceCommands ? selections.slice(0, 1) : selections)
      .map((app) => `${app.name}:${app.framework}`)
      .join(','),
    '--auth',
    workspaceCommands && auth === 'clerk' ? 'none' : auth,
    '--example',
    example,
    '--package-manager',
    packageManager,
    '--no-git',
    '--install',
  ],
  { cwd: directory, stdio: 'inherit', timeout: 600_000 },
);
if (creation.error) throw creation.error;
if (creation.status !== 0)
  throw new Error(`Creation failed; fixture retained at ${project}`);
function run(args) {
  const result = spawn.sync(packageManager, args, {
    cwd: project,
    stdio: 'inherit',
    shell: false,
    timeout: 600_000,
    env: {
      ...process.env,
      CI: '1',
      NEXT_TELEMETRY_DISABLED: '1',
      EXPO_NO_TELEMETRY: '1',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${packageManager} ${args.join(' ')} exited ${result.status}`,
    );
}
function command(args) {
  const result = spawn.sync(
    process.execPath,
    [fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)), ...args],
    {
      cwd: project,
      stdio: 'inherit',
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Workspace command failed: ${args.join(' ')}`);
}
async function snapshot() {
  const files = {};
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        [
          'node_modules',
          '.git',
          '.turbo',
          '.next',
          '.expo',
          '.output',
          'dist',
        ].includes(entry.name)
      )
        continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else if (entry.isFile())
        files[path] = await readFile(join(directory, entry.name), 'utf8');
    }
  }
  await visit(project);
  return JSON.stringify(files);
}

try {
  if (workspaceCommands) {
    await writeFile(
      join(project, 'packages/backend/.env.local'),
      'CONVEX_URL=https://example.convex.cloud\n',
    );
    const before = await snapshot();
    command(['add', 'app', 'dry-run-only', '--framework', 'expo', '--dry-run']);
    if ((await snapshot()) !== before)
      throw new Error('Dry-run changed workspace files');
    // Exercise migration of all four existing apps, and adding apps after auth setup.
    if (example === 'none' && auth === 'clerk')
      command(['add', 'auth', 'clerk', '--no-install']);
    for (const app of selections.slice(1))
      command([
        'add',
        'app',
        app.name,
        '--framework',
        app.framework,
        '--no-install',
      ]);
    const beforePackage = await snapshot();
    command(['add', 'package', 'shared', '--dry-run']);
    if ((await snapshot()) !== beforePackage)
      throw new Error('Package dry-run changed workspace files');
    command(['add', 'package', 'shared', '--no-install']);
    if (example !== 'none' && auth === 'clerk')
      command(['add', 'auth', 'clerk', '--no-install']);
    command(['env', 'sync']);
    const linked = await snapshot();
    command(['env', 'sync', '--dry-run']);
    if ((await snapshot()) !== linked)
      throw new Error('Environment dry-run changed files');
  }
  const config = JSON.parse(
    await readFile(join(project, 'convex-monorepo.json'), 'utf8'),
  );
  for (const app of config.apps) {
    if (workspaceCommands) {
      const packagePath = join(project, 'apps', app.name, 'package.json');
      const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
      manifest.dependencies['@fixture/shared'] = 'workspace:*';
      await writeFile(
        packagePath,
        await format(JSON.stringify(manifest), { parser: 'json' }),
      );
      await writeFile(
        join(project, 'apps', app.name, 'src/shared.type-test.ts'),
        "import { packageName } from '@fixture/shared';\nexport const shared: string = packageName;\n",
      );
      const entryPath = join(
        project,
        'apps',
        app.name,
        {
          next: 'src/app/page.tsx',
          vite: 'src/main.tsx',
          'tanstack-start': 'src/routes/index.tsx',
          expo: 'App.tsx',
        }[app.framework],
      );
      const entry = await readFile(entryPath, 'utf8');
      const sharedElement =
        app.framework === 'expo'
          ? '<SharedText>{packageName}</SharedText>'
          : '<p>{packageName}</p>';
      if (!entry.includes('</Providers>'))
        throw new Error(`Missing Providers element in ${entryPath}`);
      await writeFile(
        entryPath,
        await format(
          "import { packageName } from '@fixture/shared';\n" +
            (app.framework === 'expo'
              ? "import { Text as SharedText } from 'react-native';\n"
              : '') +
            entry.replace('</Providers>', `${sharedElement}</Providers>`),
          { parser: 'typescript', singleQuote: true, trailingComma: 'all' },
        ),
      );
    }
    if (example === 'none') {
      // Keep starter assertions here so adding a user's first function does not break their project.
      await writeFile(
        join(project, 'apps', app.name, 'src/blank.type-test.ts'),
        await format(
          `
import type { api } from '@fixture/backend/api';
import type { DataModel, TableNames } from '@fixture/backend/dataModel';
type Assert<T extends true> = T;
type IsAny<T> = 0 extends (1 & T) ? true : false;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type ApiIsTyped = Assert<Equal<IsAny<typeof api>, false>>;
${
  auth === 'convex-auth'
    ? `export type AuthApiExists = Assert<Equal<'auth' extends keyof typeof api ? true : false, true>>;
export type AuthUsersExist = Assert<Equal<'users' extends TableNames ? true : false, true>>;
export type NoMessages = Assert<Equal<'messages' extends TableNames ? true : false, false>>;
// @ts-expect-error No messages example has been defined.
export type MissingMessages = typeof api.messages;`
    : `export type ApiIsEmpty = Assert<Equal<keyof typeof api, never>>;
export type TablesAreEmpty = Assert<Equal<TableNames, never>>;`
}

export type ModelIsTyped = Assert<Equal<IsAny<DataModel>, false>>;
// @ts-expect-error This module has not been defined.
export type MissingModule = typeof api.notAModule;
`,
          { parser: 'typescript', singleQuote: true, trailingComma: 'all' },
        ),
      );
    }
    const prefix =
      app.framework === 'next'
        ? 'NEXT_PUBLIC'
        : app.framework === 'expo'
          ? 'EXPO_PUBLIC'
          : 'VITE';
    // Syntactically valid test configuration, no deployment or identity-provider credentials.
    const lines = [`${prefix}_CONVEX_URL=https://example.convex.cloud`];
    if (auth === 'clerk') {
      lines.push(
        `${prefix}_CLERK_PUBLISHABLE_KEY=pk_test_${Buffer.from('test.clerk.accounts.dev$').toString('base64')}`,
      );
      if (app.framework === 'next' || app.framework === 'tanstack-start')
        lines.push('CLERK_SECRET_KEY=sk_test_not_a_real_secret');
    }
    if (auth === 'workos') {
      lines.push(`${prefix}_WORKOS_CLIENT_ID=client_test_fixture`);
      const server = app.framework !== 'vite';
      const redirectVariable =
        app.framework === 'tanstack-start'
          ? 'WORKOS_REDIRECT_URI'
          : `${prefix}_WORKOS_REDIRECT_URI`;
      lines.push(
        `${redirectVariable}=http://localhost:${3000 + config.apps.indexOf(app)}${server ? '/callback' : '/'}`,
      );
      if (server)
        lines.push(
          'WORKOS_CLIENT_ID=client_test_fixture',
          `WORKOS_COOKIE_NAME=wos-session-${app.name}`,
          'WORKOS_API_KEY=sk_test_not_a_real_secret',
          'WORKOS_COOKIE_PASSWORD=not-a-real-cookie-password-32-characters',
        );
    }
    await writeFile(
      join(project, 'apps', app.name, '.env.local'),
      lines.join('\n') + '\n',
    );
  }
  if (workspaceCommands)
    run(
      packageManager === 'bun'
        ? ['install']
        : ['install', '--no-frozen-lockfile'],
    );
  run(['run', 'format:check']);
  if (workspaceCommands) command(['doctor', '--json']);
  run(['run', 'typecheck']);
  run(['run', 'lint']);
  run(['run', 'build']);
  for (const app of config.apps) {
    const output = join(
      project,
      'apps',
      app.name,
      app.framework === 'next'
        ? '.next/static'
        : app.framework === 'tanstack-start'
          ? 'dist/client'
          : 'dist',
    );
    for (const file of await readdir(output, { recursive: true })) {
      if (!/\.(?:js|hbc)$/.test(file)) continue;
      const contents = await readFile(join(output, file));
      for (const forbidden of [
        'Messages must contain 1 to 1000 characters.',
        'by_owner',
        'sk_test_not_a_real_secret',
        'not-a-real-cookie-password-32-characters',
      ]) {
        if (contents.includes(Buffer.from(forbidden)))
          throw new Error(
            `Backend implementation or secret appeared in ${app.name}/${file}`,
          );
      }
    }
  }
  console.log(
    `PASS ${workspaceCommands ? 'workspace commands' : 'generated'} ${apps} / ${auth} / ${example} / ${packageManager}`,
  );
} catch (error) {
  console.error(`Fixture retained at ${project}`);
  process.exitCode = 1;
  throw error;
} finally {
  if (!process.exitCode && !process.env.CCM_KEEP_FIXTURE)
    await rm(directory, { recursive: true, force: true });
}
