// @ts-check
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const backend = join(root, 'packages/backend');
  const require = createRequire(join(backend, 'package.json'));
  let cli;
  try {
    cli = join(dirname(require.resolve('convex/package.json')), 'bin/main.js');
  } catch {
    throw new Error(
      'Convex is not installed. Run pnpm install, then pnpm convex:auth-keys.',
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
            `Convex env set ${name} failed. Check the deployment configuration and CLI access, then rerun pnpm convex:auth-keys with the same deployment flags to set both values.`,
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
