import type { AppTemplate } from '../../../generator/types.js';
import { versions } from '../../versions.js';
import {
  common,
  entryContent,
  manifest,
  port,
  webMessages,
  webTsconfig,
} from '../shared.js';

export const astroTemplate: AppTemplate = {
  id: 'astro',
  label: 'Astro + React island',
  async generate(context, app) {
    const dir = `apps/${app.name}`;
    const entry = entryContent(context, app, '.');
    const pkg = manifest(context, app);
    pkg.scripts = {
      ...pkg.scripts,
      dev: `astro dev --port ${port(context, app)}`,
      build: 'astro build',
      preview: 'astro preview',
      typecheck: 'astro check',
      lint: 'eslint src astro.config.mjs auth.config.mjs',
    };
    pkg.dependencies = {
      ...pkg.dependencies,
      astro: versions.astro,
      '@astrojs/react': versions.astroReact,
      'react-dom': versions.react,
    };
    pkg.devDependencies = {
      ...pkg.devDependencies,
      '@astrojs/check': versions.astroCheck,
      '@types/react-dom': versions.typesReactDom,
      '@types/node': versions.typesNode,
    };
    await context.json(`${dir}/package.json`, pkg);
    const tsconfig = webTsconfig(context);
    await context.json(`${dir}/tsconfig.json`, {
      ...tsconfig,
      include: [...tsconfig.include, '.astro/types.d.ts'],
      exclude: [...tsconfig.exclude, '.astro'],
    });
    await context.write(
      `${dir}/astro.config.mjs`,
      `import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import auth from './auth.config.mjs';
export default defineConfig({ output: 'static', integrations: [...auth, react()] });
`,
    );
    await context.write(
      `${dir}/src/env.d.ts`,
      '/// <reference types="astro/client" />\n',
    );
    await context.write(
      `${dir}/src/pages/index.astro`,
      `---
import App from '../App';
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${app.name}</title>
  </head>
  <body>
    <App client:only="react" />
  </body>
</html>
`,
    );
    await context.write(
      `${dir}/src/App.tsx`,
      `import { Providers } from './providers';
import { AuthControls } from './auth-controls';
${entry.imports}
export default function App() {
  return <main><Providers><AuthControls />${entry.content}</Providers></main>;
}
`,
    );
    await common(context, app, 'PUBLIC_CONVEX_URL');
    await webMessages(context, app);
  },
};
