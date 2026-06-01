---
name: phototology:smart-stack
description: Use when the user gives you a photo and a specific question. Smart-picks the cheapest accurate subset of lenses (a smart stack) and runs analyze_photo with only those lenses.
---

# Phototology: Smart Stack

## When to use
Whenever the user has an image and a clear, narrow question. Smart-stacking 1 to 3 lenses instead of `stack: 'full-analysis'` saves around 13 credits per call.

## Lens-to-question map (canonical)

| User asks about… | Lens(es) to run |
|---|---|
| Date, era, decade, year | `dating` |
| People count, faces, group dynamics | `people` |
| Where the photo was taken | `location` |
| Mood, feeling, vibes | `atmosphere` |
| Objects, brands, things in frame | `entities` |
| Alt text / accessibility caption | `accessibility` |
| Photo quality / scan defects | `photo-quality` |
| OCR / text in the image | `text-content` |
| Composition, framing, balance | `composition` |
| Safety, NSFW, moderation | `moderation` (always free, always runs) |
| Plain description | `describe` |
| Condition of an item (general) | `condition` |
| Authentic / AI-generated check | `authenticity` |
| Dominant colors | `color-palette` |
| What car is this | `automobile` |
| Damage / wear on a car | `vehicle-condition` |

## Steps

1. Read the user's question. Map to lens(es) using the table above.
2. If you're unsure which lens owns a field, call `list_lenses` (free).
3. Apply the `phototology:lookup-first` skill. Always.
4. Run `analyze_photo` with `lenses: [chosen lenses]`. Do not pass `stack` unless the user explicitly asks for "everything" or "full analysis".
5. Surface ONLY the fields the user asked about. Don't dump the entire JSON payload unless they want it.

## When a stack is the right call
- User says "run everything" → `stack: 'full-analysis'`
- User uploaded a tribute photo → `stack: 'memorial'`
- User uploaded a vehicle for a condition report → `stack: 'vehicle-condition'` or `stack: 'automobile'`
- E-commerce / property listing photos → `stack: 'ecommerce'` or `stack: 'property'`

The other stacks are visible via `list_lenses`.

## Anti-patterns
- Defaulting to `stack: 'full-analysis'`. That's the most expensive path.
- Running `entities` when the user only asked "what kind of car is this?" (use `automobile`).
- Forgetting that re-running a lens on a previously-analyzed photo is free. Re-coverage is cheap.
