export const refreshSeconds = 60
export const snapshotKey = env => `snapshot:${env.DEPOT_SANDBOX_ID}`

export function trackerEnvironment(source) {
  // Convex's default runtime exposes environment values through property reads.
  return {
    DEPOT_TOKEN: source.DEPOT_TOKEN,
    DEPOT_SANDBOX_ID: source.DEPOT_SANDBOX_ID,
    DEPOT_ORG_ID: source.DEPOT_ORG_ID,
    DEPOT_BUILD_ROOT: source.DEPOT_BUILD_ROOT,
    DEPOT_BUILD_PRODUCT: source.DEPOT_BUILD_PRODUCT,
  }
}

export function configurationError(env) {
  return !env.DEPOT_TOKEN || !env.DEPOT_SANDBOX_ID
    ? 'Depot access and the builder ID are not configured for this tracker.'
    : null
}

export function initialSnapshot(env) {
  const error = configurationError(env)
  return {
    status: error ? 'unconfigured' : 'connecting',
    stage: error ? 'Cloud tracker needs configuration' : 'Waiting for the first cloud sample',
    connection: error ? 'unconfigured' : 'connecting',
    product: env.DEPOT_BUILD_PRODUCT || 'virtio_arm64only',
    error,
    recent: [],
    layouts: ['non-ab', 'ab'].map(id => ({
      id, status: 'queued', progress: null, downloads: [],
      steps: ['Images', 'Policy', 'Image checks', 'Upload'].map(label => ({label, status: 'pending'})),
    })),
  }
}

export async function serve(request, env) {
  let response
  const route = new URL(request.url).pathname
  if (request.method !== 'GET') {
    response = new Response('Method not allowed', {status: 405, headers: {Allow: 'GET'}})
  } else if (route === '/api/status') {
    const snapshot = configurationError(env) ? initialSnapshot(env) : await env.BUILD_STATUS.get(snapshotKey(env), 'json') || initialSnapshot(env)
    response = Response.json({...snapshot, sampler: await env.BUILD_STATUS.get('sampler', 'json'), refreshSeconds})
    response.headers.set('Cache-Control', 'no-store')
  } else if (route.startsWith('/api/')) {
    response = new Response('Not found', {status: 404})
  } else {
    response = await env.ASSETS.fetch(request)
  }
  const secured = new Response(response.body, response)
  secured.headers.set('X-Content-Type-Options', 'nosniff')
  secured.headers.set('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'")
  return secured
}
