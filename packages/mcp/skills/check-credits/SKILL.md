---
name: phototology:check-credits
description: Use when the user asks about their Phototology credit balance, when you are about to run a large batch of analyze calls, or when you want to warn the user before an expensive spend.
---

# Phototology: Check Credits

## When to use
- The user asks "how many credits do I have left?" or any balance question.
- Before any batch of more than ~5 `analyze_photo` calls.
- Before a `bespoke` analyze call (5 credits).
- Before the `full-analysis` stack (runs every lens; call `list_lenses` for its per-photo price).

## Steps

1. Call `get_credits`. Free, instant.
2. Report the balance plainly. The result always carries `total` (the spendable balance) and `usd` (its dollar value); `reserved` (credits held for calls in progress) may be absent, which means 0. Example:
   > You have **1,000 credits** ($10.00). 2 are held for a call in progress, so 998 are free to spend.
3. If `total - reserved < estimated cost of the next operation`:
   - Tell the user how many credits the operation will need.
   - Offer three options: **(a)** proceed anyway (will hit the out-of-credits error), **(b)** reduce scope to fewer lenses, or **(c)** buy more credits.
   - If they pick (c), call `purchase_credits` and surface the URL.

## Estimating cost
- `analyze_photo` with N `lenses` = N credits (1 per billable lens).
- `analyze_photo` with `stack: 'full-analysis'` = one credit per billable lens in the stack. Call `list_lenses` to count the current catalog; the response's `stacks[]` entries list the lens names per stack so you can size the spend exactly. Moderation is always free and runs implicitly, so the billable count is "all lenses minus moderation."
- `analyze_photo` with bespoke extraction = 5 credits + 1 per additional stacked lens.
- `analyze_photo` re-running cached lenses on the same photo = 0 credits (delta billing).
- `analyze_batch` with N photos = sum of per-photo costs, minus cache hits (which are free).
- `lookup_photo`, `list_lenses`, `get_credits`, `purchase_credits` = 0 credits.

## Pricing facts you can quote
- 1 credit = $0.01.
- New users start with 1,000 free credits, granted when they verify their email. Signup credits do NOT renew monthly.
- Cache hits cost zero credits and the registry keeps re-runs free across sessions.
- Packs (all at $0.01/credit, no volume discount):
  - Starter: 1,000 credits, $10
  - Pro: 10,000 credits, $100
  - Business: 100,000 credits, $1,000
- First purchase doubles: a user buying their first pack ever gets 2x credits (Starter $10 buys 2,000 credits the first time).
- No subscriptions. Pay-as-you-go via packs only.
