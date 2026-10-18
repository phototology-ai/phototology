/**
 * Read the Phototology registry id a photo carries in its XMP.
 *
 * `enrich_photo` writes an IPTC Extension `Iptc4xmpExt:RegistryId` entry
 * whose `RegItemId` is the sha256 of the photo's original bytes and whose
 * `RegOrgId` is `phototology.com`. Once the file's bytes change (the enrich
 * itself changes them), that id is still the registry key, so `lookup_photo`
 * tries it before hashing the file.
 *
 * This is a byte scan, not an XMP parser: it looks only at complete packets
 * within the first 2 MB, where JPEG, PNG, WebP and HEIC keep their XMP, and
 * ignores anything inside XML comments.
 *
 * @module lib/registry-id
 */

/** Bytes scanned for the XMP packet. */
export const REGISTRY_SCAN_BYTES = 2 * 1024 * 1024;

/** `RegOrgId` of the entries Phototology writes. */
export const PHOTOTOLOGY_REGISTRY_ORG = 'phototology.com';

const PACKET_BEGIN = '<?xpacket begin';
const PACKET_END = '<?xpacket end';
const REGISTRY_BLOCK = /<([\w.-]+):RegistryId\b[^>]*>([\s\S]*?)<\/\1:RegistryId>/g;
const LIST_ITEM = /<rdf:li\b([^>]*?)(?:\/>|>([\s\S]*?)<\/rdf:li>)/g;
const HEX_64 = /^[0-9a-f]{64}$/;
const XML_COMMENT = /<!--[\s\S]*?-->/g;

/** The value of struct field `name` inside one list item, as an element or an attribute. */
function field(item: string, name: string): string | null {
  const element = new RegExp(`<[\\w.-]+:${name}\\b[^>]*>\\s*([^<]*?)\\s*</[\\w.-]+:${name}>`).exec(item);
  if (element) return element[1];
  const attribute = new RegExp(`[\\w.-]+:${name}\\s*=\\s*(["'])([^"']*)\\1`).exec(item);
  return attribute ? attribute[2].trim() : null;
}

/**
 * Find the Phototology registry id embedded in an image's XMP.
 *
 * @param bytes - The image file's bytes
 * @returns The lower-case sha256 hex id, or `null` when the first 2 MB hold
 *          no XMP packet with a `phototology.com` registry entry whose item
 *          id is 64 hex characters
 *
 * @example
 * ```ts
 * const id = readEmbeddedRegistryId(fs.readFileSync('enriched.jpg'));
 * if (id) await client.lookup({ sha256: id });
 * ```
 */
export function readEmbeddedRegistryId(bytes: Buffer): string | null {
  // latin1 keeps one char per byte; every value matched here is ASCII.
  const text = bytes.subarray(0, REGISTRY_SCAN_BYTES).toString('latin1');

  let from = 0;
  for (;;) {
    const start = text.indexOf(PACKET_BEGIN, from);
    if (start === -1) return null;
    const endAt = text.indexOf(PACKET_END, start);
    // A packet whose end lies past the scan window is not read at all.
    if (endAt === -1) return null;
    const packet = text.slice(start, endAt).replace(XML_COMMENT, '');

    for (const block of packet.matchAll(REGISTRY_BLOCK)) {
      for (const li of block[2].matchAll(LIST_ITEM)) {
        const item = `${li[1]} ${li[2] ?? ''}`;
        const org = field(item, 'RegOrgId');
        if (org?.toLowerCase() !== PHOTOTOLOGY_REGISTRY_ORG) continue;
        const id = field(item, 'RegItemId')?.toLowerCase();
        if (id && HEX_64.test(id)) return id;
      }
    }

    from = endAt + PACKET_END.length;
  }
}
