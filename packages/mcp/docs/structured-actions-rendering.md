# How the `structuredContent.actions` payload renders today

> **TL;DR:** the **text fallback** is the load-bearing thing today. The structured `actions` payload is harmless future-proofing for clients that haven't implemented it yet (and may never).

## What the MCP returns on `CreditExhaustedError`

The actual JSON-RPC response body emitted by `@phototology/mcp` when the SDK throws a `CreditExhaustedError`:

```jsonc
{
  "content": [
    {
      "type": "text",
      "text": "Out of credits. You need 5 credits. Your community credits reset in 12 days. Buy credits at https://phototology.com/wallet — first purchase doubles, so Starter $10 buys 2,000 credits the first time."
    }
  ],
  "structuredContent": {
    "actions": [
      {
        "type": "open_url",
        "label": "Buy credits in your Phototology wallet (first purchase doubles)",
        "url": "https://phototology.com/wallet"
      }
    ]
  },
  "isError": true
}
```

The two payloads carry the same information. The text fallback is human-readable. The `structuredContent` is machine-typed.

## What Claude Code shows today (most likely)

```
┌──────────────────────────────────────────────────────────────────┐
│  ✗ phototology • analyze_photo                                   │
│                                                                  │
│  Out of credits. You need 5 credits. Your community credits      │
│  reset in 12 days. Buy credits at                                │
│  https://phototology.com/wallet — first purchase       │
│  doubles, so Starter $10 buys 2,000 credits the first time.      │
│                                  ↑ auto-linked URL (clickable)   │
│                                                                  │
│  ▶ Structured data  (collapsed, opaque JSON viewer)              │
└──────────────────────────────────────────────────────────────────┘
```

The URL in the text becomes a clickable link in most clients. The `structuredContent` panel can be expanded to reveal raw JSON, but no client (today, as of MCP spec 2025-11-25) standardizes the `actions[].type === 'open_url'` shape as a rendering hint.

## What we'd see if a client implemented an `actions` convention

```
┌──────────────────────────────────────────────────────────────────┐
│  ✗ phototology • analyze_photo                                   │
│                                                                  │
│  Out of credits. You need 5 credits.                             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ 🔗 Buy credits in your wallet (first purchase doubles)   │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                  ↑ proper button, hover/focus    │
└──────────────────────────────────────────────────────────────────┘
```

## Spec context

MCP 2025-11-25 defines tool results as:

- `content: Array<{ type: "text" | "image" | "audio" | "resource_link" | "resource", … }>` — standardized. Every client renders the text type.
- `structuredContent?: Record<string, unknown>` — free-form JSON object, optionally constrained by the tool's `outputSchema`. The spec does NOT define an `actions` array or `open_url` discriminator. We invented the convention.
- `isError?: boolean` — standardized.

So when a client receives our `structuredContent.actions[]`:
- A **conformant** client treats it as opaque structured data: usually a collapsible JSON viewer.
- An **action-aware** client (none known today) could render the `open_url` actions as buttons. We're future-proofing for that possibility.

## Why this is fine

1. **No regression.** The text fallback works in every client. Users see the URL and can click or copy-paste.
2. **Forward-compatible.** If Anthropic, Cursor, etc. ever standardize an action-rendering convention, we're already emitting it. They'll either adopt `open_url` (the obvious name) or normalize ours to theirs.
3. **The dogfood session would confirm** exactly what each client does. See [`../scripts/dogfood/README.md`](../scripts/dogfood/README.md).

## What we should NOT do

- Don't remove the text fallback. It's the working path.
- Don't lean on the structured `actions` for any flow the user must complete (e.g., don't make the URL ONLY appear in the structured payload).
- Don't rely on a specific renderer behavior — the same MCP server gets called from Claude Code, Cursor, Windsurf, Claude Desktop, and future clients with different rendering surfaces.

## When the convention does land

If/when Anthropic or another major client standardizes a button-rendering hint, the change for `@phototology/mcp` will be cosmetic: rename the field from `actions` to whatever the spec calls, or add the standardized field alongside. The text fallback stays put.
