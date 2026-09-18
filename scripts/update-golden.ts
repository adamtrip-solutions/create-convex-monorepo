import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'prettier';
import { generateProject } from '../src/generator/index.js';
import { normalizeOptions, type RawOptions } from '../src/generator/options.js';
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
          /^(?:@clerk\/|@convex-dev\/auth$|@workos(?:-inc)?\/authkit)/.test(
            dependency,
          ),
        );
        return [
          name,
          framework,
          framework === 'next'
            ? 'NEXT_PUBLIC'
            : framework === 'expo'
              ? 'EXPO_PUBLIC'
              : 'VITE',
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
