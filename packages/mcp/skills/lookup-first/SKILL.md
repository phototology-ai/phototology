---
name: phototology:lookup-first
description: Use BEFORE calling phototology analyze_photo on any image URL or sha256. Checks the registry first and re-uses cached lens results when they exist, only spending credits on lenses that are genuinely missing.
---

# Phototology: Look Up First

## When to use
Every time the user has an image URL or sha256 AND a question about that image. Run this skill first; it can completely avoid the credit spend if the photo has been analyzed before (by anyone on the same account).

## Steps

1. **Decide which lens(es) answer the user's question.**
   - "When was this taken?" → `dating`
   - "Who / how many people?" → `people`
   - "What car is this and what's the condition?" → `automobile`, `vehicle-condition`
   - "Describe this image" → `describe` (cheap) or `atmosphere` (more poetic)
   - If unclear, call `list_lenses` and map the user's question to lens output fields.

2. **Call `lookup_photo`** with `imageUrl` (or `sha256` if known).
   - Free. Inspect `results[sha256].photo.lenses`.

3. **Check coverage.** Compare the lenses you need (step 1) against the lenses already cached (step 2).
   - **All needed lenses cached** → use the cached output. Tell the user this came from the registry: zero credits spent.
   - **Some missing** → call `analyze_photo` with `lenses: [...]` containing ONLY the missing lenses.
   - **Lookup returned nothing** → call `analyze_photo` with the lens subset you decided on.

4. **Surface the credit cost** from `usage.creditsCharged` in the analyze response.

## Local-file lookup is free and includes pHash similarity

When checking whether a local photo is already in the registry, call `lookup_photo` with `imagePath`. The MCP runs a transparent cascade:

1. Compute the file's sha256 locally and check for an exact-bytes match (cheap, no image upload required).
2. On miss, send the image bytes so the server can check for perceptually-similar matches via pHash (catches resized / re-encoded variants).

Both calls are free — lookup never costs credits. So the cost of checking is always zero, no matter how the cascade resolves. This is the "always lookup first" pattern made painless for local files.

## Cost reminders
- 1 credit per lens (= $0.01).
- Lookups, `list_lenses`, `get_credits`, `purchase_credits` are all free.
- Bespoke schema extraction = 5 credits per image, plus 1 per stacked lens.
- Cache hits = 0 credits. Always.

## Anti-patterns
- Don't pass `stack: 'full-analysis'` when the user only needs one lens. Read step 1 again.
- Don't pass `refresh: true` unless the user explicitly asks to re-analyze.
- Don't call `analyze_photo` before `lookup_photo` for any URL the user has provided.
