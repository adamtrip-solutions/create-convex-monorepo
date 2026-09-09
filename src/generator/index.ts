import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  copyFile,
  unlink,
  rm,
  rmdir,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { constants } from 'node:fs';
import { createContext } from './context.js';
import { normalizeOptions, type RawOptions } from './options.js';
import { generateRoot } from '../templates/root/index.js';
import { generateBackend } from '../templates/backend/index.js';
import { appTemplates } from '../templates/apps/index.js';
import { authAdapters } from '../integrations/auth/index.js';
import { pnpm, runCommand } from '../package-manager/index.js';
import type { AppTemplate, Framework } from './types.js';

export { normalizeOptions, validateProjectName } from './options.js';
export type { RawOptions } from './options.js';
export type * from './types.js';
export function selectTemplate(framework: Framework): AppTemplate {
  const template = appTemplates[framework];
  if (!template) throw new Error(`Unsupported framework: ${framework}`);
  return template;
}
export interface GenerateSettings {
  cwd?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}
export async function generateProject(
  raw: RawOptions,
  settings: GenerateSettings = {},
): Promise<string> {
  settings.signal?.throwIfAborted();
  const options = normalizeOptions(raw);
  const cwd = resolve(settings.cwd ?? process.cwd());
  const target = join(cwd, options.name);
  let existingEmpty = false;
  let originalIdentity: { dev: number; ino: number } | undefined;
  try {
    const stat = await lstat(target);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (await readdir(target)).length > 0
    )
      throw new Error(
        `Refusing to overwrite ${target}. Choose a new or empty directory.`,
      );
    existingEmpty = true;
    originalIdentity = { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(cwd, { recursive: true });
  const staging = await mkdtemp(join(cwd, `.${options.name}-`));
  let createdTarget = false;
  const committed: Array<{ path: string; directory: boolean }> = [];
  async function commitDirectory(
    source: string,
    destination: string,
  ): Promise<void> {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      settings.signal?.throwIfAborted();
      const from = join(source, entry.name);
      const to = join(destination, entry.name);
      if (entry.isDirectory()) {
        await mkdir(to);
        committed.push({ path: to, directory: true });
        await commitDirectory(from, to);
      } else if (entry.isFile()) {
        await copyFile(from, to, constants.COPYFILE_EXCL);
        committed.push({ path: to, directory: false });
      } else {
        throw new Error(`Unsupported generated file: ${from}`);
      }
    }
  }
  try {
    const context = createContext(staging, options);
    await generateRoot(context);
    await generateBackend(context);
    settings.onProgress?.('Added packages/backend');
    for (const app of options.apps) {
      settings.signal?.throwIfAborted();
      await selectTemplate(app.framework).generate(context, app);
      settings.onProgress?.(`Added apps/${app.name}`);
    }
    await authAdapters[options.auth].apply(context);
    settings.signal?.throwIfAborted();
    if (existingEmpty) {
      const current = await lstat(target);
      if (
        current.isSymbolicLink() ||
        current.dev !== originalIdentity?.dev ||
        current.ino !== originalIdentity.ino ||
        (await readdir(target)).length
      ) {
        throw new Error(`Destination changed during generation: ${target}`);
      }
    } else {
      await mkdir(target);
      createdTarget = true;
    }
    // Exclusive copies work on Windows too, where renaming over an existing
    // directory fails. Roll back only entries created by this invocation.
    await commitDirectory(staging, target);
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    for (const entry of committed.reverse()) {
      await (entry.directory ? rmdir(entry.path) : unlink(entry.path)).catch(
        () => undefined,
      );
    }
    await rm(staging, { recursive: true, force: true });
    if (createdTarget) await rmdir(target).catch(() => undefined);
    throw error;
  }
  let recovery = 'pnpm install';
  try {
    if (options.install) {
      await pnpm.install(target, settings.signal);
      settings.onProgress?.('Installed dependencies');
    }
    if (options.git) {
      recovery = 'git init';
      await runCommand('git', ['init'], target, settings.signal);
      settings.onProgress?.('Initialized git');
    }
  } catch (error) {
    throw new Error(
      `Project files are ready at ${target}, but setup failed. ${error instanceof Error ? error.message : String(error)}\nRun ${recovery} in that directory to retry.`,
      { cause: error },
    );
  }
  return target;
}
