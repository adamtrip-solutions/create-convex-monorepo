import type { AppTemplate } from '../../../generator/types.js';
import { versions } from '../../versions.js';
import { common, manifest, port, webMessages, webTsconfig } from '../shared.js';

export const tanstackStartTemplate: AppTemplate = {
  id: 'tanstack-start',
  label: 'TanStack Start',
  async generate(context, app) {
    const dir = `apps/${app.name}`;
    const pkg = manifest(context, app);
    pkg.scripts = {
      ...pkg.scripts,
      dev: 'vite',
      build: 'vite build',
      typecheck: 'tsr generate && tsc --noEmit',
      'routes:generate': 'tsr generate',
    };
    pkg.dependencies = {
      ...pkg.dependencies,
      'react-dom': versions.react,
      '@tanstack/react-start': versions.tanstackStart,
      '@tanstack/react-router': '1.170.33',
    };
    pkg.devDependencies = {
      ...pkg.devDependencies,
      vite: versions.vite,
      '@vitejs/plugin-react': versions.viteReact,
      '@tanstack/router-cli': '1.167.34',
      '@types/react-dom': '19.2.7',
      '@types/node': '26.5.0',
    };
    await context.json(`${dir}/package.json`, pkg);
    const config = webTsconfig(context);
    await context.json(`${dir}/tsconfig.json`, {
      ...config,
      compilerOptions: {
        ...config.compilerOptions,
        verbatimModuleSyntax: false,
      },
    });
    await context.json(`${dir}/tsr.config.json`, {
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      quoteStyle: 'single',
    });
    await context.write(
      `${dir}/vite.config.ts`,
      `import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [tanstackStart(), react()], server: { port: ${port(context, app)}, strictPort: true } });
`,
    );
    await context.write(
      `${dir}/src/vite-env.d.ts`,
      '/// <reference types="vite/client" />\n',
    );
    await context.write(
      `${dir}/src/router.tsx`,
      `import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}
declare module '@tanstack/react-router' {
  interface Register { router: ReturnType<typeof getRouter> }
}
`,
    );
    await context.write(
      `${dir}/src/routes/__root.tsx`,
      `import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
export const Route = createRootRoute({
  head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: '${app.name}' }] }),
  component: Root,
});
function Root() {
  return <html lang="en"><head><HeadContent /></head><body><Outlet /><Scripts /></body></html>;
}
`,
    );
    await context.write(
      `${dir}/src/routes/index.tsx`,
      `import { createFileRoute } from '@tanstack/react-router';
import { Providers } from '../providers';
import { AuthControls } from '../auth-controls';
import { Messages } from '../messages';
export const Route = createFileRoute('/')({ component: Home });
function Home() {
  return <main><Providers><AuthControls /><Messages /></Providers></main>;
}
`,
    );
    await common(context, app, 'VITE_CONVEX_URL');
    await webMessages(context, app);
  },
};
