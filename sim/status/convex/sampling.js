'use node'

import {internalAction} from './_generated/server.js'
import {internal} from './_generated/api.js'
import {collector} from './bundled.js'
import {sampleStatus} from '../poll.mjs'
import {trackerEnvironment} from '../status.mjs'

export const sample = internalAction({
  args: {},
  handler: async ctx => {
    const env = {
      ...trackerEnvironment(process.env),
      BUILD_STATUS: {
        async get(key, type) {
          const value = await ctx.runQuery(internal.state.get, {key})
          return type === 'json' && value != null ? JSON.parse(value) : value
        },
        put: (key, value) => ctx.runMutation(internal.state.put, {key, value}),
      },
    }
    const snapshot = await sampleStatus(env, collector)
    console.log(JSON.stringify({event: 'depot-sample', status: snapshot.status, connection: snapshot.connection, stage: snapshot.stage}))
    return {status: snapshot.status, connection: snapshot.connection, stage: snapshot.stage}
  },
})
