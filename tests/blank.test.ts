import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateProject, normalizeOptions } from '../src/index.js';
import { parseCommand } from '../src/commands/create.js';

it('normalizes example selection and rejects unsupported examples', () => {
  expect(normalizeOptions({}).example).toBe('messages');
  expect(normalizeOptions({ yes: true }).example).toBe('messages');
  expect(
    normalizeOptions(parseCommand(['--example', 'none']).raw).example,
  ).toBe('none');
  expect(normalizeOptions({ yes: true, example: 'none' }).example).toBe('none');
  expect(() => normalizeOptions({ example: 'unknown' })).toThrow(
    'Unknown example',
  );
});

describe.each(['none', 'clerk', 'convex-auth'])(
  'blank projects with %s auth',
  (auth) => {
    it.each([
      'next',
      'vite',
      'tanstack-start',
      'expo',
      'next,admin:vite,portal:tanstack-start,expo',
    ])('generates %s without demo code', async (apps) => {
      const cwd = await mkdtemp(join(tmpdir(), 'ccm-blank-'));
      try {
        const root = await generateProject(
          { name: 'blank', apps, auth, example: 'none' },
          { cwd },
        );
        const read = (file: string) => readFile(join(root, file), 'utf8');
        const files = (await readdir(root, { recursive: true })).map((file) =>
          file.split(sep).join('/'),
        );
        expect(files.some((file) => /messages\.(tsx?|js)$/.test(file))).toBe(
          false,
        );
        expect(files).not.toContain('packages/backend/convex/access.ts');
        expect(
          files.filter((file) => file.endsWith('convex-api.type-test.ts')),
        ).toEqual([]);
        expect(await read('packages/backend/convex/schema.ts')).toContain(
          auth === 'convex-auth' ? '...authTables' : 'defineSchema({})',
        );
        const generated = await read(
          'packages/backend/convex/_generated/api.d.ts',
        );
        if (auth === 'convex-auth') {
          expect(generated).toContain('auth: typeof auth');
          expect(generated).toContain('http: typeof http');
        } else {
          expect(generated).toContain('ApiFromModules<{}>');
        }
        expect(generated).not.toMatch(/messages|access\.js/);
        const metadata = JSON.parse(await read('convex-monorepo.json')) as {
          example: string;
          apps: { name: string; framework: string }[];
        };
        expect(metadata.example).toBe('none');
        for (const app of metadata.apps) {
          const dir = `apps/${app.name}`;
          const entry =
            app.framework === 'next'
              ? 'src/app/page.tsx'
              : app.framework === 'vite'
                ? 'src/main.tsx'
                : app.framework === 'expo'
                  ? 'App.tsx'
                  : 'src/routes/index.tsx';
          expect(await read(`${dir}/${entry}`)).toContain(
            app.framework === 'expo'
              ? `<Text>${app.name}</Text>`
              : `<h1>${app.name}</h1>`,
          );
          expect(await read(`${dir}/${entry}`)).toContain('<Providers>');
          expect(await read(`${dir}/src/providers.tsx`)).toContain(
            auth === 'clerk'
              ? 'ConvexProviderWithClerk'
              : auth === 'convex-auth'
                ? 'ConvexAuthProvider'
                : 'ConvexProvider',
          );
        }
        expect(files.includes('packages/backend/convex/auth.config.ts')).toBe(
          auth !== 'none',
        );
        const readme = await read('README.md');
        expect(readme).not.toMatch(
          /message board|owner index|convex-api.type-test/,
        );
        if (auth === 'convex-auth') {
          expect(readme).toContain('## Convex Auth setup');
          expect(readme).not.toContain('API starts empty');
        } else {
          expect(readme).toContain('API starts empty');
        }
        for (const file of files.filter(
          (file) => /\.[jt]sx?$/.test(file) && !file.includes('_generated'),
        )) {
          expect(await read(file), file).not.toMatch(
            /api\.messages|useMutation|useQuery|getOwner|by_owner/,
          );
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  },
);
