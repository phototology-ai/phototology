# Security policy for @phototology/mcp

This file says what the Phototology MCP server reads, what it sends, what it never sends, and what is not a security boundary. It also says how to report a vulnerability.

## What the server reads

- **Files you name.** The server reads a local file only when a tool call names it by absolute path (or a `~/` path) in `imagePath` or `imagePaths`. Relative paths are refused. Globs in `imagePaths` are expanded on your machine.
- **Only inside the allowed folders, when you set them.** Set `PHOTOTOLOGY_MCP_ALLOWED_DIRS` to a list of folders, separated by `:` (`;` on Windows). The server then refuses any path outside those folders. Paths are checked after symlinks are resolved, so a link inside an allowed folder that points elsewhere is refused with `PATH_OUTSIDE_ALLOWED_DIRS`. A glob in `analyze_batch` whose fixed folder part is outside those folders is refused whole, naming only the pattern, and a match that leads outside is skipped, so a pattern never lists files outside the folders. While the variable is set, any path or pattern containing `..` is refused too. When the variable is unset, any local path the server process can open is allowed.
- **Writes only where you ask.** `enrich_photo` writes a file only when you pass `outputPath`. It refuses an existing file unless you pass `overwrite: true`, it never writes over the input file, and the allowed folders apply to the output path too.
- **Its own environment.** The server reads `PHOTOTOLOGY_API_KEY` and the optional variables listed in the README.

## What the server sends

Everything goes to one host, `api.phototology.com` (or `PHOTOTOLOGY_BASE_URL` if you override it), over HTTPS by default, with your API key as the bearer token.

- **The image you pass.** For a local file or `imageBase64`, the image bytes. For `imageUrl`, the URL. For `lookup_photo` with `sha256` or `pHash`, the hash.
- **The tool's parameters** that the API needs, such as the lenses or stack you chose.
- **The telemetry payload documented in the README** (section "Anonymous telemetry"): the editor's stated name and version, the package version, and for each tool call the tool name, whether it succeeded, how long it took, an error code on failure, and counts such as credits charged and cache hits. Set `DO_NOT_TRACK=1` or `PHOTOTOLOGY_MCP_NO_TELEMETRY=1` to turn telemetry off.

## What the server never sends

- File paths, including the folder names in `PHOTOTOLOGY_MCP_ALLOWED_DIRS`.
- Tool inputs or outputs in telemetry. Telemetry carries counts, booleans and error codes only.
- Conversation text. The server never sees your conversation; it sees only the tool calls your editor makes.

## What is not a security boundary

- **Tool annotations.** Hints such as `readOnlyHint` and `destructiveHint` tell your editor how a tool behaves. They do not stop anything. Your editor decides what to do with them.
- **This server.** It runs with your user's permissions on your machine. It is not a sandbox. Use `PHOTOTOLOGY_MCP_ALLOWED_DIRS` to narrow what it can read and write.
- **Keep host confirmations on.** Leave your editor's "ask before running a tool" setting enabled, so you see each call, and especially each `enrich_photo` write, before it runs.

## Reporting a vulnerability

Email **security@phototology.com**. Please include the package version, your editor, and steps to reproduce. Do not open a public GitHub issue for a vulnerability. We will acknowledge your report and keep you updated while we fix it.
