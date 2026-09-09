import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import spawn from 'cross-spawn';
import { generateProject } from '../dist/index.js';

const apps =
  process.env.CCM_APPS ?? 'next,admin:vite,portal:tanstack-start,expo';
const auth = process.env.CCM_AUTH ?? 'none';
const directory = await mkdtemp(join(tmpdir(), 'ccm-e2e-'));
const project = await generateProject(
  { name: 'fixture', apps, auth },
  { cwd: directory },
);
function run(args) {
  const result = spawn.sync('pnpm', args, {
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
    throw new Error(`pnpm ${args.join(' ')} exited ${result.status}`);
}
try {
  const config = JSON.parse(
    await readFile(join(project, 'convex-monorepo.json'), 'utf8'),
  );
  for (const app of config.apps) {
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
    await writeFile(
      join(project, 'apps', app.name, '.env.local'),
      lines.join('\n') + '\n',
    );
  }
  run(['install', '--no-frozen-lockfile']);
  run(['typecheck']);
  run(['lint']);
  run(['build']);
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
      ]) {
        if (contents.includes(Buffer.from(forbidden)))
          throw new Error(
            `Backend implementation or secret appeared in ${app.name}/${file}`,
          );
      }
    }
  }
  console.log(`PASS generated ${apps} / ${auth}`);
} catch (error) {
  console.error(`Fixture retained at ${project}`);
  process.exitCode = 1;
  throw error;
} finally {
  if (!process.exitCode && !process.env.CCM_KEEP_FIXTURE)
    await rm(directory, { recursive: true, force: true });
}
