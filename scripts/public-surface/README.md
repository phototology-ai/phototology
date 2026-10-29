# public-surface

The leak guard for the public Phototology packages.

- `check.mjs`: the guard. `node scripts/public-surface/check.mjs <tree>` checks
  a directory in the public repo's layout and exits 1 on any finding. Also
  `--tarball <x.tgz>` for packed npm tarballs and `--message-file <f>` for
  commit messages.
- `lib.mjs`: allowlist parsing and glob matching, shared with the exporter.
- `public-surface.allowlist` (repo root): which files may be public.
- `public-fixtures.allow` (repo root): exact synthetic or public values the
  guard accepts, each with its provenance.
- `.gitleaks.toml` (repo root): secret scanning rules.

No dependencies; Node 20+. gitleaks is required when `CI` is set.
