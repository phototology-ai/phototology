/**
 * Output schemas for every MCP tool (spec §10.1), plus the JSON Schema
 * converter the tools register as `outputSchema`.
 */
import { z } from 'zod';

export * from './lens-output';
export * from './envelopes';

/**
 * Convert a Zod schema to JSON Schema 2020-12 for a tool's `outputSchema`.
 *
 * Every envelope is a loose object, so the result never carries
 * `additionalProperties: false`: a field the API adds later cannot make a
 * client reject `structuredContent`. Required fields and types still apply.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
