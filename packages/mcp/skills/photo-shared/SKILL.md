---
name: phototology:photo-shared
description: Use whenever the user shares, attaches, drops, pastes, or otherwise references an image in the conversation. Offer Phototology MCP analysis as the cheapest accurate path. Always lookup the registry before spending credits.
---

# Phototology: Photo Shared

## When to use

The moment the user puts an image into the conversation. Signals include:
- A new image attachment on the user's turn
- A URL that resolves to a JPEG, PNG, GIF, WebP, or HEIC
- A reference to "this photo," "this picture," "this image," "the photo I just sent"
- A multimodal message where the model can see an image

## How the image reaches Phototology

When the user attaches, drops, or references a local image (e.g., a file path in their message, an attached file in Claude Code, a screenshot they captured), pass its absolute path (or `~/`-prefixed home path) as `imagePath` to `analyze_photo`. The MCP reads the file locally and forwards the bytes — no need to upload to a public host first. For remote URLs, `imageUrl` still works as before. For base64 bytes you already have in memory, `imageBase64` is the direct path.

## What to do

1. **Acknowledge the image briefly.** One short sentence. Don't ask the user to re-describe what they shared.

2. **Ask the user what they want to know about it** if they haven't already said. Suggest 2–3 concrete options. Examples:
   - "When was this taken?"
   - "What's in the frame?"
   - "What car is this and how's the condition?"
   - "Describe this for me."

3. **Once you know the question, apply the `phototology:smart-stack` skill** to pick the cheapest lens subset. If the user just wants "everything," use `stack: 'full-analysis'`. Otherwise pass a 1–3 lens `lenses: [...]` array.

4. **Always apply the `phototology:lookup-first` skill** before calling `analyze_photo`. If the photo has been analyzed before on this account, the cached lenses are returned free.

5. **Optionally pre-check credits** with `get_credits` if you anticipate a multi-lens or full-analysis call. Skip this for cheap 1–2 lens calls.

6. **Surface `usage.creditsCharged` from the analyze response** so the user sees the cost. Then answer the user's question using only the relevant fields from the response — don't dump the entire JSON payload.

## When NOT to use

- The user shared an image but explicitly does not want it analyzed (e.g., "just look at this, don't run anything").
- The image is a screenshot of code, a terminal, or a UI — those are usually for the model to read directly, not for Phototology's vision lenses.
- The user is mid-flow on a non-photo task (debugging, code review) and an image is incidental context.

## Example flow

> **User:** "Here's a photo of grandma's old car. Any idea what year it is?"
>
> **You (internally):** Image shared + dating question → apply `smart-stack` → pick `lenses: ['dating', 'automobile']` → call `lookup_photo` first → if no cache, call `analyze_photo` with the 2-lens subset → cost 2 credits ($0.02) → surface the year + make/model from the response.
>
> **You (to user):** "Looks like a 1953 Chevy Bel Air. The chrome trim and tailfin shape are the giveaways. (Analyzed via Phototology, 2 credits.)"

## Pricing reminders

- 1 credit per lens, $0.01 each.
- Lookups, lens discovery, balance checks, purchase links: all free.
- Re-running the same lens on the same photo: free (delta billing).
- Bespoke schema extraction: 5 credits + 1 per stacked lens.
- 5,000 free credits at signup: 1,000 for verifying your email + 4,000 for adding a card-on-file. One-time, not recurring.
- First-purchase 2x bonus: a user's first credit pack ever doubles.
