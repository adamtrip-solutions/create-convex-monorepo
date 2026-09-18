import type { Auth, AuthAdapter } from '../../generator/types.js';
import { noneAdapter } from './none/index.js';
import { clerkAdapter } from './clerk/index.js';
import { convexAuthAdapter } from './convex-auth/index.js';
import { workosAdapter } from './workos/index.js';
export const authAdapters: Record<Auth, AuthAdapter> = {
  none: noneAdapter,
  workos: workosAdapter,
  clerk: clerkAdapter,
  'convex-auth': convexAuthAdapter,
};
