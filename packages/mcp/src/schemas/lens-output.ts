/**
 * Lens output schema, generated from `LENS_FIELDS`.
 *
 * Every top-level field a lens owns is declared (so it shows up in the
 * tool's JSON Schema), but values stay `unknown`: lens payloads are deep and
 * versioned per lens, and the API is their source of truth. The object is
 * passthrough so a field the SDK mirror does not know yet (a new lens, a
 * bespoke extraction) reaches the agent instead of being stripped.
 */
import { z } from 'zod';
import { LENS_FIELDS } from '@phototology/sdk';

/** Every lens-owned top-level output field, deduplicated, in LENS_FIELDS order. */
export const allLensFields: readonly string[] = [...new Set(Object.values(LENS_FIELDS).flat())];

const lensShape = Object.fromEntries(allLensFields.map((f) => [f, z.unknown().optional()]));

export const LensOutputSchema = z.object(lensShape).passthrough();
export type LensOutput = z.infer<typeof LensOutputSchema>;

/**
 * Test-time twin of `LensOutputSchema` that rejects any field outside
 * LENS_FIELDS. Never published as an outputSchema; the fixture suite uses it
 * so an API output field the SDK mirror does not know fails before publish.
 */
export const LensOutputStrictSchema = z.object(lensShape).strict();
