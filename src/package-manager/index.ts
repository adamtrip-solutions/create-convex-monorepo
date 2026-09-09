import spawn from 'cross-spawn';

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
  id: 'pnpm';
  install(cwd: string, signal?: AbortSignal): Promise<void>;
}
export const pnpm: PackageManager = {
  id: 'pnpm',
  install: (cwd, signal) => runCommand('pnpm', ['install'], cwd, signal),
};
