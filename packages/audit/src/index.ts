export type {
  SensitivityTier,
  SensitivityResolverFn,
  HashAlgorithm,
  SigningKeyProvider,
  CostMetadata,
  AuditEventBase,
  LowAuditEvent,
  MediumAuditEvent,
  HighAuditEvent,
  AuditEvent,
  MerkleProof,
  ReplayManifest,
  AuditOptions,
  AuditMiddlewareHandle,
} from './types.js';

export { createSensitivityResolver } from './sensitivity.js';
export { createDefaultSigningKeyProvider } from './signingKey.js';
export { createAuditMiddleware } from './middleware.js';
export { computeMerkleRoot, computeMerkleProof, verifyMerkleProof } from './chain.js';
