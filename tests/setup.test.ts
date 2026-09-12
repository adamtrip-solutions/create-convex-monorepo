import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { generateAuthKeys } from '../assets/setup/convex-auth-keys.mjs';
import { generateProject } from '../src/generator/index.js';
import { normalizeOptions } from '../src/generator/options.js';
import { parseCommand } from '../src/commands/create.js';
import * as packageManager from '../src/package-manager/index.js';
import {
  deploymentUrl,
  initializeConvex,
  linkEnvironment,
  linkFrontends,
} from '../assets/setup/convex-setup.mjs';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture(
  apps = 'next,admin:vite,portal:tanstack-start,expo',
  auth = 'none',
) {
  const cwd = await mkdtemp(join(tmpdir(), 'ccm-setup-'));
  temporary.push(cwd);
  const root = await generateProject({ name: 'fixture', apps, auth }, { cwd });
  return { cwd, root };
}
async function backendEnv(root: string, contents: string) {
  await writeFile(join(root, 'packages/backend/.env.local'), contents);
}

describe('Convex initialization options', () => {
  it('requires explicit setup when accepting defaults noninteractively', () => {
    expect(normalizeOptions({ yes: true })).toMatchObject({
      initConvex: false,
      install: true,
    });
    expect(normalizeOptions({})).toMatchObject({
      initConvex: false,
      install: false,
    });
  });
  it('enables dependencies for initialization and respects explicit negation', () => {
    expect(normalizeOptions(parseCommand(['--init-convex']).raw)).toMatchObject(
      { initConvex: true, install: true },
    );
    expect(
      normalizeOptions(parseCommand(['--yes', '--no-init-convex']).raw),
    ).toMatchObject({ initConvex: false, install: true });
    expect(() =>
      normalizeOptions(parseCommand(['--init-convex', '--no-install']).raw),
    ).toThrow('requires dependencies');
    expect(() => parseCommand(['--init-convex', '--no-init-convex'])).toThrow(
      'Choose either',
    );
  });
  it('installs before setup and reports linked URLs only after success', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ccm-init-'));
    temporary.push(cwd);
    const calls: string[] = [];
    vi.spyOn(packageManager.pnpm, 'install').mockImplementation(async () => {
      calls.push('install');
    });
    vi.spyOn(packageManager, 'runCommand').mockImplementation(
      async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
      },
    );
    const progress: string[] = [];
    await generateProject(
      { name: 'ready', initConvex: true },
      { cwd, onProgress: (message) => progress.push(message) },
    );
    expect(calls).toEqual(['install', 'pnpm convex:setup']);
    expect(progress).toContain('Initialized Convex and linked frontend URLs');
  });
  it('preserves generated files and gives a retry command when initialization fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ccm-init-'));
    temporary.push(cwd);
    vi.spyOn(packageManager.pnpm, 'install').mockResolvedValue();
    vi.spyOn(packageManager, 'runCommand').mockRejectedValue(
      new Error('Convex setup cancelled'),
    );
    const progress: string[] = [];
    await expect(
      generateProject(
        { name: 'kept', initConvex: true },
        { cwd, onProgress: (message) => progress.push(message) },
      ),
    ).rejects.toThrow('pnpm convex:setup');
    expect(
      await readFile(
        join(cwd, 'kept/packages/backend/convex/schema.ts'),
        'utf8',
      ),
    ).toContain('defineSchema');
    expect(progress).not.toContain(
      'Initialized Convex and linked frontend URLs',
    );
  });
});

describe('public URL linking', () => {
  it('maps all frameworks, respects .env.local precedence, and never copies backend credentials', async () => {
    const { root } = await fixture();
    await writeFile(
      join(root, 'packages/backend/.env'),
      'CONVEX_URL=https://old.convex.cloud\n',
    );
    await backendEnv(
      root,
      'CONVEX_URL="https://test.convex.cloud" # public\nCONVEX_DEPLOYMENT=dev:private\nCONVEX_DEPLOY_KEY=secret-test-only\nCLERK_SECRET_KEY=secret-test-only\n',
    );
    vi.stubEnv('CONVEX_URL', 'https://ambient.convex.cloud');
    await linkFrontends(root);
    for (const [app, variable] of [
      ['web', 'NEXT_PUBLIC_CONVEX_URL'],
      ['admin', 'VITE_CONVEX_URL'],
      ['portal', 'VITE_CONVEX_URL'],
      ['mobile', 'EXPO_PUBLIC_CONVEX_URL'],
    ]) {
      const text = await readFile(join(root, `apps/${app}/.env.local`), 'utf8');
      expect(parseEnv(text)).toEqual({
        [variable!]: 'https://test.convex.cloud',
      });
      expect(text).not.toContain('secret-test-only');
    }
  });
  it('preserves comments, multiline settings and Clerk values when replacing a URL, and is idempotent', () => {
    const before =
      '# my settings\r\nVITE_CONVEX_URL=https://old.convex.cloud\r\nCLERK_SECRET_KEY=leave-me-alone\r\nTEXT="first\r\nVITE_CONVEX_URL=inside-a-string\r\nlast"';
    const after = linkEnvironment(
      before,
      'VITE_CONVEX_URL',
      'https://new.convex.cloud',
    );
    expect(after.startsWith(before)).toBe(true);
    expect(parseEnv(after)).toEqual({
      ...parseEnv(before),
      VITE_CONVEX_URL: 'https://new.convex.cloud',
    });
    expect(
      linkEnvironment(after, 'VITE_CONVEX_URL', 'https://new.convex.cloud'),
    ).toBe(after);
  });
  it('accepts a local backend and rejects unsafe or missing URLs', () => {
    expect(deploymentUrl('http://127.0.0.1:3210/')).toBe(
      'http://127.0.0.1:3210',
    );
    for (const value of [
      undefined,
      '',
      'not-url',
      'https://user:pass@host',
      'https://host/?key=secret',
      'https://host/#token',
      'https://host/path',
      'file:///tmp/file',
      'https://host\n',
    ]) {
      expect(() => deploymentUrl(value)).toThrow();
    }
  });
  it('preflights all apps and preserves existing env files on invalid configuration', async () => {
    const { root } = await fixture();
    await backendEnv(root, 'CONVEX_URL=https://test.convex.cloud\n');
    const file = join(root, 'apps/web/.env.local');
    await writeFile(file, 'NEXT_PUBLIC_CONVEX_URL=https://keep.convex.cloud\n');
    const config = join(root, 'convex-monorepo.json');
    await writeFile(
      config,
      JSON.stringify({
        apps: [
          { name: 'web', framework: 'next' },
          { name: '../escape', framework: 'expo' },
        ],
      }),
    );
    await expect(linkFrontends(root)).rejects.toThrow('Invalid');
    expect(await readFile(file, 'utf8')).toBe(
      'NEXT_PUBLIC_CONVEX_URL=https://keep.convex.cloud\n',
    );
  });
  it('rejects symlinked application directories', async () => {
    const { root, cwd } = await fixture('next');
    await backendEnv(root, 'CONVEX_URL=https://test.convex.cloud\n');
    const outside = join(cwd, 'outside');
    await mkdir(outside);
    await rm(join(root, 'apps/web'), { recursive: true });
    await symlink(outside, join(root, 'apps/web'), 'junction');
    await expect(linkFrontends(root)).rejects.toThrow('symlink');
    await expect(readFile(join(outside, '.env.local'))).rejects.toThrow();
  });
  it('fails without a URL instead of linking a deployment name or ambient variable', async () => {
    const { root } = await fixture('next');
    vi.stubEnv('CONVEX_URL', 'https://ambient.convex.cloud');
    await backendEnv(root, 'CONVEX_DEPLOYMENT=dev:my-deployment');
    await expect(linkFrontends(root)).rejects.toThrow('CONVEX_URL is missing');
    await expect(readFile(join(root, 'apps/web/.env.local'))).rejects.toThrow();
  });
});

async function fakeConvex(root: string, code: string) {
  const pkg = join(root, 'packages/backend/node_modules/convex');
  await mkdir(join(pkg, 'bin'), { recursive: true });
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'convex',
      exports: { './package.json': './package.json' },
    }),
  );
  await writeFile(join(pkg, 'bin/main.js'), code);
}

describe('Convex Auth key setup', () => {
  const run = promisify(execFile);
  it('generates a PKCS8 RSA 2048 key and a matching public signing JWKS', () => {
    const { privateKey, jwks } = generateAuthKeys();
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    const privateObject = createPrivateKey(privateKey);
    expect(privateObject.asymmetricKeyType).toBe('rsa');
    expect(privateObject.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toEqual({
      use: 'sig',
      ...createPublicKey(privateObject).export({ format: 'jwk' }),
    });
    expect(jwks.keys[0]).toMatchObject({
      kty: 'RSA',
      n: expect.any(String),
      e: 'AQAB',
    });
    const payload = Buffer.from('auth-key-test');
    const publicObject = createPublicKey({ key: jwks.keys[0]!, format: 'jwk' });
    expect(
      verify(
        'sha256',
        payload,
        publicObject,
        sign('sha256', payload, privateObject),
      ),
    ).toBe(true);
  });
  it.each([
    { args: [], flags: [], deployment: 'the selected deployment' },
    { args: ['--prod'], flags: ['--prod'], deployment: '--prod' },
    {
      args: ['--', '--prod', '--env-file', '.env.production'],
      flags: ['--prod', '--env-file', '.env.production'],
      deployment: '--prod',
    },
  ])(
    'runs both installed CLI commands with $args and keeps private values out of files and output',
    async ({ args, flags, deployment }) => {
      const { root, cwd } = await fixture('next', 'convex-auth');
      await fakeConvex(
        root,
        `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const crypto = require('node:crypto');
      const args = process.argv.slice(2);
      const flags = ${JSON.stringify(flags)};
        assert.equal(process.cwd(), ${JSON.stringify(await realpath(join(root, 'packages/backend')))});
      assert.deepEqual(args.slice(0, 2 + flags.length), ['env', 'set', ...flags]);
      const [name, ...values] = args.slice(2 + flags.length);
      if (name === 'JWT_PRIVATE_KEY') {
        assert.equal(values.length, 2);
        assert.equal(values[0], '--');
        assert.match(values[1], /^-----BEGIN PRIVATE KEY-----/);
        const publicKey = crypto.createPublicKey(crypto.createPrivateKey(values[1])).export({ format: 'jwk' });
        fs.writeFileSync('public-key.json', JSON.stringify(publicKey));
      } else {
        assert.equal(name, 'JWKS');
        assert.equal(values.length, 1);
        assert.deepEqual(JSON.parse(values[0]), { keys: [{ use: 'sig', ...JSON.parse(fs.readFileSync('public-key.json', 'utf8')) }] });
      }
      fs.appendFileSync('calls.txt', name + '\\n');
      console.log(values.join(' '));
      console.error(values.join(' '));
    `,
      );
      const result = await run(
        process.execPath,
        [join(root, 'scripts/convex-auth-keys.mjs'), ...args],
        { cwd },
      );
      expect(result).toEqual({
        stdout: `Set JWT_PRIVATE_KEY and JWKS for ${deployment}.\n`,
        stderr: '',
      });
      expect(
        await readFile(join(root, 'packages/backend/calls.txt'), 'utf8'),
      ).toBe('JWT_PRIVATE_KEY\nJWKS\n');
      for (const file of await readdir(root, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (file.isFile()) {
          // Script source contains the PEM header check, but no private key data.
          expect(
            await readFile(join(file.parentPath, file.name), 'utf8'),
          ).not.toMatch(/-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/]/);
        }
      }
    },
  );
  it('exits nonzero with an install instruction when Convex is missing', async () => {
    const { root } = await fixture('next', 'convex-auth');
    await expect(
      run(process.execPath, [join(root, 'scripts/convex-auth-keys.mjs')]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'Convex is not installed. Run pnpm install, then pnpm convex:auth-keys.\n',
    });
  });
  it.each(['JWT_PRIVATE_KEY', 'JWKS'])(
    'exits nonzero without printing values when setting %s fails',
    async (variable) => {
      const { root } = await fixture('next', 'convex-auth');
      await fakeConvex(
        root,
        `
      const name = process.argv[4];
      require('node:fs').appendFileSync('calls.txt', name + '\\n');
      console.error(process.argv.join(' '));
      if (name === ${JSON.stringify(variable)}) process.exit(1);
    `,
      );
      await expect(
        run(process.execPath, [join(root, 'scripts/convex-auth-keys.mjs')]),
      ).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: `Convex env set ${variable} failed. Check the deployment configuration and CLI access, then rerun pnpm convex:auth-keys with the same deployment flags to set both values.\n`,
      });
      expect(
        await readFile(join(root, 'packages/backend/calls.txt'), 'utf8'),
      ).toBe(
        variable === 'JWT_PRIVATE_KEY'
          ? 'JWT_PRIVATE_KEY\n'
          : 'JWT_PRIVATE_KEY\nJWKS\n',
      );
    },
  );
});

it('runs the installed Convex CLI in the backend package, then links the URL', async () => {
  const { root } = await fixture('next');
  await fakeConvex(
    root,
    `const assert=require('node:assert/strict'); assert.deepEqual(process.argv.slice(2),['dev','--once']); require('node:fs').writeFileSync('.env.local','CONVEX_URL=https://live.convex.cloud\\nCONVEX_DEPLOY_KEY=test-only-secret\\n');`,
  );
  await initializeConvex(root);
  expect(
    parseEnv(await readFile(join(root, 'apps/web/.env.local'), 'utf8')),
  ).toEqual({ NEXT_PUBLIC_CONVEX_URL: 'https://live.convex.cloud' });
});
it('does not link a stale URL if the Convex child fails', async () => {
  const { root } = await fixture('next');
  await backendEnv(root, 'CONVEX_URL=https://stale.convex.cloud');
  await fakeConvex(root, 'process.exit(1)');
  await expect(initializeConvex(root)).rejects.toThrow(
    'frontend URLs were not changed',
  );
  await expect(readFile(join(root, 'apps/web/.env.local'))).rejects.toThrow();
});
it('waits for the cancelled Convex child to close and preserves the backend', async () => {
  const { root } = await fixture('next');
  await fakeConvex(
    root,
    `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
    require('node:fs').writeFileSync('ready.pid', String(process.pid));
    setInterval(() => {}, 1000);
  `,
  );
  const controller = new AbortController();
  const result = initializeConvex(root, controller.signal);
  // Observe rejection immediately so startup failures cannot go unhandled.
  const outcome = result.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    let pid = 0;
    await vi.waitFor(
      async () => {
        pid = Number(
          await readFile(join(root, 'packages/backend/ready.pid'), 'utf8'),
        );
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      },
      { timeout: 5000, interval: 10 },
    );
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    controller.abort();
    await outcome;
  }
  expect(
    await readFile(join(root, 'packages/backend/package.json'), 'utf8'),
  ).toContain('@fixture/backend');
  await expect(readFile(join(root, 'apps/web/.env.local'))).rejects.toThrow();
});

it('reports cancellation during URL linking and leaves remaining apps unchanged', async () => {
  const { root } = await fixture('next,expo');
  await backendEnv(root, 'CONVEX_URL=https://test.convex.cloud');
  const controller = new AbortController();
  vi.spyOn(console, 'log').mockImplementation(() => controller.abort());
  await expect(linkFrontends(root, controller.signal)).rejects.toThrow();
  await expect(
    readFile(join(root, 'apps/mobile/.env.local')),
  ).rejects.toThrow();
  expect(await readFile(join(root, 'apps/web/.env.local'), 'utf8')).toContain(
    'NEXT_PUBLIC_CONVEX_URL=',
  );
});
