import type { AppTemplate } from '../../../generator/types.js';
import { versions } from '../../versions.js';
import { common, manifest, port, webMessages, webTsconfig } from '../shared.js';

export const nextTemplate: AppTemplate = {
  id: 'next',
  label: 'Next.js',
  async generate(context, app) {
    const dir = `apps/${app.name}`;
    const pkg = manifest(context, app);
    pkg.scripts = {
      ...pkg.scripts,
      dev: `next dev --port ${port(context, app)}`,
      build: 'next build',
      start: `next start --port ${port(context, app)}`,
    };
    pkg.dependencies = {
      ...pkg.dependencies,
      next: versions.next,
      'react-dom': versions.react,
    };
    pkg.devDependencies = {
      ...pkg.devDependencies,
      '@types/react-dom': '19.2.7',
      '@types/node': '26.5.0',
    };
    await context.json(`${dir}/package.json`, pkg);
    const config = webTsconfig(context);
    await context.json(`${dir}/tsconfig.json`, {
      ...config,
      compilerOptions: {
        ...config.compilerOptions,
        jsx: 'preserve',
        allowJs: true,
        resolveJsonModule: true,
        isolatedModules: true,
        incremental: true,
        plugins: [{ name: 'next' }],
      },
      include: [
        'next-env.d.ts',
        'src/**/*.ts',
        'src/**/*.tsx',
        '.next/types/**/*.ts',
        '.next/dev/types/**/*.ts',
      ],
    });
    await context.write(
      `${dir}/next.config.ts`,
      `import type { NextConfig } from 'next';\nconst config: NextConfig = { transpilePackages: ['@${context.scope}/backend'] };\nexport default config;\n`,
    );
    await context.write(
      `${dir}/next-env.d.ts`,
      '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n',
    );
    await context.write(
      `${dir}/src/app/layout.tsx`,
      `import type { ReactNode } from 'react';
export const metadata = { title: '${app.name}', description: 'A shared Convex workspace' };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
    );
    await context.write(
      `${dir}/src/app/page.tsx`,
      `import { Providers } from '../providers';
import { AuthControls } from '../auth-controls';
import { Messages } from '../messages';
export default function Home() {
  return <main><Providers><AuthControls /><Messages /></Providers></main>;
}
`,
    );
    await common(context, app, 'NEXT_PUBLIC_CONVEX_URL');
    await webMessages(context, app);
  },
};
