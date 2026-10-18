/**
 * Interactive setup on a real filesystem: when ~/.claude.json is a symlink
 * (dotfile managers do this), setup writes through it to the real file and
 * leaves the link in place, instead of replacing the link with a copy.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'phototology-setup-'));
const realDir = path.join(home, 'dotfiles');
const realFile = path.join(realDir, 'claude.json');
const link = path.join(home, '.claude.json');
const originalHome = process.env.HOME;
process.env.HOME = home; // setup.ts reads HOME at import

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation(() => ({
      modules: jest.fn().mockResolvedValue({ modules: [], presets: [] }),
    })),
  };
});

const answers = ['pt_test_symlinkkey', '1'];
jest.mock('readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
    close: () => undefined,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { setupInteractive } = require('../src/setup');

afterAll(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

it('writes through a symlinked ~/.claude.json and keeps the link', async () => {
  fs.mkdirSync(realDir);
  fs.writeFileSync(realFile, JSON.stringify({ numStartups: 7 }));
  fs.symlinkSync(realFile, link);
  const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await setupInteractive();
  } finally {
    stderr.mockRestore();
  }

  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  const written = JSON.parse(fs.readFileSync(realFile, 'utf-8'));
  expect(written.numStartups).toBe(7);
  expect(written.mcpServers.phototology.env.PHOTOTOLOGY_API_KEY).toBe('pt_test_symlinkkey');
  // No temp file left behind in either folder.
  expect(fs.readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  expect(fs.readdirSync(realDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
});
