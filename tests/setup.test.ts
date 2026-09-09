import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
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
async function fixture(apps = 'next,admin:vite,portal:tanstack-start,expo') {
  const cwd = await mkdtemp(join(tmpdir(), 'ccm-setup-'));
  temporary.push(cwd);
  const root = await generateProject({ name: 'fixture', apps }, { cwd });
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
