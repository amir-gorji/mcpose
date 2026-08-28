export type { Middleware } from './middleware.js';
export { compose, markPassThroughObserver } from './middleware.js';

export type { BackendConfig, BackendClient } from './backendClient.js';
export { createBackendClient } from './backendClient.js';

export type { Identity } from './identity.js';

export type { ProxyContext, ProxyIdentity } from './proxyContext.js';
export { createProxyContext, outboundDelegationChain } from './proxyContext.js';

export type {
  TelemetryEvent,
  ToolCallTelemetryEvent,
  BackendDegradedTelemetryEvent,
} from './telemetry.js';

export type { Backends } from './mesh.js';
export { BACKEND_NAMESPACE_SEPARATOR } from './mesh.js';

export type { PersistentEventStore } from './eventStore.js';
export { createInMemoryEventStore } from './eventStore.js';

export type { RejectionReason } from './rejection.js';
export { rejectionMcpError } from './rejection.js';

export type {
  HiddenToolPredicate,
  DispatcherAwareBlockOptions,
} from './hiddenTools.js';
export { dispatcherAwareBlock } from './hiddenTools.js';

export type { SanitizeToolDescriptionsOptions } from './sanitizeCatalog.js';
export { sanitizeToolDescriptions } from './sanitizeCatalog.js';

export type {
  ProxyOptions,
  HttpProxyOptions,
  LocalTool,
  ToolMiddleware,
  ResourceMiddleware,
  ListToolsMiddleware,
  ToolResultHandlers,
} from './core.js';
export {
  hasToolContent,
  mapToolResult,
  createProxyServer,
  startProxy,
  startHttpProxy,
} from './core.js';
