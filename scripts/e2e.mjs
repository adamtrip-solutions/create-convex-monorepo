import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';
import { format } from 'prettier';
import * as sveltePlugin from 'prettier-plugin-svelte';
import { normalizeOptions } from '../dist/index.js';

const apps =
  process.env.CCM_APPS ??
  'next,admin:vite,portal:tanstack-start,router:react-router,expo';
const auth = process.env.CCM_AUTH ?? 'none';
const oauth = process.env.CCM_OAUTH || undefined;
const example = process.env.CCM_EXAMPLE ?? 'messages';
const packageManager = process.env.CCM_PACKAGE_MANAGER ?? 'pnpm';
const workspaceCommands = process.env.CCM_WORKSPACE_COMMANDS === '1';
const selections = normalizeOptions({
  apps,
  auth,
  example,
  ...(oauth ? { oauth } : {}),
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
    ...(oauth ? ['--oauth', oauth] : []),
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
      ASTRO_TELEMETRY_DISABLED: '1',
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
          '.nuxt',
          '.expo',
          '.output',
          '.svelte-kit',
          '.react-router',
          'build',
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
    // Exercise migration of all existing apps, and adding apps after auth setup.
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
          'react-router': 'app/root.tsx',
          expo: 'App.tsx',
          nuxt: 'src/app.vue',
          sveltekit: 'src/routes/+page.svelte',
          astro: 'src/App.tsx',
        }[app.framework],
      );
      const entry = await readFile(entryPath, 'utf8');
      if (app.framework === 'sveltekit') {
        if (!entry.includes('<script lang="ts">'))
          throw new Error(`Missing TypeScript script in ${entryPath}`);
        await writeFile(
          entryPath,
          await format(
            entry.replace(
              '<script lang="ts">',
              '<script lang="ts">\n  import { packageName } from "@fixture/shared";',
            ) + '\n<p>{packageName}</p>\n',
            {
              parser: 'svelte',
              plugins: [sveltePlugin],
              singleQuote: true,
              trailingComma: 'all',
            },
          ),
        );
      } else {
        const sharedElement =
          app.framework === 'expo'
            ? '<SharedText>{packageName}</SharedText>'
            : app.framework === 'nuxt'
              ? '<p>{{ packageName }}</p>'
              : '<p>{packageName}</p>';
        if (!entry.includes('</Providers>'))
          throw new Error(`Missing Providers element in ${entryPath}`);
        await writeFile(
          entryPath,
          await format(
            app.framework === 'nuxt'
              ? entry
                  .replace(
                    '<script setup lang="ts">',
                    '<script setup lang="ts">\nimport { packageName } from "@fixture/shared";',
                  )
                  .replace('</Providers>', `${sharedElement}</Providers>`)
              : "import { packageName } from '@fixture/shared';\n" +
                  (app.framework === 'expo'
                    ? "import { Text as SharedText } from 'react-native';\n"
                    : '') +
                  entry.replace('</Providers>', `${sharedElement}</Providers>`),
            {
              parser: app.framework === 'nuxt' ? 'vue' : 'typescript',
              singleQuote: true,
              trailingComma: 'all',
            },
          ),
        );
      }
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
    : auth === 'better-auth'
      ? `export type AuthApiExists = Assert<Equal<keyof typeof api, 'auth'>>;
export type CurrentUserExists = Assert<Equal<keyof typeof api.auth, 'getCurrentUser'>>;
export type TablesAreEmpty = Assert<Equal<TableNames, never>>;
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
      app.framework === 'nuxt'
        ? 'NUXT_PUBLIC'
        : app.framework === 'next'
          ? 'NEXT_PUBLIC'
          : app.framework === 'expo'
            ? 'EXPO_PUBLIC'
            : app.framework === 'astro' || app.framework === 'sveltekit'
              ? 'PUBLIC'
              : 'VITE';
    // Syntactically valid test configuration, no deployment or identity-provider credentials.
    const lines = [`${prefix}_CONVEX_URL=https://example.convex.cloud`];
    if (auth === 'better-auth')
      lines.push(`${prefix}_CONVEX_SITE_URL=https://example.convex.site`);
    if (auth === 'clerk') {
      lines.push(
        `${prefix}_CLERK_PUBLISHABLE_KEY=pk_test_${Buffer.from('test.clerk.accounts.dev$').toString('base64')}`,
      );
      if (
        app.framework === 'next' ||
        app.framework === 'tanstack-start' ||
        app.framework === 'react-router'
      )
        lines.push('CLERK_SECRET_KEY=sk_test_not_a_real_secret');
    }
    if (auth === 'workos' && app.framework === 'expo')
      lines.push(
        `${prefix}_WORKOS_CLIENT_ID=client_test_fixture`,
        `${prefix}_WORKOS_REDIRECT_URI=ccm-fixture-${app.name}://callback`,
      );
    else if (auth === 'workos') {
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
  for (const app of config.apps.filter((app) => app.framework === 'nuxt')) {
    const middleware = join(project, 'apps', app.name, 'server/middleware');
    const badFile = join(middleware, 'typecheck-regression.ts');
    await mkdir(middleware, { recursive: true });
    try {
      await writeFile(badFile, 'export const invalid: string = 123;\n');
      const result = spawn.sync(
        packageManager,
        packageManager === 'bun'
          ? ['run', '--cwd', `apps/${app.name}`, 'typecheck']
          : ['--filter', `@fixture/${app.name}`, 'typecheck'],
        {
          cwd: project,
          encoding: 'utf8',
          timeout: 120_000,
        },
      );
      if (result.error) throw result.error;
      const output = `${result.stdout}\n${result.stderr}`;
      if (
        result.status === 0 ||
        !/server[/\\]middleware[/\\]typecheck-regression\.ts\(1,14\): error TS2322/.test(
          output,
        )
      )
        throw new Error(
          `Nuxt typecheck did not report the intentional server error:\n${output}`,
        );
      console.log(
        `PASS ${app.name} typecheck rejects an error in server/middleware`,
      );
    } finally {
      await rm(badFile, { force: true });
    }
  }
  run(['run', 'lint']);
  run(['run', 'build']);
  for (const app of config.apps) {
    const output = join(
      project,
      'apps',
      app.name,
      app.framework === 'nuxt'
        ? '.output/public'
        : app.framework === 'next'
          ? '.next/static'
          : app.framework === 'tanstack-start'
            ? 'dist/client'
            : app.framework === 'sveltekit'
              ? '.svelte-kit/output/client'
              : app.framework === 'react-router'
                ? 'build/client'
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
