/**
 * Output-schema conformance against the API's golden fixtures.
 *
 * Every JSON under packages/phototology-api/src/fixtures is wrapped the way
 * analyze_photo builds its envelope (Task 5.2) and must validate against
 * AnalyzePhotoOutputSchema. A schema that drifts from real output fails here,
 * before publish. The MCP has no dependency on the API, so fixtures are read
 * by relative path.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LENS_FIELDS, PRESET_IDS } from '@phototology/sdk';
import {
  AnalyzeBatchOutputSchema,
  AnalyzePhotoOutputSchema,
  EnrichPhotoOutputSchema,
  GetCreditsOutputSchema,
  ListLensesOutputSchema,
  LensOutputSchema,
  LensOutputStrictSchema,
  LookupPhotoOutputSchema,
  PhotoIdentitySchema,
  PurchaseCreditsOutputSchema,
  UsageSchema,
  toJsonSchema,
} from '../src/schemas';

const FIXTURE_DIR = path.resolve(__dirname, '../../phototology-api/src/fixtures');
const SHA = 'a'.repeat(64);

const fixtureFiles = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

function loadFixture(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

/** The envelope analyze_photo will build around an API output (Task 5.2). */
function wrap(output: Record<string, unknown>) {
  return {
    photo: { sha256: SHA, pHash: 'ff00ff00ff00ff00', dHash: '00ff00ff00ff00ff' },
    output,
    lenses: ['dating', 'people'],
    usage: {
      creditsCharged: 2,
      creditsSaved: 0,
      usd: { charged: '0.02', saved: '0.00' },
      modulesUsed: ['dating', 'people'],
    },
    cacheHit: false,
    receipts: [],
    resource: `phototology://photo/${SHA}`,
    livemode: false,
  };
}

describe('API fixtures validate against AnalyzePhotoOutputSchema', () => {
  it('finds the fixture directory and at least the core fixtures', () => {
    expect(fixtureFiles).toEqual(
      expect.arrayContaining(['photo-analysis.json', 'memorial.json', 'quick-scan.json', 'vehicle-condition.json']),
    );
  });

  it.each(fixtureFiles)('%s wrapped as an analyze_photo result validates', (file) => {
    const result = AnalyzePhotoOutputSchema.safeParse(wrap(loadFixture(file)));
    if (!result.success) throw new Error(`${file}: ${result.error.message}`);
    expect(result.success).toBe(true);
  });

  /**
   * Bespoke fixtures are user-defined extraction output and its input schema,
   * so their keys are outside LENS_FIELDS by design.
   */
  const NOT_LENS_OUTPUT = new Set(['bespoke.json', 'bespoke-schema.json']);
  it.each(fixtureFiles.filter((f) => !NOT_LENS_OUTPUT.has(f)))(
    '%s output has no field outside LENS_FIELDS (strict)',
    (file) => {
      const result = LensOutputStrictSchema.safeParse(loadFixture(file));
      if (!result.success) throw new Error(`${file}: ${result.error.message}`);
      expect(result.success).toBe(true);
    },
  );

  it('the strict variant rejects a field outside LENS_FIELDS', () => {
    const output = { ...loadFixture('quick-scan.json'), someFutureLensField: 1 };
    expect(LensOutputStrictSchema.safeParse(output).success).toBe(false);
  });

  it('keeps lens fields that LENS_FIELDS does not know (passthrough)', () => {
    const output = { ...loadFixture('photo-analysis.json'), someFutureLensField: { a: 1 } };
    const result = AnalyzePhotoOutputSchema.safeParse(wrap(output));
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data.output as Record<string, unknown>).someFutureLensField).toEqual({ a: 1 });
    }
  });

  it('rejects an envelope missing usage', () => {
    const { usage: _usage, ...noUsage } = wrap(loadFixture('photo-analysis.json'));
    expect(AnalyzePhotoOutputSchema.safeParse(noUsage).success).toBe(false);
  });

  it('rejects usage without the dollar figures', () => {
    const env = wrap(loadFixture('quick-scan.json'));
    const bad = { ...env, usage: { creditsCharged: 1, creditsSaved: 0, modulesUsed: [] } };
    expect(AnalyzePhotoOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('LensOutputSchema is generated from LENS_FIELDS', () => {
  it('declares every lens field as a property', () => {
    const allFields = Object.values(LENS_FIELDS).flat();
    const keys = Object.keys(LensOutputSchema.shape);
    for (const f of allFields) expect(keys).toContain(f);
    expect(keys).toHaveLength(new Set(allFields).size);
  });
});

describe('toJsonSchema', () => {
  it('emits an object schema with the photo property for analyze_photo', () => {
    const js = toJsonSchema(AnalyzePhotoOutputSchema);
    expect(js.type).toBe('object');
    expect((js.properties as Record<string, unknown>).photo).toBeDefined();
    expect(js.required).toEqual(expect.arrayContaining(['photo', 'output', 'usage']));
  });

  it('never closes an object node in any published schema', () => {
    const closed: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}[${i}]`));
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj.additionalProperties === false) closed.push(at);
      for (const [k, v] of Object.entries(obj)) walk(v, `${at}.${k}`);
    };
    const published = {
      AnalyzePhotoOutputSchema,
      AnalyzeBatchOutputSchema,
      LookupPhotoOutputSchema,
      ListLensesOutputSchema,
      GetCreditsOutputSchema,
      PurchaseCreditsOutputSchema,
      EnrichPhotoOutputSchema,
    };
    for (const [name, schema] of Object.entries(published)) walk(toJsonSchema(schema), name);
    expect(closed).toEqual([]);
  });

  it('the walker would catch a closed object', () => {
    expect(toJsonSchema(LensOutputStrictSchema).additionalProperties).toBe(false);
  });
});

describe('the other envelopes accept representative results', () => {
  const analyzed = wrap(loadFixture('quick-scan.json'));

  it('PhotoIdentitySchema takes the new fingerprint fields', () => {
    expect(
      PhotoIdentitySchema.safeParse({
        sha256: SHA,
        pixelsSha256: 'b'.repeat(64),
        pHash: 'ff00ff00ff00ff00',
        dHash: '00ff00ff00ff00ff',
        pdq: { hash: 'c'.repeat(64), quality: 100 },
        iscc: 'ISCC:EEAXXXXXXXXXXXXX',
      }).success,
    ).toBe(true);
  });

  it('UsageSchema needs creditsSaved', () => {
    expect(
      UsageSchema.safeParse({ creditsCharged: 1, usd: { charged: '0.01', saved: '0.00' }, modulesUsed: [] }).success,
    ).toBe(false);
  });

  it('AnalyzeBatchOutputSchema takes successes, inline errors, and dry-run rows', () => {
    const batch = {
      summary: {
        photos: 3,
        cacheHits: 1,
        creditsCharged: 2,
        creditsSaved: 2,
        usd: { charged: '0.02', saved: '0.02' },
        estimate: { photos: 3, cacheHits: 1, creditsNeeded: 4, usd: '0.04' },
      },
      results: [
        { ...analyzed, input: 'https://example.com/a.jpg' },
        { error: { code: 'FILE_NOT_FOUND', message: 'No such file' }, input: '/tmp/missing.jpg' },
        { input: 'https://example.com/b.jpg', matchType: 'exact', cachedLenses: ['dating'], missingLenses: [] },
      ],
    };
    const r = AnalyzeBatchOutputSchema.safeParse(batch);
    if (!r.success) throw new Error(r.error.message);
    expect(AnalyzeBatchOutputSchema.safeParse({ ...batch, summary: { ...batch.summary, dryRun: true } }).success).toBe(
      true,
    );
    expect(AnalyzeBatchOutputSchema.safeParse({ results: [] }).success).toBe(false);
  });

  it('batch photo rows may name how the registry matched them, and may have no resource', () => {
    const summary = {
      photos: 1, cacheHits: 1, creditsCharged: 0, creditsSaved: 1,
      usd: { charged: '0.00', saved: '0.01' },
      estimate: { photos: 1, cacheHits: 1, creditsNeeded: 0, usd: '0.00' },
    };
    const { resource: _r, ...noResource } = analyzed;
    for (const matchType of ['exact', 'pixels', 'pdq', 'fuzzy']) {
      const r = AnalyzeBatchOutputSchema.safeParse({ summary, results: [{ ...analyzed, input: 'a', matchType }] });
      if (!r.success) throw new Error(`${matchType}: ${r.error.message}`);
    }
    expect(AnalyzeBatchOutputSchema.safeParse({ summary, results: [{ ...analyzed, input: 'a', matchType: 'similar' }] }).success).toBe(false);
    expect(AnalyzeBatchOutputSchema.safeParse({ summary, results: [{ ...noResource, input: 'a' }] }).success).toBe(true);
  });

  it('LookupPhotoOutputSchema accepts pixels and pdq matches and a miss', () => {
    const photo = {
      sha256: SHA,
      pHash: 'ff00ff00ff00ff00',
      dHash: '00ff00ff00ff00ff',
      firstAnalyzedAt: '2026-10-17T00:00:00.000Z',
      lastAnalyzedAt: '2026-10-17T00:00:00.000Z',
      totalCreditsSpent: 2,
      analyzeCallCount: 1,
      lenses: {
        dating: {
          eventId: 'e1',
          output: { estimatedDate: { year: 1974 } },
          version: '1',
          producedAt: '2026-10-17T00:00:00.000Z',
          coRunHash: 'x',
          provider: 'google',
        },
      },
    };
    for (const matchType of ['exact', 'pixels', 'pdq', 'fuzzy']) {
      const r = LookupPhotoOutputSchema.safeParse({
        matchType,
        photo,
        receipts: [],
        resource: `phototology://photo/${SHA}`,
      });
      if (!r.success) throw new Error(`${matchType}: ${r.error.message}`);
    }
    expect(LookupPhotoOutputSchema.safeParse({ matchType: 'none', receipts: [] }).success).toBe(true);
    expect(LookupPhotoOutputSchema.safeParse({ matchType: 'similar', receipts: [] }).success).toBe(false);
  });

  it('ListLensesOutputSchema takes per-lens and per-stack prices', () => {
    const r = ListLensesOutputSchema.safeParse({
      lenses: [
        {
          name: 'dating',
          description: 'When',
          category: 'temporal',
          outputFields: ['estimatedDate'],
          billable: true,
          credits: 1,
          defaultColumns: [{ label: 'estimated_year', jsonPath: 'dating.estimatedYear', format: 'number' }],
        },
        {
          name: 'moderation',
          description: 'Safety',
          category: 'safety',
          outputFields: ['moderation'],
          billable: false,
          credits: 0,
          defaultColumns: [],
          internal: true,
        },
      ],
      stacks: [{ name: PRESET_IDS[1], description: 'Fast', lenses: ['dating', 'moderation'], credits: 1, usdPerPhoto: '0.01' }],
    });
    if (!r.success) throw new Error(r.error.message);
  });

  it('GetCreditsOutputSchema takes today\'s balance plus usd', () => {
    const r = GetCreditsOutputSchema.safeParse({
      tier: 'starter',
      total: 1200,
      community: { balance: 1000, monthlyAllowance: 0, resetsInDays: 0 },
      purchased: { balance: 200 },
      reserved: 0,
      usd: '12.00',
    });
    if (!r.success) throw new Error(r.error.message);
  });

  it('PurchaseCreditsOutputSchema takes the wallet url and its open_url action', () => {
    const url = 'https://phototology.com/wallet?utm_source=mcp';
    const r = PurchaseCreditsOutputSchema.safeParse({
      url,
      actions: [{ type: 'open_url', label: 'Open the Phototology wallet to buy credits', url }],
    });
    if (!r.success) throw new Error(r.error.message);
  });

  it('EnrichPhotoOutputSchema takes file and sidecar results', () => {
    const base = {
      formatsWritten: ['xmp'],
      lensVersions: { dating: '1' },
      sha256: SHA,
      usage: { creditsCharged: 5, usd: { charged: '0.05' } },
    };
    for (const v of [
      { ...base, mode: 'file', savedTo: '/tmp/out.jpg' },
      { ...base, mode: 'file', imageBase64: 'AAAA' },
      { ...base, mode: 'sidecar', sidecarSavedTo: '/tmp/in.jpg.xmp', reason: 'valid Content Credential', credentials: { status: 'valid' } },
      {
        ...base,
        mode: 'sidecar',
        sidecar: { xmp: '<x:xmpmeta/>' },
        warnings: ['CREDENTIALS_UNREAD'],
        note: 'The photo was left untouched.',
        credentials: {
          status: 'valid', aiGenerated: false, signer: { name: 'Example Camera', issuer: 'Example CA' },
          captureDevice: null, signedAt: '2026-10-01T00:00:00Z', trustList: null, assertions: ['c2pa.actions'],
          note: 'Missing credentials mean no provenance was attached, not that the image is fake.',
        },
      },
      { ...base, mode: 'sidecar', sidecar: { xmp: '<x:xmpmeta/>' }, registryId: 'r1' },
    ]) {
      const r = EnrichPhotoOutputSchema.safeParse(v);
      if (!r.success) throw new Error(r.error.message);
    }
    expect(EnrichPhotoOutputSchema.safeParse({ ...base, mode: 'inline' }).success).toBe(false);
  });
});
