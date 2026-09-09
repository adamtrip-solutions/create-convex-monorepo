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
import { versions } from '../src/templates/versions.js';

interface Golden {
  label: string;
  apps: string;
  auth: string;
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
          name: 'golden-app',
          apps: scenario.apps,
          auth: scenario.auth,
          install: false,
          git: false,
        },
        { cwd },
      );
      const read = (path: string) => readFile(join(root, path), 'utf8');
      const json = async <T>(path: string): Promise<T> =>
        JSON.parse(await read(path));
      const manifest = await json<PackageManifest>('package.json');
      const config = await json<ProjectOptions>('convex-monorepo.json');
      expect(
        config.apps.map(({ name, framework }) => [name, framework]),
      ).toEqual(
        scenario.expected.map(([name, framework]) => [name, framework]),
      );
      expect(manifest).toMatchObject({
        name: 'golden-app',
        private: true,
        packageManager: `pnpm@${versions.pnpm}`,
        scripts: {
          dev: `turbo run dev --ui=stream --concurrency=${config.apps.length + 2}`,
          build: 'turbo run build',
          typecheck: 'turbo run typecheck',
          lint: 'turbo run lint',
          'convex:dev': 'pnpm --filter @golden-app/backend dev',
        },
      });
      expect(await read('pnpm-workspace.yaml')).toContain("'apps/*'");
      expect(await read('pnpm-workspace.yaml')).toContain("'packages/*'");
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
      expect(backend.dependencies).toEqual({ convex: versions.convex });
      expect(backend.scripts).toMatchObject({
        dev: 'convex dev',
        codegen: 'convex codegen',
      });
      expect(backend.scripts?.build).not.toMatch(/deploy|codegen/);
      const api = await read('packages/backend/convex/_generated/api.d.ts');
      expect(api).toContain('ApiFromModules');
      expect(api).toContain('messages: typeof messages');
      expect(api).toContain('access: typeof access');
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
        expect(await read('packages/backend/convex/auth.config.ts')).toContain(
          "applicationID: 'convex'",
        );
      } else {
        expect(access).toContain('return undefined');
        expect(
          await readdir(join(root, 'packages/backend/convex')),
        ).not.toContain('auth.config.ts');
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
          `pnpm --filter @golden-app/${name} dev`,
        );
        expect(await read(`${dir}/.env.example`)).toContain(
          `${prefix}_CONVEX_URL=\n`,
        );
        const providers = await read(`${dir}/src/providers.tsx`);
        expect(providers).toContain(`${prefix}_CONVEX_URL`);
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
        if (sdk) {
          expect(app.dependencies).toHaveProperty(sdk);
          expect(providers).toContain('ConvexProviderWithClerk');
          expect(providers).toContain('<Authenticated>');
          expect(providers).toContain('<Unauthenticated><AuthControls />');
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
          if (sdk)
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
