import type { AppSpec, Auth, Framework, ProjectOptions } from './types.js';

export interface RawOptions {
  name?: string;
  apps?: string | AppSpec[];
  auth?: string;
  example?: string;
  packageManager?: string;
  install?: boolean;
  initConvex?: boolean;
  git?: boolean;
  yes?: boolean;
}
export const frameworks: readonly Framework[] = [
  'next',
  'vite',
  'tanstack-start',
  'expo',
];
const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|node_modules)$/i;
export function validateProjectName(name: string): string | undefined {
  if (
    name.length > 100 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(name) ||
    reserved.test(name)
  ) {
    return 'Use a lowercase name of 1–100 letters, numbers, or hyphens, starting with a letter or number. Paths and reserved names are not allowed.';
  }
  return undefined;
}
export function normalizeOptions(raw: RawOptions): ProjectOptions {
  const name = raw.name ?? 'my-app';
  const error = validateProjectName(name);
  if (error) throw new Error(`Invalid project name "${name}". ${error}`);
  if (raw.packageManager !== undefined && raw.packageManager !== 'pnpm')
    throw new Error('Only pnpm is supported in v0.1.');
  const initConvex = raw.initConvex ?? false;
  if (initConvex && raw.install === false)
    throw new Error(
      '--init-convex requires dependencies. Omit --no-install or use --no-init-convex.',
    );
  const example = raw.example ?? 'messages';
  if (example !== 'none' && example !== 'messages')
    throw new Error(`Unknown example "${example}". Choose none or messages.`);
  const auth = raw.auth ?? 'none';
  if (auth !== 'none' && auth !== 'clerk' && auth !== 'convex-auth')
    throw new Error(
      `Unknown auth provider "${auth}". Choose none, clerk, or convex-auth.`,
    );
  const used = new Set<string>();
  const input = raw.apps ?? 'next';
  const entries =
    typeof input === 'string'
      ? input.split(',').map((entry) => {
          const parts = entry.trim().split(':');
          if (parts.length > 2 || parts.some((part) => !part))
            throw new Error(
              `Invalid app selection "${entry}". Use framework or name:framework.`,
            );
          return {
            name: parts.length === 2 ? parts[0] : undefined,
            framework: parts.at(-1),
          };
        })
      : input.map((app) => ({ ...app }));
  if (!entries.length) throw new Error('Select at least one application.');
  const apps: AppSpec[] = entries.map((entry) => {
    if (!frameworks.includes(entry.framework as Framework))
      throw new Error(
        `Unknown framework "${entry.framework}". Choose ${frameworks.join(', ')}.`,
      );
    const framework = entry.framework as Framework;
    let appName = entry.name;
    if (appName === undefined) {
      const base =
        framework === 'expo'
          ? 'mobile'
          : used.has('web')
            ? framework === 'vite'
              ? 'admin'
              : 'app'
            : 'web';
      appName = base;
      for (let suffix = 2; used.has(appName); suffix++)
        appName = `${base}-${suffix}`;
    }
    if (validateProjectName(appName))
      throw new Error(`Invalid application name "${appName}".`);
    if (['backend', 'typescript-config', 'eslint-config'].includes(appName)) {
      throw new Error(
        `Application name "${appName}" is reserved for a shared package.`,
      );
    }
    if (used.has(appName))
      throw new Error(`Duplicate application name "${appName}".`);
    used.add(appName);
    return { name: appName, framework };
  });
  return {
    name,
    apps,
    auth: auth as Auth,
    example,
    packageManager: 'pnpm',
    install: raw.install ?? (initConvex || raw.yes || false),
    initConvex,
    git: raw.git ?? raw.yes ?? false,
  };
}
