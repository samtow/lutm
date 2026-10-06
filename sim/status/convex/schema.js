import {defineSchema, defineTable} from 'convex/server'
import {v} from 'convex/values'

export default defineSchema({
  tracker: defineTable({key: v.string(), value: v.string()}).index('by_key', ['key']),
})
