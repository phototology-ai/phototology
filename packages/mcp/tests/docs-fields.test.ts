/**
 * The docs an agent or maintainer reads must quote the result shapes the
 * tools actually return. These field names belong to shapes retired by the
 * typed-results work (analyze_batch's old totals and error rows, lookup_photo's
 * results map, enrich_photo's top-level cost); CHANGELOG.md is exempt because
 * it names them on purpose.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..');

const RETIRED: Array<[string, RegExp]> = [
  ['totalCacheHits', /totalCacheHits/],
  ['totalCreditsCharged', /totalCreditsCharged/],
  ['estimatedCreditsSaved', /estimatedCreditsSaved/],
  ['results[sha256].photo.lenses', /results\[sha256\]/],
  ["source: 'error'", /source: 'error'/],
  ['{ savedTo, formatsWritten, lensVersions, creditsCharged }', /savedTo, formatsWritten, lensVersions, creditsCharged/],
];

function docFiles(): string[] {
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).map((d) => path.join('skills', d, 'SKILL.md'));
  const tools = fs.readdirSync(path.join(ROOT, 'src', 'tools')).map((f) => path.join('src', 'tools', f));
  return ['CLAUDE.md', 'README.md', 'src/index.ts', ...skills, ...tools].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

describe('docs quote the shipped result shapes', () => {
  it('covers every skill, CLAUDE.md, README.md and the tool descriptions', () => {
    const files = docFiles();
    // CLAUDE.md is private (never synced to the public repo), so it is only
    // required where it exists.
    const expected = fs.existsSync(path.join(ROOT, 'CLAUDE.md')) ? ['CLAUDE.md'] : [];
    expect(files).toEqual(expect.arrayContaining([...expected, 'README.md', 'skills/batch-analyze/SKILL.md', 'skills/lookup-first/SKILL.md', 'src/tools/enrich-photo.ts']));
  });

  it.each(RETIRED)('no doc names the retired field %s', (_name, pattern) => {
    const hits = docFiles().filter((f) => pattern.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
