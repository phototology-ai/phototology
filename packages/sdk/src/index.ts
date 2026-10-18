// @phototology/sdk — TypeScript client for the Phototology AI vision API

// Client
export { PhototologyClient } from './client';

// Lens + preset constants (runtime values for enumeration, types for autocomplete)
export { LENS_FIELDS, PRESET_IDS } from './lens-fields';
export type { LensId, PresetId } from './lens-fields';

// Types
export type {
  AnalyzeRequest,
  AnalyzeResponse,
  PhotoAnalyzeResponse,
  VehicleAnalyzeResponse,
  PhotoOutput,
  VehicleOutput,
  AnalyzeUsage,
  AnalyzeMeta,
  Fingerprint,
  ImageInput,
  PersonContext,
  VehicleContext,
  ExtractConfig,
  BespokeMetadata,
  ModulesResponse,
  ModuleInfo,
  PresetInfo,
  UsageResponse,
  ErrorResponse,
  ErrorCredits,
  PlatformErrorCode,
  PhototologyClientConfig,
  LookupRequest,
  LookupResponse,
  LookupResult,
  LensIndexEntry,
  PhotoRecord,
  EnrichRequest,
  EnrichResponse,
  Receipt,
  ReceiptPayload,
  ReceiptSubject,
  ReceiptLens,
  ReceiptTimestamp,
  ReceiptJwk,
  ReceiptJwks,
  CredentialsReport,
  VerifyResponse,
  PhotoResponse,
} from './types';

// Offline receipt signature check (WebCrypto, no network)
export { verifyReceiptSignature, canonicalJson } from './verify';
export type { ReceiptSignatureCheck } from './verify';

// Errors
export {
  PhototologyError,
  AuthenticationError,
  ValidationError,
  RateLimitedError,
  ParseError,
  InternalError,
  ProviderError,
  PlanLimitError,
  CreditExhaustedError,
} from './errors';
