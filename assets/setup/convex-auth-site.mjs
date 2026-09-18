// @ts-check
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @param {string} root @param {string[]} args */
export async function setAuthSite(root, args) {
  const values = args[0] === '--' ? args.slice(1) : args;
  const [site, ...flags] = values;
  if (!site)
    throw new Error('Usage: pnpm convex:auth-site <site-url> [--prod].');
  let url;
  try {
    url = new URL(site ?? '');
  } catch {
    throw new Error(
      'Usage: pnpm convex:auth-site <site-url> [--prod]. Supply an absolute URL.',
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.protocol ||
    url.protocol === 'javascript:' ||
    url.protocol === 'data:' ||
    url.protocol === 'file:'
  ) {
    throw new Error(
      'SITE_URL must be a web origin or app scheme URL without credentials, query, or fragment.',
    );
  }
  const backend = join(root, 'packages/backend');
  const require = createRequire(join(backend, 'package.json'));
  let cli;
  try {
    cli = join(dirname(require.resolve('convex/package.json')), 'bin/main.js');
  } catch {
    throw new Error(
      'Convex is not installed. Run pnpm install, then pnpm convex:auth-site <site-url>.',
    );
  }
  await new Promise((resolve, reject) => {
    const fail = () =>
      reject(
        new Error(
          'Convex env set SITE_URL failed. Check deployment access and rerun with the same flags.',
        ),
      );
    const child = spawn(
      process.execPath,
      ['--', cli, 'env', 'set', ...flags, 'SITE_URL', site],
      { cwd: backend, stdio: 'ignore' },
    );
    child.once('error', fail);
    child.once('close', (code) => (code === 0 ? resolve(undefined) : fail()));
  });
  console.log('Set SITE_URL on the selected deployment.');
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await setAuthSite(
      fileURLToPath(new URL('../', import.meta.url)),
      process.argv.slice(2),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'SITE_URL setup failed.',
    );
    process.exitCode = 1;
  }
}
