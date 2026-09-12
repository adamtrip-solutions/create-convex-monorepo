import { authTables } from '@convex-dev/auth/server';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  ...authTables,
  messages: defineTable({
    body: v.string(),
    owner: v.optional(v.string()),
  }).index('by_owner', ['owner']),
});
