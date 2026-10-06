import {httpRouter} from 'convex/server'
import {httpAction} from './_generated/server.js'
import {internal} from './_generated/api.js'
import {assets} from './bundled.js'
import {serve, trackerEnvironment} from '../status.mjs'

const page = httpAction(async (ctx, request) => serve(request, {
  ...trackerEnvironment(process.env),
  BUILD_STATUS: {
    async get(key, type) {
      const value = await ctx.runQuery(internal.state.get, {key})
      return type === 'json' && value != null ? JSON.parse(value) : value
    },
  },
  ASSETS: {
    async fetch(request) {
      const file = assets[new URL(request.url).pathname]
      return file ? new Response(file.body, {headers: {'Content-Type': file.type}}) : new Response('Not found', {status: 404})
    },
  },
}))

const http = httpRouter()
for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
  http.route({pathPrefix: '/', method, handler: page})
}
export default http
