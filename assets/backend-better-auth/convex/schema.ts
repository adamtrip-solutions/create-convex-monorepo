import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  messages: defineTable({
    body: v.string(),
    owner: v.optional(v.string()),
  }).index('by_owner', ['owner']),
});
