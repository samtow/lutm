import {createConnectTransport as createFetchTransport} from '@connectrpc/connect-web'

export function createConnectTransport(options) {
  return createFetchTransport({...options, defaultTimeoutMs: 30000})
}
