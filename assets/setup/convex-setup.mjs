// @ts-check
import { spawn } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** @param {string} framework */
export function publicVariable(framework) {
  switch (framework) {
    case 'next':
      return 'NEXT_PUBLIC_CONVEX_URL';
    case 'vite':
    case 'tanstack-start':
      return 'VITE_CONVEX_URL';
    case 'expo':
      return 'EXPO_PUBLIC_CONVEX_URL';
    default:
      throw new Error(
        `Unknown framework in convex-monorepo.json: ${framework}`,
      );
  }
}

/** Reject links before reading or updating local configuration.
 * @param {string} root @param {string} file
 */
async function safeFile(root, file) {
  const path = relative(root, file);
  if (!path || path.startsWith(`..${sep}`) || path === '..')
    throw new Error('Invalid environment file path.');
  let current = root;
  for (const part of path.split(sep)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Refusing symlink: ${current}`);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
}

/** @param {string} file */
async function readOptional(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return '';
    throw error;
  }
}

/** @param {string | undefined} value */
export function deploymentUrl(value) {
  if (!value)
    throw new Error(
      'CONVEX_URL is missing from packages/backend/.env.local or .env. Run pnpm convex:setup first.',
    );
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The backend CONVEX_URL is not a valid deployment URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    /\s/.test(value)
  ) {
    throw new Error(
      'CONVEX_URL must be an HTTP(S) origin without credentials, a path, query parameters or a fragment.',
    );
  }
  return url.origin;
}

/** Preserve existing text, including multiline values and comments. dotenv uses
 * the last assignment. Re-running with the same URL makes no changes.
 * @param {string} contents @param {string} variable @param {string} url
 */
export function linkEnvironment(contents, variable, url) {
  if (parseEnv(contents)[variable] === url) return contents;
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const separator = contents && !contents.endsWith('\n') ? newline : '';
  return `${contents}${separator}${variable}=${url}${newline}`;
}

/** @param {string} root @param {AbortSignal} [signal] */
export async function linkFrontends(root, signal) {
  signal?.throwIfAborted();
  root = resolve(root);
  const configFile = join(root, 'convex-monorepo.json');
  await safeFile(root, configFile);
  /** @type {unknown} */
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (
    !config ||
    typeof config !== 'object' ||
    !('apps' in config) ||
    !Array.isArray(config.apps) ||
    config.apps.length === 0
  ) {
    throw new Error('convex-monorepo.json must list the applications to link.');
  }
  /** @type {Record<string, string | undefined>} */
  let backend = {};
  for (const name of ['.env', '.env.local']) {
    const file = join(root, 'packages/backend', name);
    await safeFile(root, file);
    backend = { ...backend, ...parseEnv(await readOptional(file)) };
  }
  const url = deploymentUrl(backend.CONVEX_URL);
  /** @type {Array<{ file: string, before: string, after: string, name: string }>} */
  const updates = [];
  const names = new Set();
  let hasExpo = false;
  // Preflight every app before changing any environment file.
  for (const app of /** @type {unknown[]} */ (config.apps)) {
    if (
      !app ||
      typeof app !== 'object' ||
      !('name' in app) ||
      typeof app.name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(app.name) ||
      !('framework' in app) ||
      typeof app.framework !== 'string' ||
      names.has(app.name)
    ) {
      throw new Error(
        'Invalid or duplicate application in convex-monorepo.json.',
      );
    }
    signal?.throwIfAborted();
    hasExpo ||= app.framework === 'expo';
    names.add(app.name);
    const variable = publicVariable(app.framework);
    const file = join(root, 'apps', app.name, '.env.local');
    await safeFile(root, file);
    if (!(await lstat(dirname(file))).isDirectory())
      throw new Error(`Application directory is missing: ${app.name}`);
    const before = await readOptional(file);
    updates.push({
      file,
      before,
      after: linkEnvironment(before, variable, url),
      name: app.name,
    });
  }
  for (const update of updates) {
    signal?.throwIfAborted();
    await safeFile(root, update.file);
    if ((await readOptional(update.file)) !== update.before)
      throw new Error(
        `Environment changed while linking ${update.name}. Run pnpm convex:link again.`,
      );
    signal?.throwIfAborted();
    if (update.after !== update.before)
      await writeFile(update.file, update.after, { mode: 0o600 });
    signal?.throwIfAborted();
    console.log(`Linked apps/${update.name}/.env.local`);
  }
  signal?.throwIfAborted();
  if (
    hasExpo &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
  ) {
    console.log(
      'Local Convex URL linked. Physical phones need a reachable development URL; localhost points to the phone itself.',
    );
  }
}

/** @param {string} root @param {AbortSignal} [signal] */
export async function initializeConvex(root, signal) {
  const backend = join(root, 'packages/backend');
  const require = createRequire(join(backend, 'package.json'));
  let cli;
  try {
    cli = join(dirname(require.resolve('convex/package.json')), 'bin/main.js');
  } catch {
    throw new Error(
      'Convex is not installed. Run pnpm install, then pnpm convex:setup.',
    );
  }
  console.log('Initializing Convex. Complete the Convex CLI prompts below.');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'dev', '--once'], {
      cwd: backend,
      stdio: 'inherit',
      ...(signal ? { signal } : {}),
    });
    /** @type {Error | undefined} */
    let processError;
    child.once('error', (error) => {
      processError = error;
    });
    // Abort errors arrive before shutdown. Wait until the child releases its files.
    child.once('close', (code, interrupted) =>
      processError
        ? reject(processError)
        : code === 0
          ? resolve(undefined)
          : reject(
              new Error(
                `Convex setup stopped (${interrupted ?? `exit ${code}`}). Project files are preserved; frontend URLs were not changed. Resolve the error above and run pnpm convex:setup again. For Clerk, configure CLERK_JWT_ISSUER_DOMAIN on the deployment as described in README.md.`,
              ),
            ),
    );
  });
  signal?.throwIfAborted();
  await linkFrontends(root, signal);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error('Convex setup cancelled.'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 1 && args[0] === '--link-only'))
      throw new Error('Usage: pnpm convex:setup or pnpm convex:link');
    const root = fileURLToPath(new URL('../', import.meta.url));
    if (args[0] === '--link-only') await linkFrontends(root, controller.signal);
    else await initializeConvex(root, controller.signal);
    controller.signal.throwIfAborted();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Convex setup failed.',
    );
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
