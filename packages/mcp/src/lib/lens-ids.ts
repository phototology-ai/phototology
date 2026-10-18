import { LENS_FIELDS, type LensId } from '@phototology/sdk';

/**
 * Lenses in LENS_FIELDS (they own output) that are STACK-ONLY: the API rejects
 * them on direct selection (phototology-api/src/services/moduleComposition.ts
 * INTERNAL_MODULES). `vehicle-condition` output comes only from the
 * `vehicle-condition` stack. (2.0.0 Pillar B: the SDK should own this list.)
 */
export const INTERNAL_LENS_IDS: ReadonlySet<string> = new Set<string>(['vehicle-condition']);

/** The lens names an agent may pass in `lenses`: every lens except the stack-only ones. */
export const SELECTABLE_LENS_IDS = (Object.keys(LENS_FIELDS) as LensId[])
  .filter((id) => !INTERNAL_LENS_IDS.has(id)) as [LensId, ...LensId[]];
