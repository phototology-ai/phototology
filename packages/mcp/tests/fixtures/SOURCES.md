# Test fixtures

- `registry-id.jpg`: a 32 x 24 solid orange JPEG made with sharp, then written by the core `MetadataWriter` with `registryItemId` set to the sha256 of those original bytes, so its XMP carries an `Iptc4xmpExt:RegistryId` entry (`RegOrgId` `phototology.com`, role `primary`). `registry-id.txt` holds that id. Made 2026-10-17 by `packages/phototology/__tests__/metadata/MetadataWriter.registryId.test.ts` run with `WRITE_MCP_REGISTRY_FIXTURE=1`; the same test, without the flag, checks the committed file still carries the id.
