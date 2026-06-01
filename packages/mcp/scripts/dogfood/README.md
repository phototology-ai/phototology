# Dogfood: verify the out-of-credits flow in real Claude Code

The MCP returns a structured `open_url` action on `CreditExhaustedError`. Unit tests and an e2e smoke confirm the protocol-level shape is correct. This dogfood proves the **rendering**: does Claude Code actually surface the wallet URL as a button (or at least a clickable link) when the error lands?

You need 5 minutes and one real Claude Code session.

## Steps

### 1. Build the MCP locally

```bash
pnpm --filter @phototology/sdk build
pnpm --filter @phototology/mcp build
```

You should see no errors. `dist/` lands inside both packages.

### 2. Start the mock API

Open a terminal and leave this running:

```bash
node packages/phototology-mcp/scripts/dogfood/mock-out-of-credits.mjs
```

It listens on `http://localhost:3999`. Every `POST /v1/analyze` returns `402 PLAN_LIMIT_EXCEEDED`. Other endpoints return realistic fixtures.

### 3. Point Claude Code at the local MCP + mock

Edit `~/.claude/settings.json` and add (or replace your existing `phototology` entry):

```json
{
  "mcpServers": {
    "phototology-dogfood": {
      "command": "node",
      "args": ["./packages/phototology-mcp/dist/index.js"],
      "env": {
        "PHOTOTOLOGY_API_KEY": "pt_test_dogfood_local",
        "PHOTOTOLOGY_BASE_URL": "http://localhost:3999"
      }
    }
  }
}
```

(Path is relative to wherever you launch Claude Code. If you run Claude Code from the repo root, the path above is correct.)

### 4. Restart Claude Code

So it picks up the new MCP server.

Verify by asking *"What MCP servers do I have?"* — `phototology-dogfood` should appear in the list, exposing 7 tools.

### 5. Trigger the out-of-credits flow

Ask Claude Code:

> Use the phototology MCP to analyze this photo and tell me what it is: https://drvin.ai/showcase-lexus-front.jpg

Watch what happens:

1. Claude calls `lookup_photo` first (per the server instructions / `phototology:lookup-first` skill).
2. Mock returns empty results.
3. Claude calls `analyze_photo` with some `lenses: [...]` selection.
4. Mock returns `402` with the dual-pool credits payload.
5. The MCP catches `CreditExhaustedError`, renders the response with:
   - `isError: true`
   - text content: `"Out of credits. You need 16 credits. Your community credits reset in 12 days. Buy credits at https://phototology.com/wallet"`
   - `structuredContent.actions: [{ type: "open_url", label: "Buy credits in your Phototology wallet", url: "https://phototology.com/wallet" }]`

**What you're looking for:**

| Outcome | What it means |
|---|---|
| Claude surfaces the URL as a clickable link or button | structuredContent.actions is rendered — perfect |
| Claude pastes the URL inline as plain text and tells the user to open it | Text fallback rendered — acceptable; the structured payload was ignored by the client |
| Claude swallows the error or retries the call | Bad — surface this back to the issue tracker. The server instructions explicitly say "do not retry." |
| Claude says something like "you're out of credits" without showing the URL | Bad — instructions to "surface the URL verbatim" were ignored. Worth investigating. |

Also try:

> Check my phototology credits.

Should call `get_credits`. Mock returns `community.balance: 1, purchased.balance: 0, resetsInDays: 12`. Verify Claude reports the balance clearly.

> How do I buy more credits?

Should call `purchase_credits`. Verify Claude surfaces the wallet URL with `utm_source=mcp`.

### 6. Tear down

Stop the mock (`Ctrl-C` in its terminal). Restore your normal MCP config in `~/.claude/settings.json` (point back at `npx @phototology/mcp` once 1.1.0 is on npm, or your live key).

## Reporting results

If you see anything wrong, write up:

1. What you asked Claude
2. What the tool call looked like (Claude Code's tool-call panel shows the raw request)
3. What you got back (especially: was the `structuredContent.actions` field present?)
4. How Claude rendered it visually

Drop that into the `phototology-mcp` issue tracker or share with the team. The fix may be:
- A wording tweak in `buildServerInstructions()` (this codebase, MCP)
- A wording tweak in the `phototology:lookup-first` skill
- A bug in Claude Code's rendering (file with Anthropic)
- A bug in the MCP's `renderToolError` (this codebase)
