import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAuthSite } from '../assets/setup/convex-auth-site.mjs';
import { normalizeOptions } from '../src/generator/options.js';
import { convexAuthConfig } from '../src/integrations/auth/convex-auth/index.js';
import { authControls } from '../src/integrations/auth/convex-auth/controls.js';

const roots: string[] = [];
const run = promisify(execFile);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(code?: string) {
  const root = await mkdtemp(join(tmpdir(), 'ccm-oauth-runtime-'));
  roots.push(root);
  const backend = join(root, 'packages/backend');
  await mkdir(backend, { recursive: true });
  await mkdir(join(root, 'scripts'));
  await copyFile(
    new URL('../assets/setup/convex-auth-site.mjs', import.meta.url),
    join(root, 'scripts/convex-auth-site.mjs'),
  );
  await writeFile(join(backend, 'package.json'), '{}');
  if (code !== undefined) {
    const pkg = join(backend, 'node_modules/convex');
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
  return { root, backend, script: join(root, 'scripts/convex-auth-site.mjs') };
}

describe('OAuth SITE_URL setup', () => {
  it.each([
    {
      args: ['https://app.example.com'],
      flags: [],
      site: 'https://app.example.com',
    },
    {
      args: ['http://localhost:3000', '--prod'],
      flags: ['--prod'],
      site: 'http://localhost:3000',
    },
    {
      args: [
        '--',
        'ccm-fixture-mobile://auth',
        '--prod',
        '--env-file',
        '.env.production',
      ],
      flags: ['--prod', '--env-file', '.env.production'],
      site: 'ccm-fixture-mobile://auth',
    },
  ])(
    'sets only SITE_URL through the installed backend CLI with $args',
    async ({ args, flags, site }) => {
      const { root, backend, script } = await fixture(`
      require('node:fs').writeFileSync('invocation.json', JSON.stringify({ args: process.argv.slice(2), cwd: require('node:fs').realpathSync.native(process.cwd()) }));
      console.log('private-cli-output');
      console.error('private-cli-error');
    `);
      const environment =
        'JWT_PRIVATE_KEY=keep-private-key\nJWKS=keep-public-key-set\n';
      await writeFile(join(backend, '.env.local'), environment);
      const result = await run(process.execPath, [script, ...args], {
        cwd: root,
      });
      expect(result).toEqual({
        stdout: 'Set SITE_URL on the selected deployment.\n',
        stderr: '',
      });
      expect(
        JSON.parse(await readFile(join(backend, 'invocation.json'), 'utf8')),
      ).toEqual({
        args: ['env', 'set', ...flags, 'SITE_URL', site],
        cwd: await realpath(backend),
      });
      expect(await readFile(join(backend, '.env.local'), 'utf8')).toBe(
        environment,
      );
    },
  );

  it.each([
    [],
    ['not-an-absolute-url'],
    ['https://user:private-secret@app.example.com'],
    ['https://app.example.com/?token=private-secret'],
    ['https://app.example.com/#private-secret'],
    ['javascript:alert(1)'],
    ['data:text/plain,private-secret'],
    ['file:///private-secret'],
  ])('rejects invalid input before invoking the CLI: %j', async (...args) => {
    // Vitest treats each row as the argument list; reconstruct the script argv.
    const values = args as string[];
    const { root, backend } = await fixture(
      "require('node:fs').writeFileSync('called', 'yes');",
    );
    await expect(setAuthSite(root, values)).rejects.toThrow();
    await expect(readFile(join(backend, 'called'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports a missing Convex installation with a nonzero exit', async () => {
    const { script } = await fixture();
    await expect(
      run(process.execPath, [script, 'https://app.example.com']),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'Convex is not installed. Run pnpm install, then pnpm convex:auth-site <site-url>.\n',
    });
  });

  it.each([
    {
      metadata: { packageManager: 'bun' },
      manifest: {},
      command: 'bun run',
      manager: 'bun',
    },
    {
      metadata: {},
      manifest: { packageManager: 'bun@1.4.2' },
      command: 'bun run',
      manager: 'bun',
    },
    {
      metadata: { packageManager: 'pnpm' },
      manifest: { packageManager: 'bun@1.4.2' },
      command: 'pnpm',
      manager: 'pnpm',
    },
  ])(
    'uses $command for standalone setup guidance',
    async ({ metadata, manifest, command, manager }) => {
      const { root, script } = await fixture();
      await writeFile(
        join(root, 'convex-monorepo.json'),
        JSON.stringify(metadata),
      );
      await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
      await expect(run(process.execPath, [script])).rejects.toMatchObject({
        code: 1,
        stderr: `Usage: ${command} convex:auth-site <site-url> [--prod].\n`,
      });
      await expect(
        run(process.execPath, [script, 'https://app.example.com']),
      ).rejects.toMatchObject({
        code: 1,
        stderr: `Convex is not installed. Run ${manager} install, then ${command} convex:auth-site <site-url>.\n`,
      });
    },
  );

  it('reports CLI failure without printing deployment output or changing signing keys', async () => {
    const { script, backend } = await fixture(
      "console.log('private-output'); console.error('private-error'); process.exit(7);",
    );
    await writeFile(
      join(backend, '.env.local'),
      'JWT_PRIVATE_KEY=unchanged\nJWKS=unchanged\n',
    );
    await expect(
      run(process.execPath, [script, 'https://app.example.com', '--prod']),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr:
        'Convex env set SITE_URL failed. Check deployment access and rerun with the same flags.\n',
    });
    expect(await readFile(join(backend, '.env.local'), 'utf8')).toBe(
      'JWT_PRIVATE_KEY=unchanged\nJWKS=unchanged\n',
    );
  });
});

function redirectCallback(siteUrl?: string) {
  type Configuration = {
    callbacks?: { redirect: (args: { redirectTo: string }) => Promise<string> };
  };
  let captured: Configuration | undefined;
  const code = convexAuthConfig(
    normalizeOptions({
      name: 'fixture',
      apps: 'next,mobile:expo,tablet:expo',
      auth: 'convex-auth',
      oauth: 'github,google',
    }),
  );
  const compiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  });
  runInNewContext(compiled.outputText, {
    exports: {},
    URL,
    process: { env: siteUrl === undefined ? {} : { SITE_URL: siteUrl } },
    require: (name: string) => {
      if (name === '@convex-dev/auth/server')
        return {
          convexAuth: (configuration: Configuration) => {
            captured = configuration;
            return {};
          },
        };
      return { Password: {}, default: {} };
    },
  });
  if (!captured?.callbacks)
    throw new Error('Generated OAuth redirect callback is missing.');
  return captured.callbacks.redirect;
}

describe('generated native OAuth redirect policy', () => {
  it('permits exact configured native URLs and same-origin web destinations', async () => {
    const redirect = redirectCallback('https://app.example.com');
    for (const url of [
      'ccm-fixture-mobile://auth',
      'ccm-fixture-tablet://auth',
      'https://app.example.com/settings',
    ])
      expect(await redirect({ redirectTo: url })).toBe(url);
    expect(await redirect({ redirectTo: '/settings?tab=profile' })).toBe(
      'https://app.example.com/settings?tab=profile',
    );
  });
  it.each([
    'https://evil.example.com',
    '//evil.example.com',
    'https://app.example.com.evil.example.com',
    'https://app.example.com@evil.example.com',
    'http://app.example.com',
    'https://app.example.com:444',
    'ccm-fixture-mobile://auth/extra',
    'ccm-fixture-mobile://auth?redirect=evil',
    'ccm-fixture-mobile://authentication',
    'ccm-other-mobile://auth',
    'javascript:alert(1)',
  ])('rejects unapproved redirect %s', async (redirectTo) => {
    await expect(
      redirectCallback('https://app.example.com')({ redirectTo }),
    ).rejects.toThrow('Invalid OAuth redirect destination.');
  });
  it('requires SITE_URL for web redirects and permits registered native returns with a native SITE_URL', async () => {
    await expect(
      redirectCallback()({ redirectTo: '/settings' }),
    ).rejects.toThrow('Set SITE_URL');
    await expect(
      redirectCallback()({ redirectTo: 'ccm-fixture-mobile://auth' }),
    ).rejects.toThrow('Set SITE_URL');
    const redirect = redirectCallback('ccm-fixture-mobile://auth');
    expect(await redirect({ redirectTo: 'ccm-fixture-mobile://auth' })).toBe(
      'ccm-fixture-mobile://auth',
    );
    await expect(
      redirect({ redirectTo: 'ccm-evil-mobile://auth' }),
    ).rejects.toThrow('Invalid OAuth redirect destination.');
  });
});

function nativeControls(
  signIn: (
    provider: string,
    args: Record<string, string>,
  ) => Promise<{ redirect?: URL }>,
  openAuthSessionAsync: (
    url: string,
    returnUrl: string,
  ) => Promise<{ type: string; url?: string }>,
) {
  const state: unknown[] = [];
  const buttons = new Map<string, { onPress: () => void; disabled: boolean }>();
  let finish: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const createURL = vi.fn(
    (path: string, { scheme }: { scheme: string }) => `${scheme}://${path}`,
  );
  const exported: { AuthControls?: () => unknown } = {};
  const element = (type: unknown, props: Record<string, unknown>) => {
    if (type === 'Button')
      buttons.set(
        String(props.title),
        props as { onPress: () => void; disabled: boolean },
      );
    return { type, props };
  };
  const source = ts.transpileModule(
    authControls(true, ['github', 'google'], 'ccm-fixture-mobile'),
    {
      fileName: 'auth-controls.tsx',
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2023,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  );
  runInNewContext(source.outputText, {
    exports: exported,
    URL,
    Error,
    require: (name: string) => {
      if (name === 'react')
        return {
          useState: (initial: unknown) => {
            const index = state.length;
            state.push(initial);
            return [
              initial,
              (value: unknown) => {
                state[index] = value;
                if (index === 3 && value === false) finish?.();
              },
            ];
          },
        };
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element };
      if (name === 'react-native')
        return Object.fromEntries(
          ['Button', 'ScrollView', 'Text', 'TextInput', 'View'].map(
            (component) => [component, component],
          ),
        );
      if (name === 'convex/react')
        return { useConvexAuth: () => ({ isAuthenticated: false }) };
      if (name === '@convex-dev/auth/react')
        return { useAuthActions: () => ({ signIn, signOut: vi.fn() }) };
      if (name === 'expo-linking') return { createURL };
      if (name === 'expo-web-browser') return { openAuthSessionAsync };
      throw new Error(`Unexpected generated import: ${name}`);
    },
  });
  if (!exported.AuthControls)
    throw new Error('AuthControls export is missing.');
  exported.AuthControls();
  return {
    state,
    createURL,
    async press(provider = 'GitHub') {
      const button = buttons.get(`Sign in with ${provider}`);
      if (!button) throw new Error(`Missing OAuth button for ${provider}.`);
      expect(button.disabled).toBe(false);
      button.onPress();
      expect(state[3]).toBe(true);
      await completed;
      expect(state[3]).toBe(false);
    },
  };
}

describe('generated native OAuth browser flow', () => {
  it.each([
    { provider: 'github', label: 'GitHub' },
    { provider: 'google', label: 'Google' },
  ])(
    'exchanges the returned code through $provider after browser success',
    async ({ provider, label }) => {
      const signIn = vi
        .fn()
        .mockResolvedValueOnce({
          redirect: new URL('https://backend.convex.site/api/auth/signin'),
        })
        .mockResolvedValueOnce({});
      const browser = vi.fn().mockResolvedValue({
        type: 'success',
        url: 'ccm-fixture-mobile://auth?code=one-time-code',
      });
      const controls = nativeControls(signIn, browser);
      await controls.press(label);
      expect(controls.createURL).toHaveBeenCalledExactlyOnceWith('auth', {
        scheme: 'ccm-fixture-mobile',
      });
      expect(signIn.mock.calls).toEqual([
        [provider, { redirectTo: 'ccm-fixture-mobile://auth' }],
        [provider, { code: 'one-time-code' }],
      ]);
      expect(browser).toHaveBeenCalledExactlyOnceWith(
        'https://backend.convex.site/api/auth/signin',
        'ccm-fixture-mobile://auth',
      );
      expect(controls.state[4]).toBe(null);
    },
  );
  it.each(['cancel', 'dismiss'])(
    'clears pending without exchanging a code when the browser returns %s',
    async (type) => {
      const signIn = vi.fn().mockResolvedValue({
        redirect: new URL('https://provider.example.com'),
      });
      const controls = nativeControls(
        signIn,
        vi.fn().mockResolvedValue({ type }),
      );
      await controls.press();
      expect(signIn).toHaveBeenCalledTimes(1);
      expect(controls.state[4]).toBe(null);
    },
  );
  it('shows an error and skips opening the browser when the provider returns no URL', async () => {
    const signIn = vi.fn().mockResolvedValue({});
    const browser = vi.fn();
    const controls = nativeControls(signIn, browser);
    await controls.press();
    expect(browser).not.toHaveBeenCalled();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(controls.state[4]).toBe(
      'The provider did not return a sign-in URL.',
    );
  });
  it('shows an error instead of exchanging an absent code', async () => {
    const signIn = vi
      .fn()
      .mockResolvedValue({ redirect: new URL('https://provider.example.com') });
    const controls = nativeControls(
      signIn,
      vi.fn().mockResolvedValue({
        type: 'success',
        url: 'ccm-fixture-mobile://auth',
      }),
    );
    await controls.press();
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(controls.state[4]).toBe(
      'The sign-in response did not include a code.',
    );
  });
  it.each(['initial', 'exchange'])(
    'clears pending and reports a thrown %s sign-in error',
    async (stage) => {
      const signIn = vi.fn();
      if (stage === 'exchange')
        signIn.mockResolvedValueOnce({
          redirect: new URL('https://provider.example.com'),
        });
      signIn.mockRejectedValueOnce(new Error('Sign-in request failed.'));
      const browser = vi.fn().mockResolvedValue({
        type: 'success',
        url: 'ccm-fixture-mobile://auth?code=one-time-code',
      });
      const controls = nativeControls(signIn, browser);
      await controls.press();
      expect(signIn).toHaveBeenCalledTimes(stage === 'initial' ? 1 : 2);
      expect(controls.state[4]).toBe('Sign-in request failed.');
    },
  );
});
