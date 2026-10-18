/**
 * Agent- and person-facing text fixed after the 2026-10-18 production smoke:
 * the server instructions (I1, I2, I5), the setup help and README (I3, I4).
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildServerInstructions } from '../src/server';
import { SETUP_GUIDE } from '../src/help';

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8');
const SETUP_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'setup.ts'), 'utf-8');
const instructions = buildServerInstructions();

describe('server instructions', () => {
  it('I1: the key section carries the RATE_LIMITED code and the sandbox limit sentence', () => {
    const keySection = instructions.slice(instructions.indexOf('## Test vs live keys'));
    expect(keySection).toContain('RATE_LIMITED');
    expect(keySection).toContain('The sandbox key allows 2 requests a minute and 10 a day per IP; sign up for an account key at https://phototology.com/signup to lift this.');
  });

  it('I2: "lookup_photo first" applies to account keys, and the sandbox limits are named', () => {
    const lookupLine = instructions.split('\n').find((l) => l.startsWith('- `lookup_photo`'))!;
    expect(lookupLine).toMatch(/account key/);
    const cheapFirst = instructions.split('\n').find((l) => l.startsWith('1. Always `lookup_photo` first'))!;
    expect(cheapFirst).toMatch(/account key/);
    expect(instructions).toContain('Sandbox keys cannot read the registry or a balance');
    expect(instructions).toContain('SANDBOX_KEY');
  });

  it('I5: vehicle-condition is not offered as a selectable lens, and the stack is named instead', () => {
    const available = instructions.split('\n').find((l) => l.startsWith('Currently available:'))!;
    expect(available).not.toContain('vehicle-condition');
    expect(available).toContain('automobile');
    expect(instructions).toMatch(/`vehicle-condition` .*stack/);
  });

  it('describes errors as a JSON first line, never as structuredContent', () => {
    expect(instructions).toContain('one line of JSON');
    expect(instructions).toContain('"code":"OUT_OF_CREDITS"');
    expect(instructions).not.toContain('structuredContent');
    for (const file of ['analyze-photo.ts', 'purchase-credits.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'tools', file), 'utf-8');
      expect(src).not.toContain('structuredContent.actions');
    }
  });

  it('carries no em dash and none of the banned words', () => {
    expect(instructions).not.toContain('\u2014');
    expect(instructions).not.toMatch(/\b(immutable|authentic|authenticated|sealed)\b/i);
  });
});

describe('setup help (--help and the no-key message)', () => {
  it('I3: sends people to the signup page, not the API host', () => {
    expect(SETUP_GUIDE).toContain('https://phototology.com/signup');
    expect(SETUP_GUIDE).not.toMatch(/api\.phototology\.com(?!\/v1\/docs)/);
  });

  it('I4: Claude Code uses claude mcp add, ~/.claude.json or .mcp.json, never settings.json', () => {
    expect(SETUP_GUIDE).toContain('claude mcp add phototology');
    expect(SETUP_GUIDE).toContain('-- npx -y @phototology/mcp');
    expect(SETUP_GUIDE).toContain('~/.claude.json');
    expect(SETUP_GUIDE).toContain('.mcp.json');
    expect(SETUP_GUIDE).not.toContain('.claude/settings.json');
  });

  it('carries no em dash', () => {
    expect(SETUP_GUIDE).not.toContain('\u2014');
  });
});

describe('interactive setup text', () => {
  it('I3: points at the signup page for a key', () => {
    expect(SETUP_SRC).not.toMatch(/at https:\/\/api\.phototology\.com['\\]/);
    expect(SETUP_SRC).toContain('SIGNUP_URL');
  });
});

describe('README', () => {
  it('I3: no "real key at https://api.phototology.com"; a key comes from the signup page', () => {
    expect(README).not.toMatch(/key at https:\/\/api\.phototology\.com/i);
    expect(README).toContain('https://phototology.com/signup');
  });

  it('I4: the Claude Code section names claude mcp add, ~/.claude.json and .mcp.json, not settings.json', () => {
    const start = README.indexOf('### Claude Code');
    const section = README.slice(start, README.indexOf('### Claude Desktop'));
    expect(section).toContain('claude mcp add phototology');
    expect(section).toContain('~/.claude.json');
    expect(section).toContain('.mcp.json');
    expect(section).not.toContain('settings.json');
    // The only settings.json mention left is the image-hint hook, which does live there.
    const mentions = README.split('\n').filter((l) => l.includes('.claude/settings.json'));
    expect(mentions.every((l) => /hook/i.test(l))).toBe(true);
  });

  it('keeps the Claude Desktop path as it was', () => {
    expect(README).toContain('~/Library/Application Support/Claude/claude_desktop_config.json');
  });
});
