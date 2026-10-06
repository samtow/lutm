import {internalMutation, internalQuery} from './_generated/server.js'
import {v} from 'convex/values'

export const get = internalQuery({
  args: {key: v.string()},
  handler: async (ctx, {key}) => {
    const entry = await ctx.db.query('tracker').withIndex('by_key', query => query.eq('key', key)).unique()
    return entry?.value ?? null
  },
})

export const put = internalMutation({
  args: {key: v.string(), value: v.string()},
  handler: async (ctx, {key, value}) => {
    const entry = await ctx.db.query('tracker').withIndex('by_key', query => query.eq('key', key)).unique()
    if (entry) await ctx.db.patch(entry._id, {value})
    else await ctx.db.insert('tracker', {key, value})
  },
})
