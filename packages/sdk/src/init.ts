import * as fs from 'fs';
import * as path from 'path';

const ENV_TEMPLATE = (apiKey: string) =>
  `# Phototology API key
PHOTOTOLOGY_API_KEY=${apiKey}
`;

const EXAMPLE_TEMPLATE = (isTest: boolean) =>
  `// Run with: npx tsx --env-file=.env analyze-example.ts
import { PhototologyClient } from '@phototology/sdk';
${isTest ? '\n// Using test mode — responses are deterministic fixtures (zero AI cost).\n' : ''}
const client = new PhototologyClient();

async function main() {
  // Unsplash CDN serves a generic UA without a 400. Wikimedia's thumb
  // endpoint rejects non-browser UAs, which broke every cold install
  // before Task 2 P0-2 (2026-05-19).
  const result = await client.analyze({
    imageUrl: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800',
  });

  console.info(JSON.stringify(result, null, 2));
  console.info('\\nModules used:', result.usage.modulesUsed.join(', '));
  console.info('Credits charged:', result.usage.creditsCharged ?? 0);
}

main().catch(console.error);
`;

/**
 * Scaffold a Phototology project in the target directory.
 *
 * Exported for testing — the CLI entry point calls this.
 */
export async function scaffold(targetDir: string, apiKey: string): Promise<void> {
  const isTest = apiKey.startsWith('pt_test_');

  // Audit #5 HIGH (2026-05-19): API key materializes on disk — restrict to
  // owner read/write only so a shared box / cloud IDE doesn't leak it.
  fs.writeFileSync(path.join(targetDir, '.env'), ENV_TEMPLATE(apiKey), { mode: 0o600 });
  fs.writeFileSync(path.join(targetDir, 'analyze-example.ts'), EXAMPLE_TEMPLATE(isTest));
}

// CLI entry point — runs when loaded via bin/init.js (require.main is the bin shim, not this module)
if (require.main?.filename?.endsWith('init.js')) {
  (async () => {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    console.error('\n  Phototology — AI Vision Middleware\n');

    const apiKey = process.env.PHOTOTOLOGY_API_KEY ?? await new Promise<string>((resolve) => {
      rl.question('  API Key: ', (answer) => {
        resolve(answer.trim());
        rl.close();
      });
    });

    if (!apiKey) {
      console.error('  Error: API key is required. Set PHOTOTOLOGY_API_KEY or paste it above.');
      process.exit(1);
    }

    await scaffold(process.cwd(), apiKey);

    console.error('\n  Created:');
    console.error('    .env                   — API key');
    console.error('    analyze-example.ts     — Working example script');
    console.error('\n  Next steps:');
    console.error('    npx tsx --env-file=.env analyze-example.ts');
    console.error('    Docs: https://api.phototology.com/v1/docs');
    console.error('    OpenAPI: https://api.phototology.com/v1/openapi.json\n');
  })();
}
