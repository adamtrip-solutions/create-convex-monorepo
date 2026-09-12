import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateProject } from '../src/generator/index.js';
import { doctor } from '../src/workspace/doctor.js';
import { loadWorkspace } from '../src/workspace/project.js';
import { checkUpgrade } from '../src/workspace/upgrade.js';
import { versions } from '../src/templates/versions.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(apps = 'web:next,mobile:expo', auth = 'none') {
  const cwd = await mkdtemp(join(tmpdir(), 'ccm-doctor-'));
  roots.push(cwd);
  const root = await generateProject(
    { name: 'diagnostics', apps, auth, install: false, git: false },
    { cwd },
  );
  return loadWorkspace(root);
}
async function put(root: string, path: string, contents: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const path of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (path.isFile()) {
      const absolute = join(path.parentPath, path.name);
      files[absolute] = await readFile(absolute, 'utf8');
    }
  }
  return files;
}

describe('workspace doctor', () => {
  it.each(['NEXT_PUBLIC', 'VITE', 'EXPO_PUBLIC'])(
    'reports %s signing values in every app environment file without exposing them',
    async (prefix) => {
      const workspace = await fixture('web:next', 'convex-auth');
      for (const filename of [
        '.env',
        '.env.local',
        '.env.production',
        '.env.staging.local',
      ]) {
        await put(
          workspace.root,
          `apps/web/${filename}`,
          `${prefix}_JWT_PRIVATE_KEY=never-expose-private\n${prefix}_JWKS=never-expose-jwks\n`,
        );
        const report = await doctor(workspace);
        expect(
          report.issues.filter((issue) => issue.code === 'public-secret'),
        ).toEqual(
          ['JWT_PRIVATE_KEY', 'JWKS'].map((secret) => ({
            code: 'public-secret',
            severity: 'error',
            message: `apps/web exposes ${secret} through a public environment variable.`,
            fix: 'Remove the public assignment, rotate the exposed credential, and rebuild the app.',
          })),
        );
        expect(JSON.stringify(report)).not.toContain('never-expose');
        await rm(join(workspace.root, `apps/web/${filename}`));
      }
    },
  );
  it('requires SecureStore only in Convex Auth Expo apps', async () => {
    const workspace = await fixture(
      'web:next,spa:vite,start:tanstack-start,mobile:expo',
      'convex-auth',
    );
    const path = join(workspace.root, 'apps/mobile/package.json');
    const pkg = JSON.parse(await readFile(path, 'utf8'));
    expect(pkg.dependencies['expo-secure-store']).toBeDefined();
    delete pkg.dependencies['expo-secure-store'];
    await writeFile(path, JSON.stringify(pkg));
    const report = await doctor(workspace);
    expect(
      report.issues.filter((issue) =>
        issue.message.includes('expo-secure-store'),
      ),
    ).toEqual([
      {
        code: 'dependency-missing',
        severity: 'error',
        message: 'apps/mobile does not declare expo-secure-store.',
        fix: 'Restore the required dependency and run pnpm install.',
      },
    ]);
  });
  it('warns when the backend resolves @auth/core outside the tested baseline', async () => {
    const workspace = await fixture('web:vite', 'convex-auth');
    const path = 'packages/backend/node_modules/@auth/core/package.json';
    await put(
      workspace.root,
      path,
      JSON.stringify({ name: '@auth/core', version: '0.1.0' }),
    );
    const report = await doctor(workspace);
    expect(report.issues).toContainEqual({
      code: 'dependency-baseline',
      severity: 'warning',
      message:
        'packages/backend resolves @auth/core@0.1.0, outside this CLI’s tested baseline.',
      fix: 'Run npx create-convex-monorepo@latest upgrade, then pnpm install.',
    });
    await put(
      workspace.root,
      path,
      JSON.stringify({ name: '@auth/core', version: versions.authCore }),
    );
    expect(
      (await doctor(workspace)).issues.filter(
        (issue) =>
          issue.code === 'dependency-baseline' &&
          issue.message.includes('@auth/core'),
      ),
    ).toEqual([]);
  });
  it('reports missing Clerk backend config and public secret assignments without values', async () => {
    const workspace = await fixture('web:next');
    workspace.config.auth = 'clerk';
    await put(
      workspace.root,
      'apps/web/.env.local',
      'NEXT_PUBLIC_CLERK_SECRET_KEY=never-expose-this\n',
    );
    const report = await doctor(workspace);
    expect(
      report.issues.some((issue) => issue.code === 'auth-config-missing'),
    ).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'public-secret')).toBe(
      true,
    );
    expect(JSON.stringify(report)).not.toContain('never-expose-this');
  });
  it('checks Convex Auth files and dependencies without requiring Clerk keys', async () => {
    const workspace = await fixture('web:next,mobile:expo', 'convex-auth');
    const before = await snapshot(workspace.root);
    const initial = await doctor(workspace);
    expect(
      initial.issues.filter((issue) => issue.code === 'auth-env-missing'),
    ).toEqual([]);
    expect(
      initial.issues.filter((issue) => issue.code === 'auth-config-missing'),
    ).toEqual([]);
    expect(
      initial.issues.filter(
        (issue) =>
          issue.code === 'dependency-uninstalled' &&
          issue.message.includes('@convex-dev/auth'),
      ),
    ).toHaveLength(3);
    expect(await snapshot(workspace.root)).toEqual(before);
    for (const name of ['auth.config.ts', 'auth.ts', 'http.ts'])
      await rm(join(workspace.root, `packages/backend/convex/${name}`));
    const missing = await doctor(workspace);
    for (const name of ['auth.config.ts', 'auth.ts', 'http.ts']) {
      const issue = missing.issues.find(
        (issue) =>
          issue.code === 'auth-config-missing' &&
          issue.message.includes(`convex/${name}`),
      );
      expect(issue?.fix).toContain(`packages/backend/convex/${name}`);
    }
    expect(
      missing.issues.filter((issue) => issue.code === 'auth-env-missing'),
    ).toEqual([]);
  });
  it('reports missing installs and URLs without changing generated files', async () => {
    const workspace = await fixture();
    const before = await snapshot(workspace.root);
    const result = await doctor(workspace);
    expect(
      result.issues.some((issue) => issue.code === 'dependency-uninstalled'),
    ).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'backend-url')).toBe(
      true,
    );
    expect(
      result.issues.filter((issue) => issue.code === 'app-url'),
    ).toHaveLength(2);
    expect(
      result.issues.some((issue) => issue.code === 'backend-declarations'),
    ).toBe(false);
    expect(
      result.checks.some((check) =>
        check.includes('native execution were not evaluated'),
      ),
    ).toBe(true);
    expect(await snapshot(workspace.root)).toEqual(before);
  });
  it('uses framework URL keys, reports missing Clerk keys, and never prints values', async () => {
    const workspace = await fixture(
      'web:next,spa:vite,start:tanstack-start,mobile:expo',
      'clerk',
    );
    await put(
      workspace.root,
      'packages/backend/.env.local',
      'CONVEX_URL=https://secret-backend.convex.cloud\n',
    );
    await put(
      workspace.root,
      'apps/web/.env.local',
      'NEXT_PUBLIC_CONVEX_URL="https://other-private.convex.cloud"\nCLERK_SECRET_KEY=sk_secret_do_not_print\n',
    );
    await put(
      workspace.root,
      'apps/spa/.env.local',
      'VITE_CONVEX_URL=https://secret-backend.convex.cloud\n',
    );
    await put(
      workspace.root,
      'apps/start/.env.local',
      'NEXT_PUBLIC_CONVEX_URL=https://secret-backend.convex.cloud\n',
    );
    await put(
      workspace.root,
      'apps/mobile/.env.local',
      'EXPO_PUBLIC_CONVEX_URL=https://secret-backend.convex.cloud\n',
    );
    const result = await doctor(workspace);
    expect(
      result.issues.filter((issue) => issue.code === 'app-url-mismatch'),
    ).toHaveLength(1);
    expect(
      result.issues.filter((issue) => issue.code === 'app-url'),
    ).toHaveLength(1);
    expect(
      result.issues.filter((issue) => issue.code === 'auth-env-missing'),
    ).toHaveLength(5);
    expect(JSON.stringify(result)).not.toMatch(
      /secret-backend|other-private|sk_secret/,
    );
  });
  it('reads .env defaults and gives .env.local priority for backend and apps', async () => {
    const workspace = await fixture('web:vite');
    await put(
      workspace.root,
      'packages/backend/.env',
      'CONVEX_URL=https://default-private.convex.cloud\n',
    );
    await put(
      workspace.root,
      'apps/web/.env',
      'VITE_CONVEX_URL=https://default-private.convex.cloud\n',
    );
    const defaults = await doctor(workspace);
    expect(
      defaults.issues.filter((issue) =>
        ['backend-url', 'app-url', 'app-url-mismatch'].includes(issue.code),
      ),
    ).toEqual([]);
    await put(
      workspace.root,
      'packages/backend/.env.local',
      'CONVEX_URL=https://override-private.convex.cloud\n',
    );
    expect(
      (await doctor(workspace)).issues.filter(
        (issue) => issue.code === 'app-url-mismatch',
      ),
    ).toHaveLength(1);
    await put(
      workspace.root,
      'apps/web/.env.local',
      'VITE_CONVEX_URL=https://override-private.convex.cloud\n',
    );
    const overrides = await doctor(workspace);
    expect(
      overrides.issues.filter((issue) =>
        ['backend-url', 'app-url', 'app-url-mismatch'].includes(issue.code),
      ),
    ).toEqual([]);
    expect(JSON.stringify(overrides)).not.toMatch(
      /default-private|override-private/,
    );
    await put(workspace.root, 'apps/web/.env.local', 'VITE_CONVEX_URL=\n');
    expect(
      (await doctor(workspace)).issues.filter(
        (issue) => issue.code === 'app-url',
      ),
    ).toHaveLength(1);
  });
  it('ignores assignments inside multiline quoted values and handles comments', async () => {
    const workspace = await fixture('web:vite', 'clerk');
    await put(
      workspace.root,
      'packages/backend/.env',
      `CONVEX_URL="https://correct-private.convex.cloud" # comment
UNRELATED="multiline secret
CONVEX_URL=https://fake-private.convex.cloud
closing secret"
`,
    );
    await put(
      workspace.root,
      'apps/web/.env',
      `VITE_CONVEX_URL='https://correct-private.convex.cloud' # comment
UNRELATED="multiline secret
VITE_CONVEX_URL=https://fake-private.convex.cloud
VITE_CLERK_PUBLISHABLE_KEY=embedded-private-key
closing secret"
`,
    );
    const result = await doctor(workspace);
    expect(
      result.issues.filter((issue) =>
        ['backend-url', 'app-url', 'app-url-mismatch'].includes(issue.code),
      ),
    ).toEqual([]);
    expect(
      result.issues.filter((issue) => issue.code === 'auth-env-missing'),
    ).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(
      /correct-private|fake-private|embedded-private|closing secret/,
    );
  });
  it('rejects whitespace in quoted deployment URLs and reports unsafe environment files', async () => {
    const workspace = await fixture('web:vite');
    await put(
      workspace.root,
      'packages/backend/.env',
      'CONVEX_URL=" https://private.convex.cloud"\n',
    );
    await put(
      workspace.root,
      'apps/web/.env',
      'VITE_CONVEX_URL="https://private.convex.cloud\t"\n',
    );
    const whitespace = await doctor(workspace);
    expect(
      whitespace.issues.filter((issue) =>
        ['backend-url', 'app-url'].includes(issue.code),
      ),
    ).toHaveLength(2);
    await symlink(
      join(workspace.root, 'packages/backend/.env'),
      join(workspace.root, 'apps/web/.env.local'),
    );
    const unsafe = await doctor(workspace);
    expect(
      unsafe.issues.some(
        (issue) =>
          issue.code === 'unsafe-file' &&
          issue.message.includes('apps/web/.env.local'),
      ),
    ).toBe(true);
    expect(JSON.stringify(unsafe)).not.toContain('private.convex.cloud');
  });
  it('reports unknown app directories, missing apps, malformed manifests, and unsafe exports', async () => {
    const workspace = await fixture();
    await mkdir(join(workspace.root, 'apps/custom'));
    await rm(join(workspace.root, 'apps/mobile'), { recursive: true });
    await put(workspace.root, 'apps/web/package.json', '{broken');
    await put(
      workspace.root,
      'packages/backend/package.json',
      JSON.stringify({
        name: '@diagnostics/backend',
        exports: { './api': { types: '../outside.d.ts' } },
      }),
    );
    const result = await doctor(workspace);
    expect(result.issues.some((issue) => issue.code === 'untracked-app')).toBe(
      true,
    );
    expect(
      result.issues.filter((issue) => issue.code === 'manifest-invalid'),
    ).toHaveLength(2);
    expect(result.issues.some((issue) => issue.code === 'unsafe-file')).toBe(
      true,
    );
    expect(
      result.issues.some((issue) => issue.code === 'backend-runtime'),
    ).toBe(true);
  });
  it('runs an in-memory type probe against installed TypeScript and detects an untyped API', async () => {
    const workspace = await fixture('web:vite');
    const require = createRequire(import.meta.url);
    // The fixture uses the real compiler through a local package entry, without an install.
    await put(
      workspace.root,
      'node_modules/typescript/package.json',
      JSON.stringify({
        name: 'typescript',
        version: versions.typescript,
        main: 'index.cjs',
      }),
    );
    await put(
      workspace.root,
      'node_modules/typescript/index.cjs',
      `module.exports = require(${JSON.stringify(require.resolve('typescript'))});`,
    );
    await put(
      workspace.root,
      'apps/web/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          target: 'ES2023',
          types: [],
        },
      }),
    );
    await mkdir(join(workspace.root, 'node_modules/@diagnostics'), {
      recursive: true,
    });
    await symlink(
      join(workspace.root, 'packages/backend'),
      join(workspace.root, 'node_modules/@diagnostics/backend'),
    );
    await put(
      workspace.root,
      'packages/backend/convex/_generated/api.d.ts',
      'export declare const api: { custom: { run: { name: string } } };\n',
    );
    await put(
      workspace.root,
      'packages/backend/convex/_generated/dataModel.d.ts',
      'export type DataModel = { custom: { document: { name: string } } };\n',
    );
    const before = await snapshot(workspace.root);
    const healthy = await doctor(workspace);
    expect(
      healthy.issues.filter(
        (issue) =>
          issue.code === 'backend-types' || issue.code === 'type-probe',
      ),
    ).toEqual([]);
    expect(
      healthy.checks.some((check) => check.includes('resolves backend API')),
    ).toBe(true);
    expect(await snapshot(workspace.root)).toEqual(before);
    await put(
      workspace.root,
      'packages/backend/convex/_generated/api.d.ts',
      'export declare const api: Record<string, unknown>;\n',
    );
    expect(
      (await doctor(workspace)).issues.some(
        (issue) => issue.code === 'backend-types',
      ),
    ).toBe(true);
    await put(
      workspace.root,
      'packages/backend/convex/_generated/api.d.ts',
      'export declare const api: { custom: { run: ReturnType<typeof JSON.parse> } };\n',
    );
    expect(
      (await doctor(workspace)).issues.some(
        (issue) =>
          issue.code === 'backend-types' &&
          issue.message.includes('untyped API module or function reference'),
      ),
    ).toBe(true);
    await put(
      workspace.root,
      'packages/backend/convex/_generated/api.d.ts',
      'export declare const api: { nested: { custom: { run: { _type: "query"; _args: ReturnType<typeof JSON.parse> } } } };\n',
    );
    expect(
      (await doctor(workspace)).issues.filter(
        (issue) =>
          issue.code === 'backend-types' || issue.code === 'type-probe',
      ),
    ).toEqual([]);
  });
  it('detects installed version drift and incompatible workspace SDK versions', async () => {
    const workspace = await fixture('web:vite');
    await put(
      workspace.root,
      'node_modules/convex/package.json',
      JSON.stringify({ name: 'convex', version: versions.convex }),
    );
    await put(
      workspace.root,
      'apps/web/node_modules/convex/package.json',
      JSON.stringify({ name: 'convex', version: '1.0.0' }),
    );
    const result = await doctor(workspace);
    expect(
      result.issues.some((issue) => issue.code === 'dependency-version'),
    ).toBe(true);
    expect(
      result.issues.some((issue) => issue.code === 'dependency-incompatible'),
    ).toBe(true);
  });
  it.each([
    'packages: ["elsewhere/*"]\n',
    "packages:\n  - 'elsewhere/*' # excludes generated packages\nonlyBuiltDependencies:\n  - esbuild\n",
  ])('reports concrete pnpm package exclusions for %s', async (contents) => {
    const workspace = await fixture('web:vite');
    await put(workspace.root, 'pnpm-workspace.yaml', contents);
    const result = await doctor(workspace);
    expect(
      result.issues.filter(
        (issue) => issue.code === 'workspace-package-excluded',
      ),
    ).toHaveLength(2);
    expect(
      result.issues.filter(
        (issue) => issue.code === 'workspace-layout-unverified',
      ),
    ).toEqual([]);
  });
  it.each([
    "# Workspace packages\npackages: # generated list\n  # Apps\n  - 'apps/*' # frontends\n  - 'packages/*'\nonlyBuiltDependencies:\n  - esbuild\n",
    "packages: ['apps/*', 'packages/*'] # compact list\nlinkWorkspacePackages: true\n",
  ])(
    'accepts supported pnpm package layouts with comments and extra settings',
    async (contents) => {
      const workspace = await fixture('web:vite');
      await put(workspace.root, 'pnpm-workspace.yaml', contents);
      const result = await doctor(workspace);
      expect(
        result.issues.filter(
          (issue) =>
            issue.code.startsWith('workspace-package') ||
            issue.code === 'workspace-layout-unverified',
        ),
      ).toEqual([]);
      expect(
        result.checks.some((check) =>
          check.includes('pnpm package list includes'),
        ),
      ).toBe(true);
    },
  );
  it('warns about unsupported pnpm syntax without claiming packages are excluded', async () => {
    const workspace = await fixture('web:vite');
    await put(
      workspace.root,
      'pnpm-workspace.yaml',
      "packages:\n  - '**'\ncustomSecret: private-do-not-print\n",
    );
    const result = await doctor(workspace);
    expect(
      result.issues.filter(
        (issue) => issue.code === 'workspace-layout-unverified',
      ),
    ).toHaveLength(1);
    expect(
      result.issues.find(
        (issue) => issue.code === 'workspace-layout-unverified',
      )?.severity,
    ).toBe('warning');
    expect(
      result.issues.filter(
        (issue) => issue.code === 'workspace-package-excluded',
      ),
    ).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-do-not-print');
    await put(
      workspace.root,
      'pnpm-workspace.yaml',
      "packages: ['apps/*', 'packages/*', '!apps/web']\n",
    );
    expect(
      (await doctor(workspace)).issues.filter(
        (issue) => issue.code === 'workspace-package-excluded',
      ),
    ).toHaveLength(1);
  });
  it('reports missing Turbo tasks, malformed configuration, and metadata name drift', async () => {
    const workspace = await fixture('web:vite');
    await put(
      workspace.root,
      'turbo.json',
      JSON.stringify({ tasks: {}, privateSecret: 'never-print-secret' }),
    );
    const rootPkg: Record<string, unknown> = JSON.parse(
      await readFile(join(workspace.root, 'package.json'), 'utf8'),
    );
    const backendPkg: Record<string, unknown> = JSON.parse(
      await readFile(
        join(workspace.root, 'packages/backend/package.json'),
        'utf8',
      ),
    );
    await put(
      workspace.root,
      'package.json',
      JSON.stringify({ ...rootPkg, name: 'different-root' }),
    );
    await put(
      workspace.root,
      'packages/backend/package.json',
      JSON.stringify({ ...backendPkg, name: '@different/backend' }),
    );
    const result = await doctor(workspace);
    expect(
      result.issues.filter((issue) => issue.code === 'turbo-task-missing'),
    ).toHaveLength(4);
    expect(result.issues.some((issue) => issue.code === 'workspace-name')).toBe(
      true,
    );
    expect(result.issues.some((issue) => issue.code === 'backend-name')).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain('never-print-secret');
    await put(workspace.root, 'turbo.json', '{ invalid-private-config');
    const malformed = await doctor(workspace);
    expect(
      malformed.issues.some((issue) => issue.code === 'config-invalid'),
    ).toBe(true);
    expect(JSON.stringify(malformed)).not.toContain('invalid-private-config');
  });
  it('respects cancellation', async () => {
    const workspace = await fixture();
    await expect(
      doctor(workspace, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe('upgrade check', () => {
  it('fetches only the official generator and compares numeric semver components', async () => {
    const workspace = await fixture();
    workspace.config.generator = '0.9.0';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ version: '0.10.0' })));
    const before = await snapshot(workspace.root);
    const result = await checkUpgrade(workspace, { fetch });
    expect(result.projectBehind).toBe(true);
    expect(result.latestStable).toBe('0.10.0');
    expect(result.baseline).toEqual(versions);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://registry.npmjs.org/create-convex-monorepo/latest',
    );
    expect(await snapshot(workspace.root)).toEqual(before);
  });
  it.each(['0.2.1-rc.1', 'garbage', '01.2.3', '1.2', '1.2.3.4'])(
    'rejects nonstable or invalid registry version %s',
    async (version) => {
      const workspace = await fixture();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response(JSON.stringify({ version })));
      await expect(checkUpgrade(workspace, { fetch })).rejects.toThrow(
        'stable semantic version',
      );
    },
  );
  it('recognizes prereleases and build metadata in the project version', async () => {
    const workspace = await fixture();
    workspace.config.generator = '1.0.0-rc.1+local';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ version: '1.0.0+build' })),
      );
    expect((await checkUpgrade(workspace, { fetch })).projectBehind).toBe(true);
    workspace.config.generator = '1.0.0+other';
    expect((await checkUpgrade(workspace, { fetch })).projectBehind).toBe(
      false,
    );
    workspace.config.generator = '1.0.0-01';
    await expect(checkUpgrade(workspace, { fetch })).rejects.toThrow(
      'semantic version',
    );
  });
  it('reports HTTP failures and respects pre-cancellation', async () => {
    const workspace = await fixture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('', { status: 503 }));
    await expect(checkUpgrade(workspace, { fetch })).rejects.toThrow(
      'HTTP 503',
    );
    await expect(
      checkUpgrade(workspace, { fetch, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled fetch even if the transport ignores abort', async () => {
    const workspace = await fixture();
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => new Promise<Response>(() => {}));
    const pending = checkUpgrade(workspace, { fetch });
    const rejected = expect(pending).rejects.toThrow('timed out');
    // Version discovery performs an asynchronous file read before starting the timer.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });
});
