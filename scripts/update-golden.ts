import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'prettier';
import { generateProject } from '../src/generator/index.js';
import { normalizeOptions, type RawOptions } from '../src/generator/options.js';
import { platform } from '../src/integrations/auth/shared.js';
import { workosBindings } from '../src/integrations/auth/workos/index.js';

interface Scenario extends RawOptions {
  label: string;
  expected: [string, string, string, string | null][];
}

const path = new URL('../tests/golden/projects.json', import.meta.url);
const scenarios: Scenario[] = JSON.parse(await readFile(path, 'utf8'));
for (const packageManager of ['pnpm', 'bun'] as const) {
  for (const apps of Object.keys(workosBindings)) {
    for (const example of ['messages', 'none']) {
      const label = `${packageManager === 'bun' ? 'Bun ' : ''}${apps} + WorkOS (${example})`;
      if (!scenarios.some((scenario) => scenario.label === label))
        scenarios.push({
          label,
          apps,
          auth: 'workos',
          example,
          ...(packageManager === 'bun' ? { packageManager } : {}),
          expected: [],
        });
    }
  }
}

for (const packageManager of ['pnpm', 'bun'] as const) {
  for (const apps of [
    'next,vite,tanstack-start,expo',
    'next,vite,tanstack-start,react-router,expo',
    'astro,react-router',
  ]) {
    for (const example of ['messages', 'none']) {
      const label = `${packageManager === 'bun' ? 'Bun ' : ''}${apps === 'astro,react-router' ? 'Astro + React Router' : `All ${apps.includes('react-router') ? 'five' : 'four'}`} + Better Auth (${example})`;
      if (!scenarios.some((scenario) => scenario.label === label))
        scenarios.push({
          label,
          apps,
          auth: 'better-auth',
          example,
          ...(packageManager === 'bun' ? { packageManager } : {}),
          expected: [],
        });
    }
  }
}

// Preserve the Astro feature scenarios and exercise both package managers.
for (const packageManager of ['pnpm', 'bun'] as const) {
  const astroScenarios = [
    ...['none', 'clerk', 'convex-auth'].flatMap((auth) =>
      ['messages', 'none'].map((example) => ({
        label: `Astro + ${auth} (${example})`,
        apps: 'astro',
        auth,
        example,
      })),
    ),
    {
      label: 'Astro + React Router + Clerk',
      apps: 'astro,react-router',
      auth: 'clerk',
    },
    {
      label: 'Astro + React Router + Convex Auth',
      apps: 'astro,react-router',
      auth: 'convex-auth',
    },
    ...['messages', 'none'].map((example) => ({
      label: `Astro + React Router + Convex Auth OAuth (${example})`,
      apps: 'astro,react-router',
      auth: 'convex-auth',
      oauth: 'github,google',
      example,
    })),
    { label: 'Astro + Expo + Clerk', apps: 'astro,expo', auth: 'clerk' },
    {
      label: 'Astro + Next + Convex Auth (blank)',
      apps: 'astro,next',
      auth: 'convex-auth',
      example: 'none',
    },
  ];
  for (const scenario of astroScenarios) {
    const label = `${packageManager === 'bun' ? 'Bun ' : ''}${scenario.label}`;
    if (!scenarios.some((existing) => existing.label === label))
      scenarios.push({
        ...scenario,
        label,
        ...(packageManager === 'bun' ? { packageManager } : {}),
        expected: [],
      });
  }
}

for (const packageManager of ['pnpm', 'bun'] as const) {
  for (const scenario of [
    { label: 'SvelteKit messages', apps: 'sveltekit' },
    {
      label: 'SvelteKit + Next blank',
      apps: 'sveltekit,next',
      example: 'none',
    },
    {
      label: 'All six frameworks',
      apps: 'next,vite,tanstack-start,react-router,expo,sveltekit',
    },
    {
      label: 'All seven frameworks',
      apps: 'next,vite,tanstack-start,react-router,expo,sveltekit,astro',
    },
  ]) {
    const label = `${packageManager === 'bun' ? 'Bun ' : ''}${scenario.label}`;
    if (!scenarios.some((existing) => existing.label === label))
      scenarios.push({
        ...scenario,
        label,
        auth: 'none',
        ...(packageManager === 'bun' ? { packageManager } : {}),
        expected: [],
      });
  }
}

const cwd = await mkdtemp(join(tmpdir(), 'ccm-update-golden-'));
try {
  for (const scenario of scenarios) {
    const options = normalizeOptions({
      ...scenario,
      name: 'golden-app',
      install: false,
      git: false,
    });
    const root = await generateProject(options, { cwd });
    scenario.expected = await Promise.all(
      options.apps.map(async ({ name, framework }) => {
        const manifest = JSON.parse(
          await readFile(join(root, 'apps', name, 'package.json'), 'utf8'),
        );
        const sdk = Object.keys(manifest.dependencies).find((dependency) =>
          /^(?:@clerk\/|@convex-dev\/auth$|better-auth$|@workos(?:-inc)?\/authkit)/.test(
            dependency,
          ),
        );
        return [
          name,
          framework,
          platform({ name, framework }).prefix,
          sdk ?? null,
        ];
      }),
    );
    await rm(root, { recursive: true, force: true });
  }
  await writeFile(
    path,
    await format(JSON.stringify(scenarios), { parser: 'json' }),
  );
  console.log(`Updated ${scenarios.length} golden scenarios.`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
