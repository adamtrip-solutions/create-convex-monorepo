import type { AppTemplate } from '../../../generator/types.js';
import { versions } from '../../versions.js';
import { common, manifest, port, webMessages, webTsconfig } from '../shared.js';

export const viteTemplate: AppTemplate = {
  id: 'vite',
  label: 'Vite + React',
  async generate(context, app) {
    const dir = `apps/${app.name}`;
    const pkg = manifest(context, app);
    pkg.scripts = {
      ...pkg.scripts,
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
    };
    pkg.dependencies = { ...pkg.dependencies, 'react-dom': versions.react };
    pkg.devDependencies = {
      ...pkg.devDependencies,
      vite: versions.vite,
      '@vitejs/plugin-react': versions.viteReact,
      '@types/react-dom': '19.2.7',
      '@types/node': '26.5.0',
    };
    await context.json(`${dir}/package.json`, pkg);
    await context.json(`${dir}/tsconfig.json`, webTsconfig(context));
    await context.write(
      `${dir}/vite.config.ts`,
      `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { port: ${port(context, app)}, strictPort: true } });\n`,
    );
    await context.write(
      `${dir}/index.html`,
      `<!doctype html>\n<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${app.name}</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`,
    );
    await context.write(
      `${dir}/src/vite-env.d.ts`,
      '/// <reference types="vite/client" />\n',
    );
    await context.write(
      `${dir}/src/main.tsx`,
      `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Providers } from './providers';
import { AuthControls } from './auth-controls';
import { Messages } from './messages';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element.');
createRoot(root).render(<StrictMode><main><Providers><AuthControls /><Messages /></Providers></main></StrictMode>);
`,
    );
    await common(context, app, 'VITE_CONVEX_URL');
    await webMessages(context, app);
  },
};
