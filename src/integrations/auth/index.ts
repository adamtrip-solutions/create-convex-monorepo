import type { Auth, AuthAdapter } from '../../generator/types.js';
import { noneAdapter } from './none/index.js';
import { clerkAdapter } from './clerk/index.js';
import { convexAuthAdapter } from './convex-auth/index.js';
import { betterAuthAdapter } from './better-auth/index.js';
export const authAdapters: Record<Auth, AuthAdapter> = {
  none: noneAdapter,
  clerk: clerkAdapter,
  'convex-auth': convexAuthAdapter,
  'better-auth': betterAuthAdapter,
};
