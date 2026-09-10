import { parseEnv } from 'node:util';
import {
  deploymentUrl,
  linkEnvironment,
  publicVariable,
} from '../../assets/setup/convex-setup.mjs';
import type { ChangePlan } from './changes.js';
import { readText, type Workspace } from './project.js';

export async function readBackendEnvironment(workspace: Workspace): Promise<{
  values: Record<string, string | undefined>;
  guards: Array<{ path: string; contents: string | null }>;
}> {
  let values: Record<string, string | undefined> = {};
  const guards: Array<{ path: string; contents: string | null }> = [];
  for (const path of ['packages/backend/.env', 'packages/backend/.env.local']) {
    const contents = await readText(workspace.root, path);
    guards.push({ path, contents });
    values = { ...values, ...parseEnv(contents ?? '') };
  }
  return { values, guards };
}

export async function planEnvSync(
  workspace: Workspace,
  options: { app?: string } = {},
): Promise<ChangePlan> {
  const apps =
    options.app === undefined
      ? workspace.config.apps
      : workspace.config.apps.filter((app) => app.name === options.app);
  if (!apps.length) throw new Error(`Unknown application: ${options.app}.`);
  const backend = await readBackendEnvironment(workspace);
  const url = deploymentUrl(backend.values.CONVEX_URL);
  const plan: ChangePlan = {
    root: workspace.root,
    changes: [],
    guards: [
      { path: 'convex-monorepo.json', contents: workspace.configText },
      ...backend.guards,
    ],
    notes: [
      'Only the public Convex URL is linked. Restart affected development servers after syncing.',
    ],
  };
  for (const app of apps) {
    const manifestPath = `apps/${app.name}/package.json`;
    const manifest = await readText(workspace.root, manifestPath);
    if (manifest === null)
      throw new Error(
        `Missing application: apps/${app.name}. Restore the application before linking its URL.`,
      );
    plan.guards?.push({ path: manifestPath, contents: manifest });
    const path = `apps/${app.name}/.env.local`;
    const before = await readText(workspace.root, path);
    const after = linkEnvironment(
      before ?? '',
      publicVariable(app.framework),
      url,
    );
    if (before !== after)
      plan.changes.push({ path, before, after, mode: 0o600 });
  }
  if (
    apps.some((app) => app.framework === 'expo') &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
  )
    plan.notes.push(
      'Physical phones need a reachable Convex URL. localhost points to the phone itself.',
    );
  return plan;
}
