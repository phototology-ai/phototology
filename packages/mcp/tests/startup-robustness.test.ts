/**
 * The background key check must never hurt the server: a synchronous throw
 * neither rejects startServer nor exits, and a probe that fails on the
 * network leaves a pt_test_ key unknown, so the tools still ask the API.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let throwInKeyCheck = false;

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation((config: { userAgent?: string }) => {
      if (throwInKeyCheck && config?.userAgent?.includes('(key-check)')) {
        throw new Error('key-check client exploded');
      }
      return new actual.PhototologyClient(config);
    }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { startServer } = require('../src/server');

const realFetch = global.fetch;
let fetchMock: jest.Mock;
let exit: jest.SpyInstance;

async function connect(apiKey: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = startServer(apiKey, serverTransport, { version: '0.0.0-test' });
  const client = new Client({ name: 'robustness', version: '0.0.1' });
  await client.connect(clientTransport);
  const { server } = await started;
  return { client, close: async () => { await client.close(); await server.close(); } };
}

beforeEach(() => {
  throwInKeyCheck = false;
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

it('a key check that throws synchronously neither rejects startServer nor exits; the server still answers listTools', async () => {
  throwInKeyCheck = true;
  fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }));
  const { client, close } = await connect('pt_live_robust');
  try {
    expect(exit).not.toHaveBeenCalled();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('get_credits');
  } finally {
    await close();
  }
});

it('a probe that fails on the network leaves a pt_test_ key unknown: get_credits still calls the API', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')); // the start-up /v1/usage probe
  fetchMock.mockImplementation(async () => new Response(
    JSON.stringify({ tier: 'starter', community: { balance: 0 }, purchased: { balance: 10 }, reserved: 0, total: 10 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  const { client, close } = await connect('pt_test_networkprobe');
  try {
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    const result: any = await client.callTool({ name: 'get_credits', arguments: {} });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/v1\/usage$/), expect.anything());
    expect(result.isError).toBeFalsy();
  } finally {
    await close();
  }
});
