import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import spawn from 'cross-spawn';
const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const tarball = resolve(`create-convex-monorepo-${manifest.version}.tgz`);
const directory = await mkdtemp(join(tmpdir(), 'ccm-pack-'));
function run(command, args, cwd) {
  const result = spawn.sync(command, args, {
    cwd,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed: ${result.status}`);
}
try {
  run(
    'npm',
    ['install', '--prefix', directory, '--no-audit', '--no-fund', tarball],
    directory,
  );
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { normalizeOptions } from 'create-convex-monorepo'; if (normalizeOptions({ apps: 'next,expo' }).apps.length !== 2) throw new Error('Broken package exports');",
    ],
    directory,
  );
  // Exercise npm's launcher with the packed artifact, before it exists on npm.
  run(
    'npx',
    ['--yes', '--package', tarball, 'create-convex-monorepo', '--version'],
    directory,
  );
  run(
    'pnpm',
    ['--package', tarball, 'dlx', 'create-convex-monorepo', '--help'],
    directory,
  );
  const bin = join(directory, 'node_modules', '.bin', 'create-convex-monorepo');
  run(
    bin,
    [
      'packed',
      '--apps',
      'next,expo',
      '--auth',
      'clerk',
      '--no-install',
      '--no-git',
    ],
    directory,
  );
  const files = await readdir(
    join(directory, 'packed', 'packages', 'backend', 'convex', '_generated'),
  );
  if (!files.includes('api.d.ts') || !files.includes('api.js'))
    throw new Error('Published package lost generated types');
  const project = join(directory, 'packed');
  await writeFile(
    join(project, 'packages/backend/.env.local'),
    'CONVEX_URL=https://pack-test.convex.cloud\nCONVEX_DEPLOY_KEY=never-copy-this\n',
  );
  run(process.execPath, ['scripts/convex-setup.mjs', '--link-only'], project);
  for (const [app, variable] of [
    ['web', 'NEXT_PUBLIC_CONVEX_URL'],
    ['mobile', 'EXPO_PUBLIC_CONVEX_URL'],
  ]) {
    const env = await readFile(
      join(project, 'apps', app, '.env.local'),
      'utf8',
    );
    if (env !== `${variable}=https://pack-test.convex.cloud\n`)
      throw new Error(`Published URL linker failed for ${app}`);
  }
  run(
    bin,
    [
      'blank',
      '--apps',
      'next,expo',
      '--example',
      'none',
      '--no-install',
      '--no-git',
    ],
    directory,
  );
  const blank = join(directory, 'blank');
  const blankFiles = await readdir(blank, { recursive: true });
  if (blankFiles.some((file) => /messages\.tsx?$/.test(file)))
    throw new Error('Blank tarball starter contains demo code');
  if (
    !(
      await readFile(
        join(blank, 'packages/backend/convex/_generated/api.d.ts'),
        'utf8',
      )
    ).includes('ApiFromModules<{}>')
  )
    throw new Error('Published package lost blank generated types');
  console.log(
    'PASS installed tarball bin, both starter assets and standalone URL linking',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
