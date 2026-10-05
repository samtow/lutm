import {DurableObject} from 'cloudflare:workers'
import collector from './collect.py'
import {ensureSampling, sampleOnAlarm, serve} from './poll.mjs'

export class BuildMonitor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.settings = {
      ...env,
      BUILD_STATUS: {
        async get(key, type) {
          const value = await ctx.storage.get(key)
          return type === 'json' && value != null ? JSON.parse(value) : value ?? null
        },
        put: (key, value) => ctx.storage.put(key, value),
      },
    }
  }

  async fetch(request) {
    await ensureSampling(this.ctx.storage)
    return serve(request, this.settings)
  }

  async alarm() {
    await sampleOnAlarm(this.settings, collector, this.ctx.storage)
  }
}

export default {
  fetch(request, env) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/api/status') {
      return env.BUILD_MONITOR.getByName('tracker').fetch(request)
    }
    return serve(request, env)
  },
}
