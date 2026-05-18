export type { Middleware } from './middleware.js';
export { compose } from './middleware.js';

export type { BackendConfig, BackendClient } from './backendClient.js';
export { createBackendClient } from './backendClient.js';

export type { Identity } from './identity.js';

export type { ProxyContext } from './proxyContext.js';
export { createProxyContext } from './proxyContext.js';

export type { TelemetryEvent } from './telemetry.js';

export type { PersistentEventStore } from './eventStore.js';
export { createInMemoryEventStore } from './eventStore.js';

export type {
  ProxyOptions,
  HttpProxyOptions,
  ToolMiddleware,
  ResourceMiddleware,
  ListToolsMiddleware,
} from './core.js';
export { hasToolContent, createProxyServer, startProxy, startHttpProxy } from './core.js';
