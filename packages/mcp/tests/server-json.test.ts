/**
 * server.json is what the official MCP Registry reads. Its name must match
 * the `mcpName` in package.json (the registry checks the npm package for it),
 * and its versions must match the package version so a publish never ships
 * a registry entry pointing at a different build.
 */
import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const root = path.join(__dirname, '..');
const serverJson = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('server.json', () => {
  test('server.json name equals package.json mcpName', () => {
    expect(pkg.mcpName).toBe('com.phototology/mcp');
    expect(serverJson.name).toBe(pkg.mcpName);
  });

  test('server.json schema is 2025-12-11 and subfolder is packages/mcp', () => {
    expect(serverJson.$schema).toBe(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    );
    expect(serverJson.repository.subfolder).toBe('packages/mcp');
  });

  test('server.json validates against the 2025-12-11 registry schema', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'server.schema.2025-12-11.json'), 'utf8'),
    );
    expect(schema.$id).toBe(serverJson.$schema);
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const valid = validate(serverJson);
    // Print every schema error on failure, not just "false".
    expect(valid ? [] : validate.errors).toEqual([]);
    expect(valid).toBe(true);
  });

  test('server.json versions equal package.json version', () => {
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages).toHaveLength(1);
    for (const p of serverJson.packages) {
      expect(p.identifier).toBe(pkg.name);
      expect(p.version).toBe(pkg.version);
    }
  });

  test('package.json ships SECURITY.md in the tarball', () => {
    expect(pkg.files).toContain('SECURITY.md');
    expect(fs.existsSync(path.join(root, 'SECURITY.md'))).toBe(true);
  });
});
