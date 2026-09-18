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

export const reactRouterTemplate: AppTemplate = {
  id: 'react-router',
  label: 'React Router v7',
  async generate(context, app) {
    const dir = `apps/${app.name}`;
    const entry = entryContent(context, app, '../../src');
    const pkg = manifest(context, app);
    pkg.scripts = {
      ...pkg.scripts,
      dev: 'react-router dev',
      build: 'react-router build',
      start: 'react-router-serve ./build/server/index.js',
      typecheck: 'react-router typegen && tsc',
    };
    pkg.dependencies = {
      ...pkg.dependencies,
      'react-dom': versions.react,
      'react-router': versions.reactRouter,
      '@react-router/node': versions.reactRouter,
      '@react-router/serve': versions.reactRouter,
      isbot: versions.isbot,
    };
    pkg.devDependencies = {
      ...pkg.devDependencies,
      '@react-router/dev': versions.reactRouter,
      vite: versions.vite,
      '@types/react-dom': versions.reactRouterTypesDom,
      '@types/node': versions.reactRouterTypesNode,
    };
    await context.json(`${dir}/package.json`, pkg);
    await context.json(`${dir}/turbo.json`, {
      extends: ['//'],
      tasks: { build: { outputs: ['build/**'] } },
    });
    await context.write(`${dir}/.gitignore`, '/.react-router/\n/build/\n');
    const config = webTsconfig(context);
    await context.json(`${dir}/tsconfig.json`, {
      ...config,
      compilerOptions: {
        ...config.compilerOptions,
        types: ['node', 'vite/client'],
        rootDirs: ['.', './.react-router/types'],
      },
      include: ['app', 'src', '*.ts', '.react-router/types/**/*'],
      exclude: ['node_modules', 'build'],
    });
    await context.write(
      `${dir}/react-router.config.ts`,
      `import type { Config } from '@react-router/dev/config';
export default { ssr: true, future: { v8_middleware: true } } satisfies Config;
`,
    );
    await context.write(
      `${dir}/vite.config.ts`,
      `import { defineConfig } from 'vite';
import { reactRouter } from '@react-router/dev/vite';
export default defineConfig({ plugins: [reactRouter()], server: { port: ${port(context, app)}, strictPort: true } });
`,
    );
    await context.write(
      `${dir}/app/root.tsx`,
      `import type { ReactNode } from 'react';
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router';
import { Providers } from '../src/providers';
export { loader, middleware } from '../src/auth.server';

export function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${app.name}</title><Meta /><Links /></head><body>{children}<ScrollRestoration /><Scripts /></body></html>;
}

export default function App() {
  return <Providers><Outlet /></Providers>;
}
`,
    );
    await context.write(
      `${dir}/app/routes.ts`,
      `import { index, type RouteConfig } from '@react-router/dev/routes';
export default [index('routes/home.tsx')] satisfies RouteConfig;
`,
    );
    await context.write(
      `${dir}/app/routes/home.tsx`,
      `import { AuthControls } from '../../src/auth-controls';
${entry.imports}
export default function Home() {
  return <main><AuthControls />${entry.content}</main>;
}
`,
    );
    await common(context, app, 'VITE_CONVEX_URL', [
      '**/.react-router/**',
      '**/build/**',
    ]);
    await webMessages(context, app);
  },
};
