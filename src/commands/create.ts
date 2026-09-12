import * as prompts from '@clack/prompts';
import { parseArgs } from 'node:util';
import { generateProject } from '../generator/index.js';
import {
  frameworks,
  normalizeOptions,
  validateProjectName,
  type RawOptions,
} from '../generator/options.js';
import type { AppSpec } from '../generator/types.js';

export const help = `create-convex-monorepo [project-name] [options]

Generate a pnpm + Turborepo workspace sharing one Convex backend.

Use create <project-name> to explicitly create a project, including names such
as add or doctor. Inside an existing workspace, running without arguments opens
the management menu. Commands: add app, add auth clerk, doctor, env sync,
upgrade --check. No global or project installation is required.

  --apps <list>             next,vite,tanstack-start,expo or web:next,admin:vite
  --example <name>         messages (default) or none for blank apps
  --auth <provider>         none (default), clerk, or convex-auth
  --package-manager <name>  pnpm (v0.1)
  --install / --no-install  Install generated dependencies
  --init-convex / --no-init-convex  Set up Convex and link URLs (requires install)
  --git / --no-git          Initialize a git repository
  --yes, -y                Accept defaults, including installation and git
  --help, -h               Show usage
  --version, -v            Show version

Without a terminal, prompts are disabled. Installation and git default to off
unless explicitly enabled or --yes is passed. Convex setup requires --init-convex
when prompts are skipped; --yes does not opt into Convex account setup.
Named apps may repeat a framework.
`;
export function parseCommand(args: string[]): {
  raw: RawOptions;
  help: boolean;
  version: boolean;
} {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      apps: { type: 'string' },
      auth: { type: 'string' },
      example: { type: 'string' },
      'package-manager': { type: 'string' },
      'init-convex': { type: 'boolean' },
      'no-init-convex': { type: 'boolean' },
      install: { type: 'boolean' },
      'no-install': { type: 'boolean' },
      git: { type: 'boolean' },
      'no-git': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  if (positionals.length > 1)
    throw new Error(
      'Expected one project name. Use --apps to select applications.',
    );
  if (values.install && values['no-install'])
    throw new Error('Choose either --install or --no-install.');
  if (values.git && values['no-git'])
    throw new Error('Choose either --git or --no-git.');
  if (values['init-convex'] && values['no-init-convex'])
    throw new Error('Choose either --init-convex or --no-init-convex.');
  const raw: RawOptions = {};
  if (
    values['init-convex'] !== undefined ||
    values['no-init-convex'] !== undefined
  )
    raw.initConvex = !values['no-init-convex'] && !!values['init-convex'];
  if (positionals[0] !== undefined) raw.name = positionals[0];
  if (values.apps !== undefined) raw.apps = values.apps;
  if (values.auth !== undefined) raw.auth = values.auth;
  if (values.example !== undefined) raw.example = values.example;
  if (values['package-manager'] !== undefined)
    raw.packageManager = values['package-manager'];
  if (values.yes !== undefined) raw.yes = values.yes;
  if (values.install !== undefined || values['no-install'] !== undefined)
    raw.install = values['no-install'] ? false : (values.install ?? false);
  if (values.git !== undefined || values['no-git'] !== undefined)
    raw.git = values['no-git'] ? false : (values.git ?? false);
  return { raw, help: values.help ?? false, version: values.version ?? false };
}
function answer<T>(value: T | symbol): T {
  if (prompts.isCancel(value))
    throw new Error('Generation cancelled. No project was created.');
  return value as T;
}
export async function runCreate(
  args: string[],
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = parseCommand(args);
  if (parsed.help) {
    console.log(help);
    return;
  }
  if (parsed.version) {
    console.log(version);
    return;
  }
  const raw = parsed.raw;
  if (process.stdin.isTTY && process.stdout.isTTY && !raw.yes) {
    prompts.intro('create-convex-monorepo');
    if (!raw.name)
      raw.name = answer(
        await prompts.text({
          message: 'Project name?',
          placeholder: 'my-app',
          defaultValue: 'my-app',
          validate: (value) => validateProjectName(value ?? ''),
        }),
      );
    if (!raw.packageManager)
      raw.packageManager = answer(
        await prompts.select({
          message: 'Package manager?',
          options: [{ value: 'pnpm', label: 'pnpm' }],
        }),
      );
    if (!raw.apps) {
      const apps: AppSpec[] = [];
      do {
        const framework = answer(
          await prompts.select({
            message: 'Application framework?',
            options: frameworks.map((value) => ({
              value,
              label: {
                next: 'Next.js',
                vite: 'Vite + React',
                'tanstack-start': 'TanStack Start',
                expo: 'Expo / React Native',
              }[value],
            })),
          }),
        );
        const defaultName =
          framework === 'expo' ? 'mobile' : apps.length === 0 ? 'web' : 'admin';
        const name = answer(
          await prompts.text({
            message: 'Application name?',
            placeholder: defaultName,
            defaultValue: defaultName,
            validate(value) {
              return (
                validateProjectName(value ?? '') ??
                (apps.some((app) => app.name === value)
                  ? 'Choose a unique application name.'
                  : undefined)
              );
            },
          }),
        );
        apps.push({ name, framework });
      } while (
        answer(
          await prompts.confirm({
            message: 'Add another frontend?',
            initialValue: false,
          }),
        )
      );
      raw.apps = apps;
    }
    if (!raw.auth)
      raw.auth = answer(
        await prompts.select({
          message: 'Authentication?',
          options: [
            { value: 'none', label: 'None' },
            { value: 'clerk', label: 'Clerk' },
            { value: 'convex-auth', label: 'Convex Auth (email + password)' },
          ],
        }),
      );
    if (raw.example === undefined)
      raw.example = answer(
        await prompts.select({
          message: 'Starter content?',
          initialValue: 'messages',
          options: [
            { value: 'messages', label: 'Messages example' },
            { value: 'none', label: 'Blank project' },
          ],
        }),
      );
    if (raw.git === undefined)
      raw.git = answer(
        await prompts.confirm({
          message: 'Initialize git?',
          initialValue: true,
        }),
      );
    if (raw.initConvex === undefined && raw.install !== false) {
      raw.initConvex = answer(
        await prompts.confirm({
          message:
            'Initialize Convex and link frontend URLs? (installs dependencies)',
          initialValue: true,
        }),
      );
    }
    if (raw.initConvex && raw.install !== false) raw.install = true;
    if (raw.install === undefined)
      raw.install = answer(
        await prompts.confirm({
          message: 'Install dependencies?',
          initialValue: true,
        }),
      );
  }
  const options = normalizeOptions(raw);
  await generateProject(options, {
    ...(signal ? { signal } : {}),
    onProgress: (message) => console.log(`✓ ${message}`),
  });
  console.log(
    `✓ Created ${options.name}\n\nNext:\n\n  cd ${options.name}\n${options.install ? '' : '  pnpm install\n'}${options.initConvex ? '  pnpm dev' : '  pnpm convex:setup\n  pnpm dev'}\n\n${options.initConvex ? 'Frontend Convex URLs are linked.' : 'convex:setup initializes the backend and links its public URL to every frontend.'}${options.auth === 'clerk' ? '\nAdd Clerk keys from .env.clerk.example and complete the auth setup in README.md.' : options.auth === 'convex-auth' ? '\nSet Convex Auth deployment keys as described in README.md before signing in.' : ''}`,
  );
}
