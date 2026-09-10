import { lstat, mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isMissing, readText, safePath } from './project.js';

export interface FileChange {
  path: string;
  before: string | null;
  after: string;
  mode?: number;
}
export interface ChangePlan {
  root: string;
  changes: FileChange[];
  notes: string[];
  guards?: Array<{ path: string; contents: string | null }>;
  absentPaths?: string[];
}
export interface ApplySettings {
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: (path: string) => void | Promise<void>;
}

/** A failed edit restores only files which still contain this operation's output. */
export async function applyPlan(
  plan: ChangePlan,
  settings: ApplySettings = {},
): Promise<void> {
  const root = resolve(plan.root);
  const unique = new Set<string>();
  for (const change of plan.changes) {
    const target = await safePath(root, change.path);
    if (unique.has(target))
      throw new Error(`Duplicate planned file: ${change.path}`);
    if (change.path === '.convex-monorepo.lock')
      throw new Error('The workspace lock cannot be edited.');
    unique.add(target);
  }
  async function preflight() {
    settings.signal?.throwIfAborted();
    for (const path of plan.absentPaths ?? []) {
      const target = await safePath(root, path);
      try {
        await lstat(target);
        throw new Error(
          `Path appeared while planning: ${path}. No changes were applied.`,
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    for (const guard of plan.guards ?? []) {
      if ((await readText(root, guard.path)) !== guard.contents)
        throw new Error(
          `Workspace changed while planning: ${guard.path}. Run the command again.`,
        );
    }
    for (const change of plan.changes) {
      if ((await readText(root, change.path)) !== change.before)
        throw new Error(
          `File conflict: ${change.path}. No changes were applied.`,
        );
    }
  }
  if (settings.dryRun || !plan.changes.length) {
    await preflight();
    return;
  }
  const lockPath = await safePath(root, '.convex-monorepo.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error(
        'Another workspace operation is running. If it crashed, remove .convex-monorepo.lock only after confirming no command is active.',
      );
    throw error;
  }
  const createdDirectories: string[] = [];
  const committed: Array<{ change: FileChange; mode: number }> = [];
  async function parents(path: string) {
    const parent = dirname(path);
    if (parent === root) return;
    await safePath(root, relative(root, parent).split('\\').join('/'));
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory()) throw new Error(`Expected directory: ${parent}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await parents(parent);
      await mkdir(parent);
      createdDirectories.push(parent);
    }
  }
  async function write(
    path: string,
    contents: string,
    mode: number,
    before: string | null,
  ) {
    const target = await safePath(root, path);
    await parents(target);
    if ((await readText(root, path)) !== before)
      throw new Error(`File changed during operation: ${path}.`);
    if (before === null) {
      const handle = await open(target, 'wx', mode);
      try {
        await handle.writeFile(contents, 'utf8');
      } catch (error) {
        await handle.close();
        await unlink(target);
        throw error;
      } finally {
        await handle.close();
      }
    } else {
      const temporary = `${target}.ccm-${randomUUID()}`;
      const handle = await open(temporary, 'wx', mode);
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.close();
        await safePath(root, path);
        if ((await readText(root, path)) !== before)
          throw new Error(`File changed during operation: ${path}.`);
        await rename(temporary, target);
      } finally {
        await handle.close();
        await unlink(temporary).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
      }
    }
  }
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await preflight();
    for (const change of plan.changes) {
      settings.signal?.throwIfAborted();
      if (change.before === change.after) continue;
      const target = await safePath(root, change.path);
      const mode =
        change.before === null
          ? (change.mode ?? 0o644)
          : (await lstat(target)).mode & 0o777;
      await write(change.path, change.after, mode, change.before);
      committed.push({ change, mode });
      await settings.onProgress?.(change.path);
    }
    settings.signal?.throwIfAborted();
  } catch (error) {
    const preserved: string[] = [];
    for (const { change, mode } of committed.reverse()) {
      try {
        if ((await readText(root, change.path)) !== change.after) {
          preserved.push(change.path);
          continue;
        }
        if (change.before === null)
          await unlink(await safePath(root, change.path));
        else await write(change.path, change.before, mode, change.after);
      } catch {
        preserved.push(change.path);
      }
    }
    for (const dir of createdDirectories.reverse())
      await rmdir(dir).catch(() => undefined);
    if (preserved.length)
      throw new Error(
        `Operation failed. Concurrently changed files were preserved: ${preserved.join(', ')}. Inspect them before retrying.`,
        { cause: error },
      );
    throw error;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
