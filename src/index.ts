export type { Middleware } from './middleware.js';
export { compose } from './middleware.js';

export type { BackendConfig, BackendClient } from './backendClient.js';
export { createBackendClient } from './backendClient.js';

export type {
  ProxyOptions,
  ToolMiddleware,
  ResourceMiddleware,
} from './core.js';
export { hasToolContent, createProxyServer, startProxy } from './core.js';
