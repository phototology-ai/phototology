import type {
  AnalyzeRequest,
  AnalyzeResponse,
  PhotoOutput,
  VehicleOutput,
  ModulesResponse,
  ErrorResponse,
} from '../src/types';

describe('types', () => {
  describe('AnalyzeRequest', () => {
    it('accepts single imageUrl with preset', () => {
      const req: AnalyzeRequest = {
        imageUrl: 'https://example.com/photo.jpg',
        preset: 'full-analysis',
      };
      expect(req.imageUrl).toBe('https://example.com/photo.jpg');
    });

    it('accepts images array', () => {
      const req: AnalyzeRequest = {
        images: [
          { url: 'https://example.com/front.jpg' },
          { base64: 'aGVsbG8=' },
        ],
      };
      expect(req.images).toHaveLength(2);
    });

    it('accepts context and options', () => {
      const req: AnalyzeRequest = {
        imageUrl: 'https://example.com/photo.jpg',
        context: {
          knownPeople: [{ name: 'Alice', birthYear: 1950 }],
          vehicle: { vin: '1HGCM82633A004352', year: 2019 },
        },
        options: { includeEmbedding: true, includeFingerprint: true },
      };
      expect(req.context?.knownPeople?.[0].name).toBe('Alice');
    });
  });

  describe('AnalyzeResponse discriminated union', () => {
    it('narrows photo output when outputSchema is photo', () => {
      const response: AnalyzeResponse = {
        id: 'ana_test',
        object: 'analysis',
        livemode: true,
        schemaVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00Z',
        outputSchema: 'photo',
        output: {},
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          modulesUsed: ['dating'],
        },
        warnings: [],
        meta: {
          processingTimeMs: 500,
          provider: 'gemini',
          promptHash: 'abc123',
          requestId: 'req_test',
          ai_generated: true,
          model: 'gemini-2.0-flash',
          vendor: 'google',
        },
      };
      if (response.outputSchema === 'photo') {
        const _output: PhotoOutput = response.output;
        expect(_output).toBeDefined();
      }
    });

    it('narrows vehicle output when outputSchema is vehicle', () => {
      const response: AnalyzeResponse = {
        id: 'ana_test',
        object: 'analysis',
        livemode: true,
        schemaVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00Z',
        outputSchema: 'vehicle',
        output: {},
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          modulesUsed: ['vehicle-condition'],
        },
        warnings: [],
        meta: {
          processingTimeMs: 500,
          provider: 'gemini',
          promptHash: 'abc123',
          requestId: 'req_test',
          ai_generated: true,
          model: 'gemini-2.0-flash',
          vendor: 'google',
        },
      };
      if (response.outputSchema === 'vehicle') {
        const _output: VehicleOutput = response.output;
        expect(_output).toBeDefined();
      }
    });

    it('includes optional embedding and fingerprint', () => {
      const response: AnalyzeResponse = {
        id: 'ana_test',
        object: 'analysis',
        livemode: true,
        schemaVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00Z',
        outputSchema: 'photo',
        output: {},
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          modulesUsed: [],
        },
        warnings: [],
        meta: {
          processingTimeMs: 1,
          provider: 'test-sandbox',
          promptHash: 'test',
          requestId: 'req_test',
          ai_generated: true,
          model: 'gemini-2.0-flash',
          vendor: 'google',
        },
        embedding: [0.1, 0.2, 0.3],
        fingerprint: { pHash: 'a', dHash: 'b', sha256: 'c' },
      };
      expect(response.embedding).toHaveLength(3);
      expect(response.fingerprint?.sha256).toBe('c');
    });
  });

  describe('ErrorResponse', () => {
    it('has required fields', () => {
      const err: ErrorResponse = {
        error: {
          code: 'AUTH_FAILED',
          message: 'Invalid API key',
          retryable: false,
          requestId: 'req_test',
        },
      };
      expect(err.error.retryable).toBe(false);
    });
  });

  describe('ModulesResponse', () => {
    it('has modules and presets arrays', () => {
      const resp: ModulesResponse = {
        modules: [
          {
            name: 'dating',
            description: 'Date estimation',
            category: 'temporal',
            outputFields: ['estimatedDate'],
            billable: true,
            defaultColumns: [
              { label: 'estimated_year', jsonPath: 'dating.estimatedYear', format: 'number' },
            ],
          },
        ],
        presets: [
          { name: 'full-analysis', description: 'Full analysis', modules: ['dating'] },
        ],
      };
      expect(resp.modules[0].name).toBe('dating');
    });
  });
});
