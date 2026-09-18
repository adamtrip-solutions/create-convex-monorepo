// @ts-check
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** @param {string} value */
function siteOrigin(value) {
  try {
    const url = new URL(value);
    if (value.includes('*')) throw new Error();
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error(
      '--site-url must be an HTTP(S) origin, such as http://localhost:3000.',
    );
  }
}

/** @param {string[]} args */
export function parseBetterAuthEnvArgs(args) {
  const { values } = parseArgs({
    args: args[0] === '--' ? args.slice(1) : args,
    options: {
      'site-url': { type: 'string' },
      'trusted-origins': { type: 'string' },
      prod: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!values['site-url'])
    throw new Error(
      'Pass --site-url with your main frontend origin. See README.md.',
    );
  const siteUrl = siteOrigin(values['site-url']);
  const trustedOrigins = (values['trusted-origins'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      // Native application schemes are exact origins, not wildcard grants.
      if (/^[a-z][a-z0-9+.-]*:\/\/$/.test(value) && !/^https?:/.test(value))
        return value;
      try {
        return siteOrigin(value);
      } catch {
        throw new Error(
          '--trusted-origins must contain comma-separated HTTP(S) origins or native schemes such as ccm-app-mobile://.',
        );
      }
    });
  return {
    siteUrl,
    trustedOrigins: [...new Set(trustedOrigins)].join(','),
    prod: values.prod ?? false,
  };
}

/** @param {string} root @param {string[]} [args] */
export async function setBetterAuthEnv(root, args = []) {
  const options = parseBetterAuthEnvArgs(args);
  const backend = join(root, 'packages/backend');
  const require = createRequire(join(backend, 'package.json'));
  let cli;
  try {
    cli = join(dirname(require.resolve('convex/package.json')), 'bin/main.js');
  } catch {
    throw new Error(
      'Convex is not installed. Run pnpm install, then pnpm convex:better-auth-env.',
    );
  }
  const values = {
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
    SITE_URL: options.siteUrl,
    BETTER_AUTH_TRUSTED_ORIGINS: options.trustedOrigins,
  };
  for (const [name, value] of Object.entries(values)) {
    await new Promise((resolve, reject) => {
      const fail = () =>
        reject(
          new Error(
            `Convex env set ${name} failed. Check deployment access, then rerun the setup command with the same options. No values were logged.`,
          ),
        );
      // Suppress all CLI output, including errors that might contain the secret.
      const child = spawn(
        process.execPath,
        [
          '--',
          cli,
          'env',
          'set',
          ...(options.prod ? ['--prod'] : []),
          name,
          value,
        ],
        { cwd: backend, stdio: 'ignore' },
      );
      child.once('error', fail);
      child.once('close', (code) => (code === 0 ? resolve(undefined) : fail()));
    });
  }
  console.log(
    `Set Better Auth deployment variables for ${options.prod ? 'production' : 'the selected development deployment'}.`,
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await setBetterAuthEnv(
      fileURLToPath(new URL('../', import.meta.url)),
      process.argv.slice(2),
    );
  } catch {
    // Argument parser errors can echo unrecognized values; keep them private too.
    console.error(
      'Better Auth setup failed. Use --site-url <http-origin>, optional --trusted-origins <comma-separated-origins>, and optional --prod. Check that Convex is installed and the deployment is selected. No values were logged.',
    );
    process.exitCode = 1;
  }
}
