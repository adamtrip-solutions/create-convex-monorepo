import * as prompts from '@clack/prompts';
import { parseArgs } from 'node:util';
import { frameworks, validateProjectName } from '../generator/options.js';
import type { Example, Framework } from '../generator/types.js';
import { pnpm } from '../package-manager/index.js';
import { loadWorkspace } from '../workspace/project.js';
import { applyPlan } from '../workspace/changes.js';
import { planAddApp, planAddAuth } from '../workspace/add.js';
import { planEnvSync } from '../workspace/env.js';
import { doctor } from '../workspace/doctor.js';
import { checkUpgrade } from '../workspace/upgrade.js';

export const workspaceHelp = `convex-monorepo <command> [options]

Manage an existing Convex monorepo from its root or any subdirectory.

  add                       Choose an app or authentication interactively
  add app [name]            Add an application
    --framework <name>      next, vite, tanstack-start, or expo
    --example <name>        none or messages (defaults to workspace example)
  add auth [clerk]          Add Clerk authentication
  doctor [--json]           Check workspace configuration and setup
  env sync [--app name]     Copy public Convex URLs to frontend env files
  upgrade --check [--json]  Check the latest stable generator version

Add options:
  --install / --no-install  Install dependencies after applying changes
  --yes, -y                Skip prompts and install unless --no-install

Add and env sync options:
  --dry-run                Show planned paths without writing or installing

  --help, -h               Show usage
  --version, -v            Show CLI version

Without a terminal, add app requires a name and --framework. Installation
is off unless --install or --yes is passed. Existing files are never forced.
`;

type CommandKind =
  | 'help'
  | 'add'
  | 'add-app'
  | 'add-auth'
  | 'doctor'
  | 'env-sync'
  | 'upgrade';
export interface WorkspaceCommand {
  command: CommandKind;
  help: boolean;
  version: boolean;
  name?: string;
  framework?: Framework;
  example?: Example;
  provider?: 'clerk';
  app?: string;
  install?: boolean;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
}

export function parseWorkspaceCommand(args: string[]): WorkspaceCommand {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      framework: { type: 'string' },
      example: { type: 'string' },
      app: { type: 'string' },
      install: { type: 'boolean' },
      'no-install': { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      check: { type: 'boolean' },
    },
  });
  const [first, second, third] = positionals;
  let command: CommandKind;
  let maximum: number;
  let allowed: string[];
  const addFlags = ['install', 'no-install', 'yes', 'dry-run'];
  if (!first || first === 'help') {
    command = 'help';
    maximum = first ? 1 : 0;
    allowed = [];
  } else if (first === 'add') {
    if (!second) {
      command = 'add';
      maximum = 1;
      allowed = addFlags;
    } else if (second === 'app') {
      command = 'add-app';
      maximum = 3;
      allowed = [...addFlags, 'framework', 'example'];
    } else if (second === 'auth') {
      command = 'add-auth';
      maximum = 3;
      allowed = addFlags;
    } else throw new Error('Use add app [name] or add auth [clerk].');
  } else if (first === 'doctor') {
    command = 'doctor';
    maximum = 1;
    allowed = ['json'];
  } else if (first === 'env' && second === 'sync') {
    command = 'env-sync';
    maximum = 2;
    allowed = ['app', 'dry-run'];
  } else if (first === 'upgrade') {
    command = 'upgrade';
    maximum = 1;
    allowed = ['check', 'json'];
  } else
    throw new Error(
      `Unknown command: ${positionals.join(' ')}. Run convex-monorepo --help.`,
    );
  if (positionals.length > maximum)
    throw new Error(
      'Unexpected positional arguments. Run convex-monorepo --help.',
    );
  for (const flag of Object.keys(values)) {
    if (!['help', 'version', ...allowed].includes(flag))
      throw new Error(
        `--${flag} is not supported for ${first ?? 'this command'}.`,
      );
  }
  if (values.install && values['no-install'])
    throw new Error('Choose either --install or --no-install.');
  if (
    values.framework !== undefined &&
    !frameworks.includes(values.framework as Framework)
  )
    throw new Error(
      `Unknown framework: ${values.framework}. Choose ${frameworks.join(', ')}.`,
    );
  if (
    values.example !== undefined &&
    values.example !== 'none' &&
    values.example !== 'messages'
  )
    throw new Error('Choose --example none or --example messages.');
  if (command === 'add-auth' && third !== undefined && third !== 'clerk')
    throw new Error(
      'Only Clerk authentication is supported. Use add auth clerk.',
    );
  if (command === 'upgrade' && !values.check && !values.help && !values.version)
    throw new Error(
      'Use convex-monorepo upgrade --check to check versions. Automatic upgrades are not supported.',
    );
  return {
    command,
    help: !!values.help || (command === 'help' && !values.version),
    version: !!values.version,
    yes: !!values.yes,
    dryRun: !!values['dry-run'],
    json: !!values.json,
    ...(command === 'add-app' && third !== undefined ? { name: third } : {}),
    ...(command === 'add-auth' && third === 'clerk' ? { provider: third } : {}),
    ...(values.framework !== undefined
      ? { framework: values.framework as Framework }
      : {}),
    ...(values.example !== undefined
      ? { example: values.example as Example }
      : {}),
    ...(values.app !== undefined ? { app: values.app } : {}),
    ...(values.install || values['no-install']
      ? { install: !values['no-install'] }
      : {}),
  };
}

function answer<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) throw new Error('Workspace command cancelled.');
  return value as T;
}

export async function runWorkspace(
  args: string[],
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const options = parseWorkspaceCommand(args);
  if (options.help) {
    console.log(workspaceHelp);
    return;
  }
  if (options.version) {
    console.log(version);
    return;
  }
  signal?.throwIfAborted();
  const interactive =
    !!process.stdin.isTTY && !!process.stdout.isTTY && !options.yes;
  if (options.command === 'add') {
    if (!interactive)
      throw new Error(
        'Choose add app <name> --framework <name> or add auth clerk when prompts are disabled.',
      );
    options.command = answer(
      await prompts.select({
        message: 'What would you like to add?',
        options: [
          { value: 'add-app' as const, label: 'Application' },
          { value: 'add-auth' as const, label: 'Clerk authentication' },
        ],
      }),
    );
  }
  if (options.command === 'add-app') {
    if (!options.name && interactive)
      options.name = answer(
        await prompts.text({
          message: 'Application name?',
          validate: (value) => validateProjectName(value ?? ''),
        }),
      );
    if (!options.framework && interactive)
      options.framework = answer(
        await prompts.select({
          message: 'Application framework?',
          options: frameworks.map((value) => ({ value, label: value })),
        }),
      );
    if (!options.name || !options.framework)
      throw new Error(
        'Without prompts, use add app <name> --framework <next|vite|tanstack-start|expo>.',
      );
  }
  signal?.throwIfAborted();
  const workspace = await loadWorkspace(process.cwd());
  if (
    options.command === 'add-app' &&
    options.example === undefined &&
    interactive
  ) {
    options.example = answer(
      await prompts.select({
        message: 'Starter content?',
        initialValue: workspace.config.example,
        options: [
          { value: 'messages' as const, label: 'Messages example' },
          { value: 'none' as const, label: 'Blank application' },
        ],
      }),
    );
  }
  if (options.command === 'doctor') {
    const result = await doctor(workspace, signal ? { signal } : {});
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      for (const check of result.checks) console.log(check);
      for (const issue of result.issues)
        console.log(`${issue.severity}: ${issue.message}\n  Fix: ${issue.fix}`);
      if (!result.issues.length) console.log('No workspace issues found.');
    }
    if (result.issues.some((issue) => issue.severity === 'error'))
      process.exitCode = 1;
    return;
  }
  if (options.command === 'upgrade') {
    const result = await checkUpgrade(workspace, signal ? { signal } : {});
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(
        `CLI: ${result.cliVersion}\nProject generator: ${result.projectGenerator}\nLatest stable: ${result.latestStable}`,
      );
      console.log(
        result.updateAvailable
          ? 'A newer CLI version is available.'
          : 'The CLI is up to date.',
      );
      if (result.projectBehind)
        console.log(
          'The workspace was created with an older generator. Review changes before updating dependencies.',
        );
    }
    return;
  }
  const plan =
    options.command === 'env-sync'
      ? await planEnvSync(
          workspace,
          options.app !== undefined ? { app: options.app } : {},
        )
      : options.command === 'add-app'
        ? await planAddApp(workspace, {
            name: options.name!,
            framework: options.framework!,
            ...(options.example !== undefined
              ? { example: options.example }
              : {}),
          })
        : await planAddAuth(workspace, 'clerk');
  console.log(
    options.dryRun ? 'Dry run. Planned changes:' : 'Planned changes:',
  );
  for (const change of plan.changes)
    console.log(
      `  ${change.before === null ? 'create' : 'update'} ${change.path}`,
    );
  for (const note of plan.notes) console.log(note);
  if (!plan.changes.length) console.log('No changes needed.');
  if (options.dryRun) {
    await applyPlan(plan, { dryRun: true, ...(signal ? { signal } : {}) });
    return;
  }
  signal?.throwIfAborted();
  let install = options.install ?? options.yes;
  if (
    options.command !== 'env-sync' &&
    plan.changes.length &&
    options.install === undefined &&
    interactive
  ) {
    install = answer(
      await prompts.confirm({
        message: 'Install dependencies after applying these changes?',
        initialValue: false,
      }),
    );
  }
  signal?.throwIfAborted();
  await applyPlan(plan, signal ? { signal } : {});
  if (options.command !== 'env-sync' && install && plan.changes.length) {
    try {
      await pnpm.install(workspace.root, signal);
    } catch (error) {
      throw new Error(
        `Workspace files were updated, but dependency installation failed. Run pnpm install from the workspace root to retry. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  console.log('Workspace changes applied.');
}
