import * as prompts from '@clack/prompts';
import { lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isMissing, loadWorkspace } from '../workspace/project.js';
import { help, parseCommand, runCreate } from './create.js';
import { runWorkspace, workspaceHelp } from './workspace.js';

const managementCommands = new Set(['add', 'doctor', 'env', 'upgrade']);
const actions = [
  { value: 'app', label: 'Add an application', args: ['add', 'app'] },
  {
    value: 'auth',
    label: 'Add Clerk authentication',
    args: ['add', 'auth', 'clerk'],
  },
  { value: 'doctor', label: 'Check workspace setup', args: ['doctor'] },
  { value: 'env', label: 'Sync frontend Convex URLs', args: ['env', 'sync'] },
  {
    value: 'upgrade',
    label: 'Update dependencies to the tested baseline',
    args: ['upgrade'],
  },
  {
    value: 'check',
    label: 'Check for CLI updates',
    args: ['upgrade', '--check'],
  },
] as const;

const managementHelp = workspaceHelp.replace(
  'convex-monorepo <command>',
  'npx create-convex-monorepo@latest <command>',
);

/** Absence is optional; malformed or unsafe metadata must still fail. */
async function existingWorkspace() {
  let directory = resolve(process.cwd());
  while (true) {
    try {
      await lstat(join(directory, 'convex-monorepo.json'));
      return loadWorkspace(directory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function runEntry(
  args: string[],
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  if (args[0] === 'create') {
    await runCreate(args.slice(1), version, signal);
    return;
  }
  if (args[0] && managementCommands.has(args[0])) {
    await runWorkspace(args, version, signal);
    return;
  }
  if (args[0] === 'help') {
    // Let the existing parser reject extra arguments and unknown flags.
    await runWorkspace(args, version, signal);
    console.log(help);
    return;
  }
  const parsed = parseCommand(args);
  if (parsed.help) {
    console.log(`${help}\n${managementHelp}`);
    return;
  }
  if (parsed.version) {
    console.log(version);
    return;
  }
  signal?.throwIfAborted();
  if (parsed.raw.name === undefined) {
    const workspace = await existingWorkspace();
    if (workspace) {
      if (args.length)
        throw new Error(
          'An existing Convex monorepo was found. Choose a workspace command, or use create <project-name> to generate another project. Run npx create-convex-monorepo@latest --help.',
        );
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log(
          `Existing workspace: ${workspace.config.name}\n\n${managementHelp}`,
        );
        return;
      }
      signal?.throwIfAborted();
      const action = await prompts.select({
        message: `Manage ${workspace.config.name}: what would you like to do?`,
        options: actions.map(({ value, label }) => ({ value, label })),
      });
      if (prompts.isCancel(action))
        throw new Error('Workspace command cancelled.');
      signal?.throwIfAborted();
      const selected = actions.find(({ value }) => value === action);
      if (!selected) throw new Error('Unknown workspace action.');
      await runWorkspace([...selected.args], version, signal);
      return;
    }
  }
  await runCreate(args, version, signal);
}
