/**
 * Sync test — verifies SDK's `LENS_FIELDS` matches `@phototology/core`'s.
 *
 * The SDK intentionally has no monorepo runtime dependency on core (it's
 * published standalone), but we mirror the LENS_FIELDS constant into SDK
 * source so consumers get type-safe `modules: LensId[]` without pulling
 * core. This test catches drift — adding a lens to core without
 * updating SDK's copy would ship an SDK with stale autocomplete.
 *
 * When this test fails:
 *   1. Copy the new/changed entries from
 *      `packages/phototology/src/schema/lens-fields.ts` into
 *      `packages/phototology-sdk/src/lens-fields.ts`.
 *   2. Also update `PRESET_IDS` here if the preset list changed —
 *      check `packages/phototology-api/src/services/moduleComposition.ts`.
 *   3. Rebuild, rerun.
 */
// Relative monorepo-path import — SDK has no runtime dep on core, so this
// only works in-tree. That's the point: published SDK doesn't carry core,
// but dev runs this test to catch drift.
import { LENS_FIELDS as CORE_LENS_FIELDS } from '../../phototology/src/schema/lens-fields';
import { LENS_FIELDS as SDK_LENS_FIELDS } from '../src/lens-fields';

describe('SDK LENS_FIELDS sync with @phototology/core', () => {
  it('every lens ID in core is in SDK and vice versa', () => {
    const coreIds = Object.keys(CORE_LENS_FIELDS).sort();
    const sdkIds = Object.keys(SDK_LENS_FIELDS).sort();
    expect(sdkIds).toEqual(coreIds);
  });

  it('every owned-field array matches core for each lens ID', () => {
    for (const lensId of Object.keys(CORE_LENS_FIELDS)) {
      const coreFields = [...(CORE_LENS_FIELDS as Record<string, readonly string[]>)[lensId]].sort();
      const sdkFields = [...(SDK_LENS_FIELDS as Record<string, readonly string[]>)[lensId]].sort();
      expect(sdkFields).toEqual(coreFields);
    }
  });
});
