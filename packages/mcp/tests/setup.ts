/**
 * Jest setup for @phototology/mcp, run before every test file.
 *
 * Telemetry is off under NODE_ENV=test: `shouldSkip()` in src/phone-home.ts
 * returns true there unless PHOTOTOLOGY_MCP_TELEMETRY_IN_TESTS is set. Jest
 * sets NODE_ENV=test itself; this guard fails loudly if anything changes that,
 * because the suite would then send real events to production.
 *
 * Put any future suite-wide test environment here.
 */
if (process.env.NODE_ENV !== 'test') {
  throw new Error(
    `@phototology/mcp tests must run with NODE_ENV=test (got ${JSON.stringify(process.env.NODE_ENV)}); ` +
      'otherwise tool telemetry would reach production.',
  );
}
