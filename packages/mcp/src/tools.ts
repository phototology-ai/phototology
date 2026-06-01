// Re-export shim — historical import path for `registerTools`. New code
// should import from `./tools/index`. Kept so consumers and existing
// tests under `tests/` continue to work without changes.
export { registerTools } from './tools/index';
