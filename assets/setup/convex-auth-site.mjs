// @ts-check
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this helper standalone when adding auth to older generated workspaces.
/** @param {string} root @returns {Promise<'pnpm' | 'bun'>} */
async function detectPackageManager(root) {
  /** @type {Array<'pnpm' | 'bun' | undefined>} */
  const managers = [];
  for (const name of ['convex-monorepo.json', 'package.json']) {
    const file = join(root, name);
    let contents = '';
    try {
      if ((await lstat(file)).isSymbolicLink())
        throw new Error(`Refusing symlink: ${file}`);
      contents = await readFile(file, 'utf8');
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    const metadata = contents ? JSON.parse(contents) : {};
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error(`Invalid package manager metadata in ${name}.`);
    const value = metadata.packageManager;
    if (value === undefined) {
      managers.push(undefined);
      continue;
    }
    const match =
      typeof value === 'string'
        ? value.match(
            name === 'package.json'
              ? /^(pnpm|bun)(?:@[^\s]+)?$/
              : /^(pnpm|bun)$/,
          )
        : null;
    if (!match)
      throw new Error(
        `Unsupported package manager in ${name}. Expected pnpm or bun.`,
      );
    managers.push(/** @type {'pnpm' | 'bun'} */ (match[1]));
  }
  return managers[0] ?? managers[1] ?? 'pnpm';
}

/** @param {'pnpm' | 'bun'} manager @param {string} script */
function packageScriptCommand(manager, script) {
  return `${manager}${manager === 'bun' ? ' run' : ''} ${script}`;
}

/** @param {string} root @param {string[]} args */
export async function setAuthSite(root, args) {
  const manager = await detectPackageManager(root);
  const command = packageScriptCommand(manager, 'convex:auth-site');
  const values = args[0] === '--' ? args.slice(1) : args;
  const [site, ...flags] = values;
  if (!site) throw new Error(`Usage: ${command} <site-url> [--prod].`);
  let url;
  try {
    url = new URL(site ?? '');
  } catch {
    throw new Error(
      `Usage: ${command} <site-url> [--prod]. Supply an absolute URL.`,
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
      `Convex is not installed. Run ${manager} install, then ${command} <site-url>.`,
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
