/**
 * LENS_FIELDS — authoritative mapping from lens ID to the top-level
 * VisionOutput field names that lens owns.
 *
 * This is a mirror of the constant in `@phototology/core`. The SDK is
 * standalone by design (zero monorepo dependencies in its published
 * form), so it maintains its own copy. A sync test in
 * `tests/lens-fields.sync.test.ts` runs against core at build time and
 * fails if the two drift. Add a lens there and here together.
 *
 * Consumers use this in two ways:
 *   1. As a type source — `LensId` narrows `AnalyzeRequest.modules` so
 *      IDE autocomplete shows the valid names.
 *   2. As a runtime value — `Object.keys(LENS_FIELDS)` enumerates the
 *      current lens list without a network round-trip to `/v1/modules`.
 *
 * Behavioral modules (`base`, `vehicle-base`, `multi-image`, `multi-image-vehicle`)
 * produce no output and are intentionally absent. They're internal to
 * the prompt engine.
 *
 * @module lens-fields
 */
export const LENS_FIELDS = {
  dating: [
    'estimatedDate', 'techAnchors', 'temporalMarkers', 'title', 'genre',
    'caption', 'dateAnchors', 'season', 'holiday', 'event', 'visibleDates',
    'reproduction',
  ],
  people: ['physicalObservations', 'collectionDynamics', 'peopleCount'],
  location: ['location'],
  atmosphere: ['atmosphere', 'emotions', 'warmCaption', 'semanticDescription'],
  entities: ['entities'],
  accessibility: ['accessibility'],
  'photo-quality': ['quality', 'visualFaults', 'rotation', 'documentClassification', 'scan'],
  'text-content': ['textContent'],
  composition: ['composition'],
  moderation: ['moderation'],
  describe: ['describe'],
  condition: ['condition'],
  authenticity: ['authenticity'],
  'color-palette': ['colorPalette'],
  automobile: ['automobile'],
  'vehicle-condition': [
    'overallCondition', 'componentGrades', 'observations', 'accidentIndicators',
    'photoQuality', 'missingViews', 'vehicleContext', 'photos', 'sellerSummary',
  ],
} as const satisfies Record<string, readonly string[]>;

/** Valid lens IDs. */
export type LensId = keyof typeof LENS_FIELDS;

/** Valid curated-stack IDs. The field is `preset` on the wire for back-compat. Curated stacks compose multiple lenses. */
export const PRESET_IDS = [
  'full-analysis',
  'quick-scan',
  'automobile',
  'claims',
  'property',
  'ecommerce',
  'memorial',
  'vehicle-condition',
] as const satisfies readonly string[];

export type PresetId = typeof PRESET_IDS[number];
