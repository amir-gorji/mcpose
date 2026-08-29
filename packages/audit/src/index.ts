export type {
  SensitivityTier,
  SensitivityResolverFn,
  SensitivityOverrideFn,
  SigningKeyProvider,
  SubjectKeyStore,
  SubjectKeyTombstone,
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
export { createInMemorySubjectKeyStore } from './subjectKeyStore.js';
export { createAuditMiddleware } from './middleware.js';
export {
  computeMerkleRoot,
  computeMerkleProof,
  verifyMerkleProof,
  canonicalJson,
  stableStringify,
} from './chain.js';
export type { ChainVerification } from './verify.js';
export { verifyAuditChain, verifyManifestSignature } from './verify.js';
