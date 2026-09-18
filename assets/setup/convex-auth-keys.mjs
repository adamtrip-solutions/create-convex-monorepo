// @ts-check
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
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

export function generateAuthKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    jwks: { keys: [{ use: 'sig', ...publicKey.export({ format: 'jwk' }) }] },
  };
}

/** @param {string} root @param {string[]} [args] */
export async function setAuthKeys(root, args = []) {
  const manager = await detectPackageManager(root);
  const backend = join(root, 'packages/backend');
  const require = createRequire(join(backend, 'package.json'));
  let cli;
  try {
    cli = join(dirname(require.resolve('convex/package.json')), 'bin/main.js');
  } catch {
    throw new Error(
      `Convex is not installed. Run ${manager} install, then ${packageScriptCommand(manager, 'convex:auth-keys')}.`,
    );
  }
  const flags = args[0] === '--' ? args.slice(1) : args;
  const { privateKey, jwks } = generateAuthKeys();
  for (const [name, value] of Object.entries({
    JWT_PRIVATE_KEY: privateKey,
    JWKS: JSON.stringify(jwks),
  })) {
    await new Promise((resolve, reject) => {
      const fail = () =>
        reject(
          new Error(
            `Convex env set ${name} failed. Check the deployment configuration and CLI access, then rerun ${packageScriptCommand(manager, 'convex:auth-keys')} with the same deployment flags to set both values.`,
          ),
        );
      // Flags must precede the separator that protects the PEM's leading dashes.
      // Suppress CLI output and errors because they may contain the value.
      const child = spawn(
        process.execPath,
        [
          '--',
          cli,
          'env',
          'set',
          ...flags,
          name,
          ...(name === 'JWT_PRIVATE_KEY' ? ['--'] : []),
          value,
        ],
        { cwd: backend, stdio: 'ignore' },
      );
      child.once('error', fail);
      child.once('close', (code) => (code === 0 ? resolve(undefined) : fail()));
    });
  }
  const deployment = flags.includes('--prod')
    ? '--prod'
    : flags.includes('--deployment-name')
      ? '--deployment-name'
      : flags.includes('--preview-name')
        ? '--preview-name'
        : 'the selected deployment';
  console.log(`Set JWT_PRIVATE_KEY and JWKS for ${deployment}.`);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await setAuthKeys(
      fileURLToPath(new URL('../', import.meta.url)),
      process.argv.slice(2),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Convex Auth key setup failed.',
    );
    process.exitCode = 1;
  }
}
