/**
 * The setup help printed by `--help` and when PHOTOTOLOGY_API_KEY is missing.
 */
export const SETUP_GUIDE = `
  Phototology MCP Server -- AI Vision for Coding Assistants

  1. Sign up for an account key at https://phototology.com/signup
     (Keys starting with pt_test_ use the free sandbox: fixture data,
     2 requests a minute and 10 a day per IP)

  2. Run interactive setup:

     npx @phototology/mcp

  3. Or add manually to your editor config:

  Claude Code  (run once in a terminal):

    claude mcp add phototology --scope user -e PHOTOTOLOGY_API_KEY=pt_live_... -- npx -y @phototology/mcp

    This writes the server into ~/.claude.json (user scope). For one project,
    use --scope project, which writes .mcp.json at the project root. Both
    files take this shape:

    { "mcpServers": { "phototology": {
        "command": "npx", "args": ["-y", "@phototology/mcp"],
        "env": { "PHOTOTOLOGY_API_KEY": "pt_live_..." }
    }}}

  Cursor  (.cursor/mcp.json):          same JSON shape as above
  Gemini CLI  (~/.gemini/settings.json):  same JSON shape as above
  Windsurf  (~/.codeium/windsurf/mcp_config.json):  same JSON shape as above

  VS Code Copilot  (.vscode/mcp.json):

    { "servers": { "phototology": {
        "type": "stdio", "command": "npx", "args": ["-y", "@phototology/mcp"],
        "env": { "PHOTOTOLOGY_API_KEY": "pt_live_..." }
    }}}

  Codex CLI  (~/.codex/config.toml):

    [mcp_servers.phototology]
    command = "npx"
    args = ["-y", "@phototology/mcp"]

    [mcp_servers.phototology.env]
    PHOTOTOLOGY_API_KEY = "pt_live_..."

  Docs: https://api.phototology.com/v1/docs
`;
