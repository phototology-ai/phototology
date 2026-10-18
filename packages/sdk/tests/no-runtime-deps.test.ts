import pkg from '../package.json';

describe('package.json', () => {
  it('has zero runtime dependencies', () => {
    const p = pkg as Record<string, unknown>;
    expect(p.dependencies ?? {}).toEqual({});
    expect(p.peerDependencies ?? {}).toEqual({});
    expect(p.optionalDependencies ?? {}).toEqual({});
  });
});
