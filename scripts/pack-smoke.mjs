import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  console.log('PASS installed tarball bin and runtime assets');
} finally {
  await rm(directory, { recursive: true, force: true });
}
