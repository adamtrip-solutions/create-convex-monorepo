import type { Auth, AuthAdapter } from '../../generator/types.js';
import { noneAdapter } from './none/index.js';
import { clerkAdapter } from './clerk/index.js';
export const authAdapters: Record<Auth, AuthAdapter> = {
  none: noneAdapter,
  clerk: clerkAdapter,
};
