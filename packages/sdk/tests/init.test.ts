import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('init CLI', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phototology-init-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .env and analyze-example.ts files', async () => {
    const { scaffold } = await import('../src/init');
    await scaffold(tmpDir, 'pt_test_abc123');

    expect(fs.existsSync(path.join(tmpDir, '.env'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'analyze-example.ts'))).toBe(true);
  });

  it('.env contains the API key', async () => {
    const { scaffold } = await import('../src/init');
    await scaffold(tmpDir, 'pt_test_abc123');

    const envContent = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8');
    expect(envContent).toContain('PHOTOTOLOGY_API_KEY=pt_test_abc123');
  });

  it('example script imports from @phototology/sdk', async () => {
    const { scaffold } = await import('../src/init');
    await scaffold(tmpDir, 'pt_test_abc123');

    const exampleContent = fs.readFileSync(path.join(tmpDir, 'analyze-example.ts'), 'utf-8');
    expect(exampleContent).toContain("from '@phototology/sdk'");
    expect(exampleContent).toContain('PhototologyClient');
  });

  it('example script notes test mode for pt_test_ keys', async () => {
    const { scaffold } = await import('../src/init');
    await scaffold(tmpDir, 'pt_test_abc123');

    const exampleContent = fs.readFileSync(path.join(tmpDir, 'analyze-example.ts'), 'utf-8');
    expect(exampleContent).toContain('test mode');
  });

  it('does not include test mode note for pt_live_ keys', async () => {
    const { scaffold } = await import('../src/init');
    await scaffold(tmpDir, 'pt_live_abc123');

    const exampleContent = fs.readFileSync(path.join(tmpDir, 'analyze-example.ts'), 'utf-8');
    expect(exampleContent).not.toContain('test mode');
  });

  // Audit #5 HIGH (2026-05-19): scaffolder writes the API key to disk.
  // On shared dev machines + cloud IDEs (Codespaces, Gitpod) world-readable
  // permissions yield account compromise. Lock the .env to owner-read/write.
  it('.env is created with owner-only permissions (mode 0600)', async () => {
    const { scaffold } = await import('../src/init');
    await scaffold(tmpDir, 'pt_live_abc123');

    const stat = fs.statSync(path.join(tmpDir, '.env'));
    // Mask off file-type bits; compare the permission bits (mode & 0o777).
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // Task 2 P0-2 (2026-05-19): the prior Wikimedia thumbnail URL returned 400
  // to the safe-fetch UA (Wikimedia's thumb endpoint rejects non-browser
  // UAs). Every cold `npx @phototology/sdk` user got a broken first
  // analyze. The example must use a host that responds 200 to a generic UA.
  it('example script does not use a Wikimedia URL', async () => {
    const { scaffold } = await import('../src/init');
    await scaffold(tmpDir, 'pt_live_abc123');

    const exampleContent = fs.readFileSync(path.join(tmpDir, 'analyze-example.ts'), 'utf-8');
    expect(exampleContent).not.toMatch(/wikimedia\.org/);
    expect(exampleContent).not.toMatch(/wikipedia\.org/);
    // Sanity: still contains SOME image URL for the example to be useful.
    expect(exampleContent).toMatch(/imageUrl:\s*'https?:\/\//);
  });
});
