import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setupInteractive } from './setup';
import { SETUP_GUIDE } from './help';
import { startServer } from './server';

export { buildServerInstructions } from './server';

if (process.argv.includes('--help')) {
  console.error(SETUP_GUIDE);
  process.exit(0);
}

const apiKey = process.env.PHOTOTOLOGY_API_KEY;
if (!apiKey) {
  if (process.stdin.isTTY) {
    // Running in a terminal: offer interactive setup
    setupInteractive().catch((err) => {
      console.error('Setup failed:', err);
      process.exit(1);
    });
  } else {
    // Spawned by an MCP client: can't prompt, just print help
    console.error('  Error: PHOTOTOLOGY_API_KEY is not set.\n');
    console.error(SETUP_GUIDE);
    process.exit(1);
  }
} else {
  const version: string = require('../package.json').version;
  startServer(apiKey, new StdioServerTransport(), { version }).catch((err) => {
    console.error('Failed to connect MCP transport:', err);
    process.exit(1);
  });
}
