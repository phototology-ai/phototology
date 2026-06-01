// Mock Phototology API for dogfooding the out-of-credits flow in a real
// MCP client (Claude Code, Cursor, Claude Desktop). Returns a 402 with the
// dual-pool credit-exhausted payload so the MCP's `analyze_photo` tool
// surfaces its structured `open_url` action.
//
// Other endpoints (`/v1/modules`, `/v1/usage`, `/v2/lookup`) return
// realistic shapes so the rest of the tools work normally.
//
// Run it:
//
//   node packages/phototology-mcp/scripts/dogfood/mock-out-of-credits.mjs
//
// Point the MCP at it:
//
//   PHOTOTOLOGY_API_KEY=pt_test_dogfood_local \
//   PHOTOTOLOGY_BASE_URL=http://localhost:3999 \
//   node packages/phototology-mcp/dist/index.js

import http from 'node:http';

const PORT = 3999;

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body, null, 2));
};

const requestId = () => `req_dogfood_${Math.random().toString(36).slice(2, 10)}`;

const server = http.createServer((req, res) => {
  const { method, url } = req;
  console.log(`  ${method} ${url}`);

  // Modules discovery -- returns a small fixture so list_lenses works.
  if (method === 'GET' && url === '/v1/modules') {
    return json(res, 200, {
      modules: [
        { name: 'dating', description: 'Date estimation', category: 'temporal', outputFields: ['estimatedDate'] },
        { name: 'people', description: 'People count + descriptions', category: 'subjects', outputFields: ['peopleCount', 'physicalObservations'] },
        { name: 'automobile', description: 'Vehicle make + model', category: 'subjects', outputFields: ['automobile'] },
        { name: 'describe', description: 'Plain-language description', category: 'overview', outputFields: ['describe'] },
      ],
      presets: [
        { name: 'full-analysis', description: 'Every lens', modules: ['dating', 'people', 'automobile', 'describe'] },
        { name: 'automobile', description: 'Vehicle workflow', modules: ['automobile', 'describe'] },
      ],
    });
  }

  // Usage / balance -- shows the user is nearly out so get_credits is realistic.
  if (method === 'GET' && url === '/v1/usage') {
    return json(res, 200, {
      tier: 'starter',
      community: { balance: 1, monthlyAllowance: 1000, resetsInDays: 12 },
      purchased: { balance: 0 },
      reserved: 0,
    });
  }

  // Registry lookup -- returns empty so the agent's first instinct is to analyze.
  if (method === 'GET' && url.startsWith('/v2/lookup')) {
    return json(res, 200, {
      object: 'lookup',
      results: {},
      meta: { imagesSubmitted: 1, imagesMatched: 0, processingTimeMs: 3, requestId: requestId() },
    });
  }
  if (method === 'POST' && url === '/v2/lookup') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      json(res, 200, {
        object: 'lookup',
        results: {},
        meta: { imagesSubmitted: 1, imagesMatched: 0, processingTimeMs: 3, requestId: requestId() },
      });
    });
    return;
  }

  // Analyze -- ALWAYS returns 402 PLAN_LIMIT_EXCEEDED so the MCP surfaces
  // its structured `open_url` action. This is the whole point of this mock.
  if (method === 'POST' && url === '/v1/analyze') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      json(res, 402, {
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Insufficient credits. 16 needed, 1 available (community: 1, purchased: 0). Buy credits at phototology.com/wallet',
          retryable: false,
          requestId: requestId(),
          credits: {
            needed: 16,
            community: 1,
            purchased: 0,
            total: 1,
            resetsInDays: 12,
          },
        },
      });
    });
    return;
  }

  // Anything else: 404.
  json(res, 404, { error: { code: 'NOT_FOUND', message: `No mock route for ${method} ${url}`, retryable: false, requestId: requestId() } });
});

server.listen(PORT, () => {
  console.log(`\n  Phototology dogfood mock listening on http://localhost:${PORT}`);
  console.log(`  All /v1/analyze calls will return 402 PLAN_LIMIT_EXCEEDED.`);
  console.log(`  Press Ctrl-C to stop.\n`);
});
