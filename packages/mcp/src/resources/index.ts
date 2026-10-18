import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient } from '@phototology/sdk';
import { reshapeForMcp } from '../tools/list-lenses';
import { toLookupEnvelope } from '../lib/envelope';

export const LENSES_URI = 'phototology://lenses';
export const PHOTO_URI_TEMPLATE = 'phototology://photo/{sha256}';
export const PHOTO_NOT_IN_REGISTRY = 'PHOTO_NOT_IN_REGISTRY';
const SHA256_HEX = /^[0-9a-f]{64}$/i;

/**
 * Register the server's MCP resources. Order matters for `resources/list`:
 * the lenses catalog is registered first. The photo template sets
 * `list: undefined`, so it appears only in `resources/templates/list` and
 * never enumerates registry photos.
 *
 * Read failures from the API (network, auth) propagate as JSON-RPC errors;
 * a photo the registry does not hold is a normal read that returns the
 * `PHOTO_NOT_IN_REGISTRY` text.
 */
export function registerResources(server: McpServer, client: PhototologyClient): void {
  server.registerResource(
    'lenses',
    LENSES_URI,
    {
      title: 'Lens and stack catalog',
      description: 'Every lens and stack on this server, with the output fields each lens owns and the credits each one costs per photo. The same data list_lenses returns.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const catalog = reshapeForMcp(await client.modules());
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(catalog, null, 2) }],
      };
    },
  );

  server.registerResource(
    'photo',
    new ResourceTemplate(PHOTO_URI_TEMPLATE, { list: undefined }),
    {
      title: 'A photo in the registry',
      description: 'The registry record for one photo, keyed by its SHA-256: its hashes, the lenses already run on it, and their receipts. Free to read.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const notInRegistry = { contents: [{ uri: uri.href, mimeType: 'text/plain', text: PHOTO_NOT_IN_REGISTRY }] };
      const raw = variables.sha256;
      const value = Array.isArray(raw) ? raw[0] : raw;
      // A value that is not a SHA-256 cannot be in the registry: answer locally, no API call.
      if (typeof value !== 'string' || !SHA256_HEX.test(value)) return notInRegistry;
      const sha256 = value.toLowerCase();
      // Row 6 switches this to client.getPhoto.
      const res = await client.lookup({ sha256 });
      const { envelope } = toLookupEnvelope(res, sha256);
      if (envelope.matchType === 'none') return notInRegistry;
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(envelope, null, 2) }],
      };
    },
  );
}
