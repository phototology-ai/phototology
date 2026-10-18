/**
 * readEmbeddedRegistryId: find the Phototology registry id in a file's XMP.
 *
 * `fixtures/registry-id.jpg` was written by the core MetadataWriter (see
 * fixtures/SOURCES.md); `registry-id.txt` holds the id it carries.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEmbeddedRegistryId } from '../src/lib/registry-id';

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/registry-id.jpg'));
const FIXTURE_ID = fs.readFileSync(path.join(__dirname, 'fixtures/registry-id.txt'), 'utf8').trim();

const ID = 'c0ffee'.repeat(10) + 'abcd';
const SOI = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

function packet(rdfBody: string): string {
  return [
    "<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>",
    "<x:xmpmeta xmlns:x='adobe:ns:meta/'>",
    "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>",
    "<rdf:Description rdf:about='' xmlns:Iptc4xmpExt='http://iptc.org/std/Iptc4xmpExt/2008-02-29/'>",
    rdfBody,
    '</rdf:Description></rdf:RDF></x:xmpmeta>',
    "<?xpacket end='w'?>",
  ].join('\n');
}

function jpegWith(xmp: string, padBefore = 0): Buffer {
  return Buffer.concat([SOI, Buffer.alloc(padBefore, 0x20), Buffer.from(xmp, 'utf8'), Buffer.from([0xff, 0xd9])]);
}

function elementEntry(itemId: string, org: string): string {
  return `<rdf:li rdf:parseType='Resource'>
     <Iptc4xmpExt:RegEntryRole>primary</Iptc4xmpExt:RegEntryRole>
     <Iptc4xmpExt:RegItemId>${itemId}</Iptc4xmpExt:RegItemId>
     <Iptc4xmpExt:RegOrgId>${org}</Iptc4xmpExt:RegOrgId>
    </rdf:li>`;
}

function bag(...items: string[]): string {
  return `<Iptc4xmpExt:RegistryId><rdf:Bag>${items.join('\n')}</rdf:Bag></Iptc4xmpExt:RegistryId>`;
}

describe('readEmbeddedRegistryId', () => {
  it('finds the id in a JPEG the core writer produced', () => {
    expect(FIXTURE_ID).toMatch(/^[0-9a-f]{64}$/);
    expect(readEmbeddedRegistryId(FIXTURE)).toBe(FIXTURE_ID);
  });

  it('returns null for a plain JPEG with no XMP', () => {
    expect(readEmbeddedRegistryId(Buffer.concat([SOI, Buffer.from([0xff, 0xd9])]))).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    expect(readEmbeddedRegistryId(Buffer.alloc(0))).toBeNull();
  });

  it('returns null when the only entry belongs to another registry', () => {
    expect(readEmbeddedRegistryId(jpegWith(packet(bag(elementEntry(ID, 'example.org')))))).toBeNull();
  });

  it('picks the phototology.com entry when another registry comes first', () => {
    const xmp = packet(bag(elementEntry('f'.repeat(64), 'example.org'), elementEntry(ID, 'phototology.com')));
    expect(readEmbeddedRegistryId(jpegWith(xmp))).toBe(ID);
  });

  it('reads the attribute form', () => {
    const xmp = packet(bag(
      `<rdf:li Iptc4xmpExt:RegOrgId="phototology.com" Iptc4xmpExt:RegItemId="${ID}" Iptc4xmpExt:RegEntryRole="primary"/>`,
    ));
    expect(readEmbeddedRegistryId(jpegWith(xmp))).toBe(ID);
  });

  it('reads the attribute form on a nested rdf:Description', () => {
    const xmp = packet(bag(
      `<rdf:li><rdf:Description Iptc4xmpExt:RegItemId='${ID}' Iptc4xmpExt:RegOrgId='phototology.com'/></rdf:li>`,
    ));
    expect(readEmbeddedRegistryId(jpegWith(xmp))).toBe(ID);
  });

  it('returns a lower-case id when the file holds upper case', () => {
    const xmp = packet(bag(elementEntry(ID.toUpperCase(), 'phototology.com')));
    expect(readEmbeddedRegistryId(jpegWith(xmp))).toBe(ID);
  });

  it('returns null when the item id is not 64 hex characters', () => {
    expect(readEmbeddedRegistryId(jpegWith(packet(bag(elementEntry('abc123', 'phototology.com')))))).toBeNull();
  });

  it('does not pair an id with the organisation of a different entry', () => {
    const xmp = packet(bag(
      `<rdf:li rdf:parseType='Resource'><Iptc4xmpExt:RegItemId>${ID}</Iptc4xmpExt:RegItemId><Iptc4xmpExt:RegOrgId>example.org</Iptc4xmpExt:RegOrgId></rdf:li>`,
      `<rdf:li rdf:parseType='Resource'><Iptc4xmpExt:RegItemId>museum-7</Iptc4xmpExt:RegItemId><Iptc4xmpExt:RegOrgId>phototology.com</Iptc4xmpExt:RegOrgId></rdf:li>`,
    ));
    expect(readEmbeddedRegistryId(jpegWith(xmp))).toBeNull();
  });

  it('ignores an entry inside an XML comment', () => {
    const xmp = packet(`<!-- ${bag(elementEntry(ID, 'phototology.com'))} -->`);
    expect(readEmbeddedRegistryId(jpegWith(xmp))).toBeNull();
  });

  it('returns null, without throwing, for a packet that starts inside the first 2 MB but ends past it', () => {
    const xmp = packet(bag(elementEntry(ID, 'phototology.com')));
    // The id sits inside the window; the packet end marker does not.
    const tail = Buffer.alloc(2 * 1024 * 1024, 0x20);
    const end = xmp.indexOf("<?xpacket end");
    const bytes = Buffer.concat([
      SOI,
      Buffer.from(xmp.slice(0, end), 'utf8'),
      tail,
      Buffer.from(xmp.slice(end), 'utf8'),
    ]);
    expect(() => readEmbeddedRegistryId(bytes)).not.toThrow();
    expect(readEmbeddedRegistryId(bytes)).toBeNull();
  });

  it('ignores a packet that starts after the first 2 MB', () => {
    const xmp = packet(bag(elementEntry(ID, 'phototology.com')));
    expect(readEmbeddedRegistryId(jpegWith(xmp, 2 * 1024 * 1024))).toBeNull();
    expect(readEmbeddedRegistryId(jpegWith(xmp, 1024))).toBe(ID);
  });
});
