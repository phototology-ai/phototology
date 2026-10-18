import { AuthenticationError } from '@phototology/sdk';

const mockModules = jest.fn();

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation(() => ({
      modules: mockModules,
    })),
  };
});

const mockReadFileSync = jest.fn().mockReturnValue('{}');
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockRenameSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockRealpathSync = jest.fn((p: string) => p);

jest.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  renameSync: mockRenameSync,
  unlinkSync: mockUnlinkSync,
  realpathSync: mockRealpathSync,
}));

jest.mock('readline', () => ({
  createInterface: jest.fn().mockReturnValue({
    question: jest.fn(),
    close: jest.fn(),
  }),
}));

import * as readline from 'readline';
import { setupInteractive } from '../src/setup';

// Prevent process.exit from killing the test runner
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
const mockStderr = jest.spyOn(console, 'error').mockImplementation(() => {});

function simulateAnswers(answers: string[]) {
  const rl = (readline.createInterface as jest.Mock).mock.results[0]?.value
    ?? { question: jest.fn(), close: jest.fn() };

  (readline.createInterface as jest.Mock).mockReturnValue(rl);

  let callIndex = 0;
  rl.question.mockImplementation((_prompt: string, cb: (answer: string) => void) => {
    cb(answers[callIndex++] || '');
  });
}

/** The file a write lands in: a temp file renamed into place counts as its target. */
function getWrittenConfig(callIndex = 0): { path: string; content: any } {
  const call = mockWriteFileSync.mock.calls[callIndex];
  const renamed = mockRenameSync.mock.calls.find((c) => c[0] === call[0]);
  return {
    path: renamed ? renamed[1] : call[0],
    content: call[1].endsWith('\n')
      ? JSON.parse(call[1])
      : call[1], // TOML stays as string
  };
}

describe('setupInteractive key verification', () => {
  beforeEach(() => {
    mockExit.mockClear();
    mockStderr.mockClear();
    mockModules.mockReset();
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockClear();
    mockMkdirSync.mockClear();
    (readline.createInterface as jest.Mock).mockReturnValue({
      question: jest.fn(),
      close: jest.fn(),
    });
  });

  it('exits with error on AuthenticationError', async () => {
    mockModules.mockRejectedValue(
      new AuthenticationError('Invalid API key', {
        code: 'AUTH_FAILED',
        status: 401,
        retryable: false,
        requestId: 'req_test',
      }),
    );
    simulateAnswers(['pt_test_badkey', '1']);

    await setupInteractive();

    expect(mockExit).toHaveBeenCalledWith(1);
    const stderrOutput = mockStderr.mock.calls.map((c) => c[0]).join('\n');
    expect(stderrOutput).toContain('Invalid API key');
  });

  it('warns but continues on network error', async () => {
    mockModules.mockRejectedValue(new Error('fetch failed'));
    simulateAnswers(['pt_test_goodkey', '1']);

    await setupInteractive();

    const stderrOutput = mockStderr.mock.calls.map((c) => c[0]).join('\n');
    expect(stderrOutput).toContain('could not verify key');
    expect(stderrOutput).toContain('Done!');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('proceeds to editor selection on valid key', async () => {
    mockModules.mockResolvedValue({ modules: [], presets: [] });
    simulateAnswers(['pt_test_goodkey', '1']);

    await setupInteractive();

    const stderrOutput = mockStderr.mock.calls.map((c) => c[0]).join('\n');
    expect(stderrOutput).toContain('Key verified');
    expect(stderrOutput).toContain('Done!');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

describe('setupInteractive config output per editor', () => {
  const API_KEY = 'pt_test_configcheck';

  beforeEach(() => {
    mockExit.mockClear();
    mockStderr.mockClear();
    mockModules.mockReset().mockResolvedValue({ modules: [], presets: [] });
    mockReadFileSync.mockReturnValue('{}');
    mockWriteFileSync.mockClear();
    mockMkdirSync.mockClear();
    (readline.createInterface as jest.Mock).mockReturnValue({
      question: jest.fn(),
      close: jest.fn(),
    });
  });

  // Choice 1 = Claude Code
  it('writes Claude Code config with mcpServers top-level key', async () => {
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    const { path, content } = getWrittenConfig();
    // Claude Code reads user-scope MCP servers from ~/.claude.json, not ~/.claude/settings.json.
    expect(path.endsWith('.claude.json')).toBe(true);
    expect(content.mcpServers.phototology).toEqual({
      command: 'npx',
      args: ['-y', '@phototology/mcp'],
      env: { PHOTOTOLOGY_API_KEY: API_KEY },
    });
  });

  it('writes ~/.claude.json through a temp file in the same folder, renamed into place', async () => {
    mockRenameSync.mockClear();
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    const tmp = mockWriteFileSync.mock.calls[0][0] as string;
    expect(tmp).not.toBe(getWrittenConfig().path);
    expect(require('path').dirname(tmp)).toBe(require('path').dirname(getWrittenConfig().path));
    expect(mockRenameSync).toHaveBeenCalledWith(tmp, expect.stringMatching(/\.claude\.json$/));
    expect(mockWriteFileSync.mock.calls[0][2]).toEqual(expect.objectContaining({ mode: 0o600 }));
  });

  it('a rename that fails removes the temp file and leaves the target alone', async () => {
    mockRenameSync.mockReset().mockImplementationOnce(() => { throw new Error('EXDEV: cross-device link'); });
    mockUnlinkSync.mockClear();
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    const tmp = mockWriteFileSync.mock.calls[0][0] as string;
    expect(tmp).toMatch(/\.tmp$/);
    expect(mockUnlinkSync).toHaveBeenCalledWith(tmp);
    const printed = mockStderr.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/could not write/i);
    expect(printed).not.toMatch(/Done! Wrote config/);
    mockRenameSync.mockReset();
  });

  it('names claude mcp add and .mcp.json when it writes the Claude Code config', async () => {
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    const printed = mockStderr.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('claude mcp add phototology');
    expect(printed).toContain('.mcp.json');
  });

  it('keeps the other keys of an existing ~/.claude.json', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    const { content } = getWrittenConfig();
    expect(content.numStartups).toBe(3);
    expect(content.mcpServers.other).toEqual({ command: 'x' });
    expect(content.mcpServers.phototology.command).toBe('npx');
  });

  it('never overwrites a config file it cannot parse, and prints what to add instead', async () => {
    mockReadFileSync.mockReturnValue('{ not json');
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    const printed = mockStderr.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toMatch(/could not parse/i);
    expect(printed).toContain('claude mcp add phototology');
  });

  // Choice 2 = Cursor
  it('writes Cursor config with mcpServers top-level key', async () => {
    simulateAnswers([API_KEY, '2']);
    await setupInteractive();

    const { path, content } = getWrittenConfig();
    expect(path).toContain('.cursor');
    expect(path).toContain('mcp.json');
    expect(content.mcpServers.phototology).toEqual({
      command: 'npx',
      args: ['-y', '@phototology/mcp'],
      env: { PHOTOTOLOGY_API_KEY: API_KEY },
    });
  });

  // Choice 3 = VS Code Copilot
  it('writes VS Code Copilot config with servers key and type: stdio', async () => {
    simulateAnswers([API_KEY, '3']);
    await setupInteractive();

    const { path, content } = getWrittenConfig();
    expect(path).toContain('.vscode');
    expect(path).toContain('mcp.json');
    expect(content.servers.phototology).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@phototology/mcp'],
      env: { PHOTOTOLOGY_API_KEY: API_KEY },
    });
  });

  // Choice 4 = Gemini CLI
  it('writes Gemini CLI config with mcpServers top-level key', async () => {
    simulateAnswers([API_KEY, '4']);
    await setupInteractive();

    const { path, content } = getWrittenConfig();
    expect(path).toContain('.gemini');
    expect(path).toContain('settings.json');
    expect(content.mcpServers.phototology).toEqual({
      command: 'npx',
      args: ['-y', '@phototology/mcp'],
      env: { PHOTOTOLOGY_API_KEY: API_KEY },
    });
  });

  // Choice 5 = Windsurf
  it('writes Windsurf config with mcpServers top-level key', async () => {
    simulateAnswers([API_KEY, '5']);
    await setupInteractive();

    const { path, content } = getWrittenConfig();
    expect(path).toContain('.codeium');
    expect(path).toContain('mcp_config.json');
    expect(content.mcpServers.phototology).toEqual({
      command: 'npx',
      args: ['-y', '@phototology/mcp'],
      env: { PHOTOTOLOGY_API_KEY: API_KEY },
    });
  });

  // Choice 6 = Codex CLI (TOML)
  it('writes Codex CLI config as TOML with mcp_servers section', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    simulateAnswers([API_KEY, '6']);
    await setupInteractive();

    const call = mockWriteFileSync.mock.calls[0];
    const path: string = call[0];
    const content: string = call[1];

    expect(path).toContain('.codex');
    expect(path).toContain('config.toml');
    expect(content).toContain('[mcp_servers.phototology]');
    expect(content).toContain('command = "npx"');
    expect(content).toContain('args = ["-y", "@phototology/mcp"]');
    expect(content).toContain(`PHOTOTOLOGY_API_KEY = "${API_KEY}"`);
  });

  // Choice 7 = All editors
  it('writes config for all editors when "all" is selected', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    simulateAnswers([API_KEY, '7']);
    await setupInteractive();

    // 6 editors = 6 writeFileSync calls
    expect(mockWriteFileSync).toHaveBeenCalledTimes(6);

    const paths = mockWriteFileSync.mock.calls.map((c: any[]) => c[0] as string);
    expect(paths.some((p: string) => p.includes('.claude'))).toBe(true);
    expect(paths.some((p: string) => p.includes('.cursor'))).toBe(true);
    expect(paths.some((p: string) => p.includes('.vscode'))).toBe(true);
    expect(paths.some((p: string) => p.includes('.gemini'))).toBe(true);
    expect(paths.some((p: string) => p.includes('.codeium'))).toBe(true);
    expect(paths.some((p: string) => p.includes('.codex'))).toBe(true);
  });

  it('merges into existing config without clobbering other servers', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        'some-other-server': { command: 'other', args: [] },
      },
    }));
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    const { content } = getWrittenConfig();
    expect(content.mcpServers['some-other-server']).toEqual({ command: 'other', args: [] });
    expect(content.mcpServers.phototology.env.PHOTOTOLOGY_API_KEY).toBe(API_KEY);
  });

  // Audit #5 HIGH (2026-05-19): config files contain PHOTOTOLOGY_API_KEY.
  // Must be written with mode 0o600 so shared-machine / cloud-IDE
  // environments don't leak the key to other users on the box.
  it('writes JSON config with owner-only file permissions (mode 0o600)', async () => {
    simulateAnswers([API_KEY, '1']);
    await setupInteractive();

    const call = mockWriteFileSync.mock.calls[0];
    // writeFileSync signature: (path, data, options)
    const options = call[2];
    expect(options).toEqual({ mode: 0o600 });
  });

  it('writes TOML config with owner-only file permissions (mode 0o600)', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    simulateAnswers([API_KEY, '6']);
    await setupInteractive();

    const call = mockWriteFileSync.mock.calls[0];
    const options = call[2];
    expect(options).toEqual({ mode: 0o600 });
  });
});
