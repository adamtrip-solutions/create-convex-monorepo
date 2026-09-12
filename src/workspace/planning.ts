import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateProject } from '../generator/index.js';
import type { Auth, Example, AppSpec } from '../generator/types.js';
import { readText, type Workspace } from './project.js';
import type { ChangePlan } from './changes.js';

export type Files = Map<string, string>;
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const retainNewlines = (text: string, original: string | null) =>
  original?.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;

export async function render(
  workspace: Workspace,
  apps: AppSpec[],
  example: Example,
  auth: Auth,
): Promise<Files> {
  const temporary = await mkdtemp(join(tmpdir(), 'ccm-add-'));
  try {
    const root = await generateProject(
      {
        name: workspace.config.name,
        apps,
        example,
        auth,
        install: false,
        git: false,
        initConvex: false,
      },
      { cwd: temporary },
    );
    const files: Files = new Map();
    async function visit(dir: string) {
      for (const entry of await readdir(join(root, dir), {
        withFileTypes: true,
      })) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path);
        else files.set(path, await readFile(join(root, path), 'utf8'));
      }
    }
    await visit('');
    return files;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function initialPlan(workspace: Workspace): ChangePlan {
  return {
    root: workspace.root,
    changes: [],
    notes: [],
    guards: [{ path: 'convex-monorepo.json', contents: workspace.configText }],
  };
}
export async function guardedRead(
  workspace: Workspace,
  plan: ChangePlan,
  path: string,
) {
  const contents = await readText(workspace.root, path);
  plan.guards!.push({ path, contents });
  return contents;
}
export function object(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Expected an object in ${path}.`);
  return value as Record<string, unknown>;
}
export async function metadata(
  workspace: Workspace,
  plan: ChangePlan,
  patch: Record<string, unknown>,
) {
  plan.changes.push({
    path: 'convex-monorepo.json',
    before: workspace.configText,
    after: json({ ...workspace.rawConfig, ...patch }),
  });
}
