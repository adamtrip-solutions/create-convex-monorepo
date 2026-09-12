import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../src/generator/context.js';
import { normalizeOptions } from '../src/generator/options.js';
import { generateRoot } from '../src/templates/root/index.js';
import { generateBackend } from '../src/templates/backend/index.js';
import { appTemplates } from '../src/templates/apps/index.js';
import { convexAuthAdapter } from '../src/integrations/auth/convex-auth/index.js';
import { runCommand } from '../src/package-manager/index.js';
import { versions } from '../src/templates/versions.js';

// Bootstrap from existing official assets only in a disposable workspace.
// Normal project generation always requires the provider's own generated assets.
for (const example of ['messages', 'none'] as const) {
  const root = await mkdtemp(join(tmpdir(), `ccm-convex-auth-${example}-`));
  const options = normalizeOptions({
    name: 'auth-assets',
    apps: 'vite',
    auth: 'convex-auth',
    example,
  });
  const context = createContext(root, options);
  await generateRoot(context);
  await generateBackend({ ...context, options: { ...options, auth: 'none' } });
  for (const app of options.apps)
    await appTemplates[app.framework].generate(context, app);
  await convexAuthAdapter.apply(context);
  const assets = fileURLToPath(
    new URL(
      `../assets/backend${example === 'none' ? '-blank' : ''}-convex-auth/`,
      import.meta.url,
    ),
  );
  const backend = join(root, 'packages/backend');
  await cp(join(assets, 'convex/schema.ts'), join(backend, 'convex/schema.ts'));
  console.log(`${example} workspace: ${root}`);
  if (process.argv.includes('--prepare-only')) continue;

  await runCommand('pnpm', ['install'], root);
  const previousAgentMode = process.env.CONVEX_AGENT_MODE;
  process.env.CONVEX_AGENT_MODE = 'anonymous';
  try {
    await runCommand('pnpm', ['exec', 'convex', 'dev', '--once'], backend);
  } finally {
    if (previousAgentMode === undefined) delete process.env.CONVEX_AGENT_MODE;
    else process.env.CONVEX_AGENT_MODE = previousAgentMode;
  }
  const api = await readFile(
    join(backend, 'convex/_generated/api.d.ts'),
    'utf8',
  );
  for (const module of [
    'auth',
    'http',
    ...(example === 'messages' ? ['messages', 'access'] : []),
  ]) {
    if (!api.includes(`../${module}.js`))
      throw new Error(`Codegen omitted ${module}.js in ${root}.`);
  }
  if (example === 'none' && /\.\/(messages|access)\.js/.test(api))
    throw new Error(`Blank codegen contains example modules in ${root}.`);
  await cp(
    join(backend, 'convex/_generated'),
    join(assets, 'convex/_generated'),
    { recursive: true },
  );
  await writeFile(
    join(assets, 'PROVENANCE.md'),
    `Generated files under convex/\\_generated were produced unchanged by convex@${versions.convex} using CONVEX_AGENT_MODE=anonymous pnpm exec convex dev --once on ${new Date().toISOString().slice(0, 10)}, after pnpm install in a temporary generated workspace. Dynamic JS/declaration output. Auth dependencies: @convex-dev/auth@${versions.convexAuth} and @auth/core@${versions.authCore}. Input modules: schema.ts, auth.ts, http.ts${example === 'messages' ? ', messages.ts, access.ts' : ''}. auth.config.ts configures the issuer and is excluded from the generated function API. No internal codegen entry point was called. Run normal convex dev after changing backend modules.\n\nConvex SDK source is Apache-2.0 licensed: https://github.com/get-convex/convex-js/blob/main/LICENSE.\n`,
  );
}
