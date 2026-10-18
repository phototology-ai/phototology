/**
 * sharp is a native module. If its binary fails to load on the user's machine,
 * only the enrich_photo preview may be lost: the server must still start, and
 * a paid enrich must still return its result with a warning.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

jest.mock('sharp', () => {
  throw new Error('Could not load the "sharp" module using the darwin-arm64 runtime');
});

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return { ...actual, PhototologyClient: jest.fn() };
});

describe('sharp fails to load', () => {
  it('loading every tool module does not throw', () => {
    expect(() => require('../src/tools')).not.toThrow();
  });

  it('enrich_photo still returns the paid result, with a warning and no image block', async () => {
    const { registerEnrichPhoto } = require('../src/tools/enrich-photo');
    const { EnrichPhotoOutputSchema } = require('../src/schemas');
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    const enriched = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xaa, 0xbb]).toString('base64');
    registerEnrichPhoto(server, {
      enrich: jest.fn().mockResolvedValue({
        object: 'enrichment', imageBase64: enriched, formatsWritten: ['xmp'], lensVersions: { dating: '1.0' },
        sha256: 'deadbeef'.repeat(8), meta: { requestId: 'r', processingTimeMs: 1, creditsCharged: 5, ai_generated: true },
      }),
    });
    const handler = spy.mock.calls.find((c) => c[0] === 'enrich_photo')![2] as any;

    const result = await handler({ imageUrl: 'https://example.com/p.jpg' });

    expect(result.isError).toBeFalsy();
    expect(result.content.filter((c: any) => c.type === 'image')).toHaveLength(0);
    const sc = EnrichPhotoOutputSchema.parse(result.structuredContent);
    expect(sc.imageBase64).toBe(enriched);
    expect(sc.usage.creditsCharged).toBe(5);
    expect(sc.warnings).toEqual([expect.stringMatching(/No preview.*sharp/)]);
  });
});
