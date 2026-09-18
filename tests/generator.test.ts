import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { generateProject } from '../src/generator/index.js';
import type {
  PackageManifest,
  ProjectOptions,
} from '../src/generator/types.js';
import { getPackageVersion } from '../src/version.js';
import { versions } from '../src/templates/versions.js';

interface Golden {
  label: string;
  apps: string;
  auth: string;
  example?: string;
  packageManager?: 'pnpm' | 'bun';
  expected: [string, string, string, string | null][];
}
const scenarios: Golden[] = JSON.parse(
  await readFile(new URL('./golden/projects.json', import.meta.url), 'utf8'),
);

async function assertAuthoredTypes(root: string) {
  for (const entry of await readdir(root, { recursive: true })) {
    if (!/\.[cm]?tsx?$/.test(entry) || entry.includes('_generated')) continue;
    const source = await readFile(join(root, entry), 'utf8');
    expect(source, entry).not.toMatch(/@ts-(?:ignore|nocheck)/);
    const file = ts.createSourceFile(
      entry,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      expect(node.kind, `Authored explicit any in ${entry}`).not.toBe(
        ts.SyntaxKind.AnyKeyword,
      );
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
}

describe('generated project golden matrix', () => {
  it.each(scenarios)('$label', async (scenario) => {
    const cwd = await mkdtemp(join(tmpdir(), 'ccm-golden-'));
    try {
      const root = await generateProject(
        {
          packageManager: scenario.packageManager ?? 'pnpm',
          name: 'golden-app',
          apps: scenario.apps,
          auth: scenario.auth,
          example: scenario.example ?? 'messages',
          install: false,
          git: false,
        },
        { cwd },
      );
      const manager = scenario.packageManager ?? 'pnpm';
      const run = manager === 'bun' ? 'bun run' : 'pnpm';
      const read = (path: string) => readFile(join(root, path), 'utf8');
      const json = async <T>(path: string): Promise<T> =>
        JSON.parse(await read(path));
      const manifest = await json<PackageManifest>('package.json');
      if (scenario.auth === 'convex-auth') {
        expect(manifest.scripts?.['convex:auth-keys']).toBe(
          'node scripts/convex-auth-keys.mjs',
        );
        expect(await read('scripts/convex-auth-keys.mjs')).toBe(
          await readFile(
            new URL('../assets/setup/convex-auth-keys.mjs', import.meta.url),
            'utf8',
          ),
        );
        expect(await read('README.md')).toContain(
          `${run} convex:auth-keys --prod`,
        );
        expect(
          await read('packages/backend/.env.convex-auth.example'),
        ).toContain(`${run} convex:auth-keys`);
      } else {
        expect(manifest.scripts).not.toHaveProperty('convex:auth-keys');
        expect(await readdir(join(root, 'scripts'))).not.toContain(
          'convex-auth-keys.mjs',
        );
      }
      if (scenario.auth === 'better-auth') {
        const readme = await read('README.md');
        expect(readme).toContain(`${run} convex:setup`);
        expect(readme).toContain(`${run} convex:better-auth-env`);
        expect(readme).toContain(`${run} convex:dev`);
        if (manager === 'bun') expect(readme).not.toContain('pnpm');
        expect(manifest.scripts?.['convex:better-auth-env']).toBe(
          'node scripts/better-auth-env.mjs',
        );
        expect(await read('scripts/better-auth-env.mjs')).toBe(
          await readFile(
            new URL('../assets/setup/better-auth-env.mjs', import.meta.url),
            'utf8',
          ),
        );
        expect(await read('README.md')).toContain('## Better Auth setup');
      } else {
        expect(manifest.scripts).not.toHaveProperty('convex:better-auth-env');
      }
      const config = await json<ProjectOptions & { generator: string }>(
        'convex-monorepo.json',
      );
      expect(config.generator).toBe(await getPackageVersion());
      expect(
        config.apps.map(({ name, framework }) => [name, framework]),
      ).toEqual(
        scenario.expected.map(([name, framework]) => [name, framework]),
      );
      expect(manifest).toMatchObject({
        name: 'golden-app',
        private: true,
        packageManager: `${manager}@${versions[manager]}`,
        scripts: {
          dev: `turbo run dev --ui=stream --concurrency=${config.apps.length + 2}`,
          build: 'turbo run build',
          typecheck: 'turbo run typecheck',
          lint: 'turbo run lint',
          'convex:dev': `${run} --filter @golden-app/backend dev`,
        },
      });
      expect(config.packageManager).toBe(manager);
      if (manager === 'bun') {
        expect(manifest.workspaces).toEqual(['apps/*', 'packages/*']);
        expect(await readdir(root)).not.toContain('pnpm-workspace.yaml');
        expect(await read('.gitignore')).not.toContain('bun.lock');
        const readme = await read('README.md');
        expect(readme).toContain('bun install');
        expect(readme).toContain('bun run dev');
        expect(readme).not.toContain('pnpm');
        expect(readme.match(/## Install and run/g)).toHaveLength(1);
        expect(readme).not.toContain('## Development');
      } else {
        expect(await read('pnpm-workspace.yaml')).toContain("'apps/*'");
        expect(await read('pnpm-workspace.yaml')).toContain("'packages/*'");
      }
      expect((await readdir(join(root, 'packages'))).sort()).toEqual([
        'backend',
        'eslint-config',
        'typescript-config',
      ]);
      expect(await read('.gitignore')).toContain('.env*');
      expect(await read('.gitignore')).not.toContain('_generated');
      const backend = await json<PackageManifest>(
        'packages/backend/package.json',
      );
      expect(backend.exports).toEqual({
        './api': {
          types: './convex/_generated/api.d.ts',
          default: './convex/_generated/api.js',
        },
        './dataModel': { types: './convex/_generated/dataModel.d.ts' },
      });
      expect(backend.dependencies).toEqual({
        convex: versions.convex,
        ...(scenario.auth === 'better-auth'
          ? {
              '@convex-dev/better-auth': versions.convexBetterAuth,
              'better-auth': versions.betterAuth,
              '@better-auth/expo': versions.betterAuthExpo,
              '@better-auth/core': versions.betterAuth,
            }
          : {}),
        ...(scenario.auth === 'convex-auth'
          ? {
              '@convex-dev/auth': versions.convexAuth,
              '@auth/core': versions.authCore,
            }
          : {}),
      });
      expect(backend.scripts).toMatchObject({
        dev: 'convex dev',
        codegen: 'convex codegen',
      });
      expect(backend.scripts?.build).not.toMatch(/deploy|codegen/);
      const api = await read('packages/backend/convex/_generated/api.d.ts');
      expect(api).toContain('ApiFromModules');
      if (scenario.example === 'none') {
        expect(api).not.toMatch(/messages|access\.js/);
      } else {
        expect(api).toContain('messages: typeof messages');
        expect(api).toContain('access: typeof access');
      }
      if (scenario.auth === 'convex-auth' || scenario.auth === 'better-auth') {
        expect(api).toContain('../auth.js');
        expect(api).toContain('../http.js');
      }
      expect(await read('packages/backend/convex/_generated/api.js')).toContain(
        'anyApi',
      );
      expect(
        await read('packages/backend/convex/_generated/dataModel.d.ts'),
      ).toContain('../schema.js');
      expect(
        await read('packages/backend/convex/_generated/server.d.ts'),
      ).toContain('DataModel');
      expect(
        await read('packages/backend/convex/_generated/server.js'),
      ).toContain('queryGeneric');
      if (scenario.example !== 'none') {
        const messages = await read('packages/backend/convex/messages.ts');
        expect(messages).toContain('getOwner(ctx)');
        expect(messages).toContain("withIndex('by_owner'");
        expect(messages).toContain("q.eq('owner', owner)");
        expect(messages).toContain('take(50)');
        const access = await read('packages/backend/convex/access.ts');
        if (scenario.auth === 'clerk') {
          expect(access).toContain('ctx.auth.getUserIdentity()');
          expect(access).toMatch(/if \(!identity\) throw/);
          expect(access).toContain('identity.tokenIdentifier');
          expect(
            await read('packages/backend/convex/auth.config.ts'),
          ).toContain("applicationID: 'convex'");
        } else if (scenario.auth === 'workos') {
          expect(access).toContain('ctx.auth.getUserIdentity()');
          expect(access).toMatch(/if \(!identity\) throw/);
          expect(access).toContain('return identity.subject');
          expect(access).not.toContain('tokenIdentifier');
        } else if (scenario.auth === 'convex-auth') {
          expect(access).toContain('getAuthUserId(ctx)');
          expect(access).toContain('Promise<string>');
          expect(access).toContain('Sign in to access messages.');
          expect(access).not.toContain('tokenIdentifier');
        } else if (scenario.auth === 'better-auth') {
          expect(access).toContain('authComponent.getAuthUser(ctx)');
          expect(access).toContain('return user._id');
          expect(access).not.toContain('tokenIdentifier');
        } else {
          expect(access).toContain('return undefined');
          expect(
            await readdir(join(root, 'packages/backend/convex')),
          ).not.toContain('auth.config.ts');
        }
      }
      if (scenario.auth === 'convex-auth') {
        expect(await read('packages/backend/convex/schema.ts')).toContain(
          '...authTables',
        );
        expect(await read('packages/backend/convex/auth.ts')).toContain(
          '@convex-dev/auth/providers/Password',
        );
        expect(await read('packages/backend/convex/auth.ts')).toContain(
          'providers: [Password]',
        );
        expect(await read('packages/backend/convex/http.ts')).toContain(
          'auth.addHttpRoutes(http)',
        );
        const authConfig = await read('packages/backend/convex/auth.config.ts');
        expect(authConfig).toContain('process.env.CONVEX_SITE_URL');
        expect(authConfig).toContain("applicationID: 'convex'");
        const deploymentEnv = await read(
          'packages/backend/.env.convex-auth.example',
        );
        for (const variable of ['JWT_PRIVATE_KEY', 'JWKS', 'SITE_URL'])
          expect(deploymentEnv).toContain(variable);
        expect(await read('README.md')).toContain('## Convex Auth setup');
      }
      if (scenario.auth === 'better-auth') {
        const readme = await read('README.md');
        expect(readme).toContain(`${run} convex:setup`);
        expect(readme).toContain(`${run} convex:better-auth-env`);
        expect(readme).toContain(`${run} convex:dev`);
        if (manager === 'bun') expect(readme).not.toContain('pnpm');
        expect(api).toContain('betterAuth');
        expect(
          await read('packages/backend/convex/convex.config.ts'),
        ).toContain('app.use(betterAuth)');
        expect(await read('packages/backend/convex/auth.config.ts')).toContain(
          'getAuthConfigProvider()',
        );
        const authSource = await read('packages/backend/convex/auth.ts');
        expect(authSource).toContain('components.betterAuth');
        expect(authSource).toContain('emailAndPassword:');
        expect(authSource).toContain('requireEmailVerification: false');
        expect(authSource).toContain('crossDomain({ siteUrl })');
        expect(authSource).toContain('convex({ authConfig })');
        expect(await read('packages/backend/convex/http.ts')).toContain(
          'authComponent.registerRoutes(http, createAuth, { cors: true })',
        );
        expect(await read('packages/backend/convex/schema.ts')).not.toContain(
          'authTables',
        );
        const deploymentEnv = await read(
          'packages/backend/.env.better-auth.example',
        );
        expect(deploymentEnv).toContain(`${run} convex:better-auth-env`);
        for (const variable of [
          'BETTER_AUTH_SECRET',
          'SITE_URL',
          'BETTER_AUTH_TRUSTED_ORIGINS',
        ])
          expect(deploymentEnv).toContain(variable);
      }
      if (scenario.auth === 'workos') {
        const readme = await read('README.md');
        expect(readme).toContain(`${run} convex:setup`);
        expect(readme).toContain(
          manager === 'bun'
            ? 'bun run --cwd packages/backend convex env set WORKOS_CLIENT_ID'
            : 'pnpm --filter @golden-app/backend exec convex env set WORKOS_CLIENT_ID',
        );
        if (manager === 'bun') expect(readme).not.toContain('pnpm');
        expect(await read('packages/backend/convex/auth.config.ts')).toContain(
          'WORKOS_CLIENT_ID',
        );
        expect(await read('packages/backend/.env.workos.example')).toContain(
          'WORKOS_CLIENT_ID',
        );
        expect(await read('README.md')).toContain('## WorkOS setup');
        expect(await read('README.md')).toContain('WORKOS_COOKIE_NAME');
        expect(await read('README.md')).toContain(
          'https://workos.com/docs/authkit/sessions#sign-out-uris',
        );
        expect(await read('README.md')).toContain('session JWT template');
        expect(await read('README.md')).toContain(
          'aud claim equal to that same client ID',
        );
        expect(await read('packages/backend/convex/auth.config.ts')).toContain(
          'applicationID: clientId',
        );
        expect(await read('packages/backend/.env.workos.example')).toContain(
          'https://api.workos.com/user_management/client_',
        );
        expect(await read('.gitignore')).toContain('!.env.workos.example');
      }
      for (const [name, framework, prefix, sdk] of scenario.expected) {
        const dir = `apps/${name}`;
        const app = await json<PackageManifest>(`${dir}/package.json`);
        expect(app.name).toBe(`@golden-app/${name}`);
        expect(app.dependencies).toMatchObject({
          '@golden-app/backend': 'workspace:*',
          convex: versions.convex,
          react: versions.react,
        });
        expect(app.devDependencies).toMatchObject({
          '@golden-app/typescript-config': 'workspace:*',
          '@golden-app/eslint-config': 'workspace:*',
          typescript: versions.typescript,
        });
        for (const [dependency, version] of Object.entries({
          ...app.dependencies,
          ...app.devDependencies,
        })) {
          expect(version, dependency).toMatch(
            /^(?:workspace:\*|\d+\.\d+\.\d+)$/,
          );
        }
        expect(manifest.scripts?.[`dev:${name}`]).toBe(
          `${run} --filter @golden-app/${name} dev`,
        );
        expect(await read(`${dir}/.env.example`)).toContain(
          `${prefix}_CONVEX_URL=\n`,
        );
        const providers = await read(`${dir}/src/providers.tsx`);
        expect(providers).toContain(`${prefix}_CONVEX_URL`);
        if (scenario.example !== 'none') {
          const demo = await read(`${dir}/src/messages.tsx`);
          expect(demo).toContain("from '@golden-app/backend/api'");
          expect(demo).toContain('useQuery(api.messages.list, {})');
          expect(demo).toContain('useMutation(api.messages.send)');
          const contract = await read(`${dir}/src/convex-api.type-test.ts`);
          expect(contract).toContain('IsAny<typeof api>');
          expect(contract).toContain("Doc<'messages'>[]");
          expect(contract).toContain(
            'FunctionArgs<typeof api.messages.send>, { body: string }',
          );
          expect(contract).toContain('@ts-expect-error');
        } else {
          expect(await readdir(join(root, dir, 'src'))).not.toContain(
            'messages.tsx',
          );
          expect(await readdir(join(root, dir, 'src'))).not.toContain(
            'convex-api.type-test.ts',
          );
        }
        if (scenario.auth === 'convex-auth') {
          expect(app.dependencies).toHaveProperty(
            '@convex-dev/auth',
            versions.convexAuth,
          );
          expect(providers).toContain("from '@convex-dev/auth/react'");
          expect(providers).toContain('<ConvexAuthProvider');
          expect(providers).toContain('<Authenticated>');
          expect(providers).toContain('<AuthLoading>');
          expect(providers).toMatch(/<Unauthenticated>\s*<AuthControls \/>/);
          expect(providers).not.toContain('CLERK_');
          const files = await readdir(join(root, dir));
          expect(files).not.toContain('.env.clerk.example');
          expect(await read(`${dir}/.env.example`)).not.toMatch(
            /JWT_PRIVATE_KEY|JWKS|CLERK_/,
          );
          const controls = await read(`${dir}/src/auth-controls.tsx`);
          expect(controls).toContain('useAuthActions');
          expect(controls).toContain("signIn('password'");
          expect(controls).toContain('signOut');
          expect(controls).toContain('signUp');
          expect(controls).toContain('signIn');
          expect(controls).not.toContain('alert(');
          if (framework === 'expo') {
            expect(app.dependencies).toHaveProperty(
              'expo-secure-store',
              '57.0.3',
            );
            expect(controls).toContain('TextInput');
            expect(controls).toContain('secureTextEntry');
            expect(providers).toContain('expo-secure-store');
            expect(providers).toContain('storage={');
            expect(providers).toContain('getItemAsync');
            expect(providers).toContain('setItemAsync');
            expect(providers).toContain('deleteItemAsync');
            expect(controls).not.toContain('scheme:');
          } else {
            expect(controls).toContain('<form');
            expect(controls).toContain('type="email"');
            expect(controls).toContain('type="password"');
          }
          if (framework === 'next') {
            expect(await readdir(join(root, dir, 'src'))).not.toContain(
              'proxy.ts',
            );
            expect(providers).not.toContain('@convex-dev/auth/nextjs');
          }
        } else if (scenario.auth === 'better-auth') {
          expect(app.dependencies).toMatchObject({
            'better-auth': versions.betterAuth,
            '@convex-dev/better-auth': versions.convexBetterAuth,
          });
          expect(providers).toContain('ConvexBetterAuthProvider');
          expect(providers).toContain('<Authenticated>');
          expect(providers).toContain('<AuthLoading>');
          expect(providers).toMatch(/<Unauthenticated>\s*<AuthControls \/>/);
          expect(providers).toContain(`${prefix}_CONVEX_SITE_URL`);
          const client = await read(`${dir}/src/auth-client.ts`);
          expect(client).toContain("from 'better-auth/react'");
          expect(client).toContain(
            "from '@convex-dev/better-auth/client/plugins'",
          );
          expect(client).toContain('convexClient()');
          expect(client).toContain('crossDomainClient()');
          const controls = await read(`${dir}/src/auth-controls.tsx`);
          for (const operation of [
            'authClient.signUp.email',
            'authClient.signIn.email',
            'authClient.signOut',
            'result.error',
            'setPending(true)',
            'setPending(false)',
          ])
            expect(controls).toContain(operation);
          expect(controls).not.toContain('alert(');
          const env = await read(`${dir}/.env.better-auth.example`);
          expect(env).toContain(`${prefix}_CONVEX_SITE_URL=\n`);
          expect(env).not.toContain('BETTER_AUTH_SECRET');
          if (framework === 'expo') {
            expect(app.dependencies).toMatchObject({
              '@better-auth/expo': versions.betterAuthExpo,
              'expo-secure-store': versions.expoSecureStore,
            });
            expect(client).toContain("Platform.OS === 'web'");
            expect(client).toContain('expoClient(');
            expect(client).toContain('storage: SecureStore');
            const expoConfig = await json<{ expo: { scheme: string } }>(
              `${dir}/app.json`,
            );
            expect(client).toContain(`scheme: '${expoConfig.expo.scheme}'`);
            expect(controls).toContain('secureTextEntry');
          } else {
            expect(controls).toContain('type="email"');
            expect(controls).toContain('type="password"');
            expect(client).not.toContain('expoClient');
          }
        } else if (scenario.auth === 'workos') {
          const pin =
            framework === 'next'
              ? versions.workosNext
              : framework === 'vite'
                ? versions.workosReact
                : versions.workosTanstack;
          expect(app.dependencies).toHaveProperty(sdk!, pin);
          expect(providers).toContain('ConvexProviderWithAuth');
          expect(providers).toContain('<Authenticated>');
          expect(providers).toContain('<AuthLoading>');
          expect(providers).toContain('<Unauthenticated>');
          expect(providers).toContain('<AuthControls');
          expect(providers).not.toMatch(
            /WORKOS_API_KEY|WORKOS_COOKIE_PASSWORD/,
          );
          const env = await read(`${dir}/.env.workos.example`);
          expect(env).toContain(`${prefix}_WORKOS_CLIENT_ID=\n`);
          expect(env).not.toMatch(
            /(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC)_WORKOS_(?:API_KEY|COOKIE_PASSWORD)\s*=/,
          );
          if (framework === 'vite') {
            expect(env).not.toMatch(
              /WORKOS_API_KEY=|WORKOS_COOKIE_PASSWORD=|WORKOS_COOKIE_NAME=/,
            );
            expect(providers).toContain('getAccessToken');
            const controls = await read(`${dir}/src/auth-controls.tsx`);
            expect(controls).toContain('if (!url)');
            expect(controls).toContain('Reload sign-in');
            expect(controls).toContain('finally');
          } else {
            expect(app.dependencies).toHaveProperty(
              '@workos-inc/node',
              versions.workosNode,
            );
            expect(env).toContain('WORKOS_API_KEY=');
            expect(env).toContain('WORKOS_COOKIE_PASSWORD=');
            expect(env).toContain(`WORKOS_COOKIE_NAME=wos-session-${name}\n`);
            expect(providers).toContain('useAccessToken');
          }
          const controls = await read(`${dir}/src/auth-controls.tsx`);
          expect(controls).toMatch(/signIn|sign-in/);
          expect(controls).toContain(
            'signOut({ returnTo: window.location.origin })',
          );
          expect(controls).toMatch(/loading/i);
          expect(controls).toContain('error');
          expect(controls).not.toContain('alert(');
          if (framework === 'next') {
            expect(await read(`${dir}/src/proxy.ts`)).toContain('authkitProxy');
            expect(await read(`${dir}/src/app/callback/route.ts`)).toContain(
              'handleAuth',
            );
            expect(await read(`${dir}/src/app/sign-in/route.ts`)).toContain(
              'getSignInUrl',
            );
          } else if (framework === 'tanstack-start') {
            expect(await read(`${dir}/src/start.ts`)).toContain(
              'authkitMiddleware',
            );
            expect(await read(`${dir}/src/routes/callback.tsx`)).toContain(
              'handleCallbackRoute',
            );
            expect(await read(`${dir}/src/routes/sign-in.tsx`)).toContain(
              'getSignInUrl',
            );
          }
        } else if (sdk) {
          expect(app.dependencies).toHaveProperty(sdk);
          expect(providers).toContain('ConvexProviderWithClerk');
          expect(providers).toContain('<Authenticated>');
          expect(providers).toMatch(/<Unauthenticated>\s*<AuthControls \/>/);
          const env = await read(`${dir}/.env.clerk.example`);
          expect(env).toContain(`${prefix}_CLERK_PUBLISHABLE_KEY=\n`);
          expect(env).not.toMatch(
            /(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC)_CLERK_SECRET_KEY\s*=/,
          );
          if (framework === 'expo' || framework === 'vite')
            expect(env).not.toContain('CLERK_SECRET_KEY=');
          expect(providers).not.toContain('CLERK_SECRET_KEY');
        } else {
          expect(Object.keys(app.dependencies ?? {})).not.toContainEqual(
            expect.stringMatching(/^@clerk\//),
          );
          expect(providers).toContain('<ConvexProvider client={client}>');
        }
        if (framework === 'next') {
          expect(await read(`${dir}/next.config.ts`)).toContain(
            "transpilePackages: ['@golden-app/backend']",
          );
          expect(await read(`${dir}/src/app/page.tsx`)).toContain(
            '<Providers>',
          );
        } else if (framework === 'tanstack-start') {
          expect(app.scripts?.typecheck).toBe('tsr generate && tsc --noEmit');
          expect(await read(`${dir}/vite.config.ts`)).toContain(
            'tanstackStart(), react()',
          );
          expect(await read(`${dir}/src/routes/index.tsx`)).toContain(
            "createFileRoute('/')",
          );
        } else if (framework === 'react-router') {
          expect(app.scripts).toMatchObject({
            dev: 'react-router dev',
            build: 'react-router build',
            start: 'react-router-serve ./build/server/index.js',
            typecheck: 'react-router typegen && tsc',
            lint: 'eslint .',
          });
          for (const dependency of [
            'react-router',
            '@react-router/node',
            '@react-router/serve',
          ])
            expect(app.dependencies).toHaveProperty(dependency);
          expect(app.devDependencies).toHaveProperty('@react-router/dev');
          expect(await json(`${dir}/turbo.json`)).toEqual({
            extends: ['//'],
            tasks: { build: { outputs: ['build/**'] } },
          });
          expect(await read(`${dir}/.gitignore`)).toBe(
            '/.react-router/\n/build/\n',
          );
          expect(await read(`${dir}/eslint.config.js`)).toContain(
            '**/.react-router/**',
          );
          expect(await read(`${dir}/eslint.config.js`)).toContain(
            '**/build/**',
          );

          expect(await read(`${dir}/react-router.config.ts`)).toContain(
            'ssr: true',
          );
          expect(await read(`${dir}/react-router.config.ts`)).toContain(
            'v8_middleware: true',
          );
          expect(await read(`${dir}/vite.config.ts`)).toContain(
            'reactRouter()',
          );
          expect(await read(`${dir}/app/routes.ts`)).toContain(
            "index('routes/home.tsx')",
          );
          const rootEntry = await read(`${dir}/app/root.tsx`);
          expect(rootEntry).toContain('<Providers>');
          expect(rootEntry).toContain('<Outlet');
          expect(rootEntry).toContain('../src/auth.server');
          const route = await read(`${dir}/app/routes/home.tsx`);
          expect(route).toContain('<AuthControls');
          expect(route).not.toMatch(
            /export (?:async )?function loader|export const loader/,
          );
          expect(providers).toContain('import.meta.env.VITE_CONVEX_URL');
          const serverAuth = await read(`${dir}/src/auth.server.ts`);
          if (scenario.auth === 'clerk') {
            expect(serverAuth).toContain('rootAuthLoader');
            expect(serverAuth).toContain('clerkMiddleware');
            expect(serverAuth).toContain('@clerk/react-router/server');
            expect(await read(`${dir}/.env.clerk.example`)).toContain(
              'CLERK_SECRET_KEY=',
            );
            expect(providers).toContain('useRouteLoaderData');
            expect(providers).toContain('loaderData={loaderData}');
          } else {
            expect(serverAuth).not.toContain('@clerk/');
          }
        } else if (framework === 'expo') {
          expect(app.dependencies).toMatchObject({
            expo: versions.expo,
            'react-native': versions.reactNative,
          });
          const metro = await read(`${dir}/metro.config.cjs`);
          expect(metro).toContain("require('expo/metro-config')");
          expect(metro).not.toMatch(
            /watchFolders|extraNodeModules|nodeModulesPaths|disableHierarchicalLookup/,
          );
          expect(providers).toContain('unsavedChangesWarning: false');
          expect(await read(`${dir}/index.ts`)).toContain(
            'registerRootComponent(App)',
          );
          if (scenario.auth === 'clerk')
            expect(providers).toContain("from '@clerk/expo/token-cache'");
        } else {
          expect(await read(`${dir}/src/main.tsx`)).toContain(
            'createRoot(root)',
          );
        }
      }
      await assertAuthoredTypes(root);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

it('supports numeric names with valid, matching Expo auth schemes and enough dev concurrency', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ccm-edge-'));
  try {
    const root = await generateProject(
      {
        name: '123',
        apps: Array.from({ length: 10 }, (_, i) => ({
          name: `mobile-${i}`,
          framework: 'expo' as const,
        })),
        auth: 'clerk',
      },
      { cwd },
    );
    const manifest = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    );
    expect(manifest.scripts.dev).toContain('--concurrency=12');
    const turbo = JSON.parse(await readFile(join(root, 'turbo.json'), 'utf8'));
    expect(turbo.tasks.dev.interactive).not.toBe(true);
    const app = JSON.parse(
      await readFile(join(root, 'apps/mobile-0/app.json'), 'utf8'),
    );
    expect(app.expo.scheme).toMatch(/^[a-z][a-z0-9+.-]*$/);
    expect(
      await readFile(join(root, 'apps/mobile-0/src/auth-controls.tsx'), 'utf8'),
    ).toContain(`scheme: '${app.expo.scheme}'`);
    expect(
      await readFile(join(root, 'apps/mobile-0/.env.clerk.example'), 'utf8'),
    ).toContain(`${app.expo.scheme}://continue`);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain(
      '!.env.clerk.example',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
