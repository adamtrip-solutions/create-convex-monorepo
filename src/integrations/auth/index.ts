import type { AppSpec, Auth, AuthAdapter } from '../../generator/types.js';
import { uiRuntime } from './shared.js';
import { noneAdapter } from './none/index.js';
import { clerkAdapter } from './clerk/index.js';
import { convexAuthAdapter } from './convex-auth/index.js';
import { betterAuthAdapter } from './better-auth/index.js';

import { workosAdapter } from './workos/index.js';
export const authAdapters: Record<Auth, AuthAdapter> = {
  none: noneAdapter,
  workos: workosAdapter,
  clerk: clerkAdapter,
  'convex-auth': convexAuthAdapter,
  'better-auth': betterAuthAdapter,
};

export function validateAuthCompatibility(
  apps: AppSpec[],
  provider: string,
): void {
  const adapter = Object.hasOwn(authAdapters, provider)
    ? authAdapters[provider as Auth]
    : undefined;
  for (const app of apps) {
    if (adapter?.supportedRuntimes.includes(uiRuntime(app.framework))) continue;
    if (app.framework === 'nuxt')
      throw new Error('Nuxt currently supports only --auth none.');
    if (app.framework === 'sveltekit')
      throw new Error('SvelteKit currently supports only --auth none.');
    if (adapter)
      throw new Error(
        `${adapter.label} does not support the ${uiRuntime(app.framework)} UI runtime for ${app.framework}.`,
      );
  }
}
