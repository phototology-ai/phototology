import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PhototologyClient, AuthenticationError } from '@phototology/sdk';

const HOME = process.env.HOME || process.env.USERPROFILE || '~';

interface EditorConfig {
  name: string;
  configPath: string;
  format: 'json' | 'toml';
  topLevelKey: string;
  extraFields?: Record<string, string>;
}

const EDITORS: EditorConfig[] = [
  {
    name: 'Claude Code',
    configPath: path.join(HOME, '.claude', 'settings.json'),
    format: 'json',
    topLevelKey: 'mcpServers',
  },
  {
    name: 'Cursor',
    configPath: path.join(process.cwd(), '.cursor', 'mcp.json'),
    format: 'json',
    topLevelKey: 'mcpServers',
  },
  {
    name: 'VS Code Copilot',
    configPath: path.join(process.cwd(), '.vscode', 'mcp.json'),
    format: 'json',
    topLevelKey: 'servers',
    extraFields: { type: 'stdio' },
  },
  {
    name: 'Gemini CLI',
    configPath: path.join(HOME, '.gemini', 'settings.json'),
    format: 'json',
    topLevelKey: 'mcpServers',
  },
  {
    name: 'Windsurf',
    configPath: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'json',
    topLevelKey: 'mcpServers',
  },
  {
    name: 'Codex CLI',
    configPath: path.join(HOME, '.codex', 'config.toml'),
    format: 'toml',
    topLevelKey: 'mcp_servers',
  },
];

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function mcpEntry(apiKey: string, extraFields?: Record<string, string>) {
  return {
    ...extraFields,
    command: 'npx',
    args: ['-y', '@phototology/mcp'],
    env: { PHOTOTOLOGY_API_KEY: apiKey },
  };
}

function writeJsonConfig(editor: EditorConfig, apiKey: string): void {
  let config: Record<string, any> = {};
  try {
    config = JSON.parse(fs.readFileSync(editor.configPath, 'utf-8'));
  } catch {
    // File doesn't exist or invalid JSON -- start fresh
  }

  if (!config[editor.topLevelKey]) config[editor.topLevelKey] = {};
  config[editor.topLevelKey].phototology = mcpEntry(apiKey, editor.extraFields);

  fs.mkdirSync(path.dirname(editor.configPath), { recursive: true });
  // Audit #5 HIGH (2026-05-19): config file contains PHOTOTOLOGY_API_KEY.
  // Restrict to owner read/write only so a shared box / cloud IDE
  // (Codespaces, Gitpod) doesn't leak the key. Pre-fix permissions
  // defaulted to umask (typically 0o644 — world-readable).
  fs.writeFileSync(editor.configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

function writeTomlConfig(editor: EditorConfig, apiKey: string): void {
  if (!/^pt_(live|test)_[\w-]+$/.test(apiKey)) {
    console.error('  Invalid API key format.');
    process.exit(1);
  }

  const section = `[mcp_servers.phototology]\ncommand = "npx"\nargs = ["-y", "@phototology/mcp"]\n\n[mcp_servers.phototology.env]\nPHOTOTOLOGY_API_KEY = "${apiKey}"\n`;

  let existing = '';
  try {
    existing = fs.readFileSync(editor.configPath, 'utf-8');
  } catch {
    // File doesn't exist -- will create
  }

  // Replace existing phototology section or append
  const sectionRegex = /\[mcp_servers\.phototology\][\s\S]*?(?=\n\[(?!mcp_servers\.phototology)|$)/;
  const updated = sectionRegex.test(existing)
    ? existing.replace(sectionRegex, section)
    : existing + (existing && !existing.endsWith('\n') ? '\n' : '') + '\n' + section;

  fs.mkdirSync(path.dirname(editor.configPath), { recursive: true });
  // Audit #5 HIGH (2026-05-19): TOML config also contains the API key.
  // Same owner-only permission story as the JSON path.
  fs.writeFileSync(editor.configPath, updated, { mode: 0o600 });
}

function writeConfig(editor: EditorConfig, apiKey: string): void {
  if (editor.format === 'toml') {
    writeTomlConfig(editor, apiKey);
  } else {
    writeJsonConfig(editor, apiKey);
  }
}

export async function setupInteractive(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

  console.error('\n  Phototology MCP Server -- Setup\n');
  console.error('  Get your API key at https://api.phototology.com');
  console.error('  (Keys starting with pt_test_ use the free sandbox)\n');

  const apiKey = await ask(rl, '  API Key: ');

  if (!apiKey) {
    rl.close();
    console.error('\n  No key provided. Exiting.\n');
    process.exit(1);
  }

  if (!apiKey.startsWith('pt_live_') && !apiKey.startsWith('pt_test_')) {
    console.error('\n  Warning: key doesn\'t start with pt_live_ or pt_test_ -- proceeding anyway.\n');
  }

  // Validate the key against the API before writing config
  console.error('  Verifying key...');
  const testClient = new PhototologyClient({
    apiKey,
    baseUrl: process.env.PHOTOTOLOGY_BASE_URL,
    userAgent: `@phototology/mcp/${require('../package.json').version} (setup)`,
  });
  try {
    await testClient.modules();
    console.error('  Key verified.\n');
  } catch (err) {
    if (err instanceof AuthenticationError) {
      rl.close();
      console.error('\n  Invalid API key. Check your key at https://api.phototology.com\n');
      process.exit(1);
    }
    // Network errors, timeouts, etc. -- warn but don't block setup
    console.error(`  Warning: could not verify key (${(err as Error).message}) -- writing config anyway.\n`);
  }

  console.error('  Which editor?');
  EDITORS.forEach((e, i) => console.error(`    ${i + 1}. ${e.name}`));
  console.error(`    ${EDITORS.length + 1}. All of the above`);

  const choice = await ask(rl, `\n  Editor [1-${EDITORS.length + 1}]: `);
  rl.close();

  const num = parseInt(choice, 10);
  if (isNaN(num) || num < 1 || num > EDITORS.length + 1) {
    console.error('\n  Invalid choice. Exiting.\n');
    process.exit(1);
  }

  const selected = num === EDITORS.length + 1 ? EDITORS : [EDITORS[num - 1]];

  for (const editor of selected) {
    writeConfig(editor, apiKey);
  }

  console.error('\n  Done! Wrote config to:');
  for (const editor of selected) {
    console.error(`    ${editor.configPath}  (${editor.name})`);
  }
  console.error('\n  Restart your editor to pick up the new MCP server.');
  console.error('  Your agent now has seven tools: analyze_photo, analyze_batch, list_lenses, lookup_photo, get_credits, purchase_credits, and enrich_photo.\n');
  console.error('  Docs: https://api.phototology.com/v1/docs\n');
}
