import spawn from 'cross-spawn';
import type { PackageManagerId } from '../generator/types.js';

export function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: 'inherit',
      shell: false,
      ...(signal ? { signal } : {}),
    });
    child.once('error', (error) =>
      reject(
        new Error(`Could not run ${command}: ${error.message}`, {
          cause: error,
        }),
      ),
    );
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`}).`,
            ),
          ),
    );
  });
}
export interface PackageManager {
  id: PackageManagerId;
  install(cwd: string, signal?: AbortSignal): Promise<void>;
}
export const pnpm: PackageManager = {
  id: 'pnpm',
  install: (cwd, signal) => runCommand('pnpm', ['install'], cwd, signal),
};

export const bun: PackageManager = {
  id: 'bun',
  install: (cwd, signal) => runCommand('bun', ['install'], cwd, signal),
};
export const packageManagers: Record<PackageManagerId, PackageManager> = {
  pnpm,
  bun,
};
export function scriptCommand(
  manager: PackageManagerId,
  script: string,
): string {
  return `${manager}${manager === 'bun' ? ' run' : ''} ${script}`;
}
export function workspaceScript(
  manager: PackageManagerId,
  scope: string,
  name: string,
  script: string,
): string {
  return `${manager}${manager === 'bun' ? ' run' : ''} --filter @${scope}/${name} ${script}`;
}
export function workspaceExec(
  manager: PackageManagerId,
  scope: string,
  name: string,
  command: string,
): string {
  const directory = name === 'backend' ? 'packages/backend' : `apps/${name}`;
  return manager === 'bun'
    ? `bun run --cwd ${directory} ${command}`
    : `pnpm --filter @${scope}/${name} exec ${command}`;
}
