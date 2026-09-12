import { query, mutation } from './_generated/server';
import { v } from 'convex/values';
import { getOwner } from './access';

export const list = query({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id('messages'),
      _creationTime: v.number(),
      body: v.string(),
      owner: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const owner = await getOwner(ctx);
    return await ctx.db
      .query('messages')
      .withIndex('by_owner', (q) => q.eq('owner', owner))
      .order('desc')
      .take(50);
  },
});

export const send = mutation({
  args: { body: v.string() },
  returns: v.id('messages'),
  handler: async (ctx, args) => {
    const owner = await getOwner(ctx);
    const body = args.body.trim();
    if (!body || body.length > 1000)
      throw new Error('Messages must contain 1 to 1000 characters.');
    return await ctx.db.insert('messages', {
      body,
      ...(owner === undefined ? {} : { owner }),
    });
  },
});
