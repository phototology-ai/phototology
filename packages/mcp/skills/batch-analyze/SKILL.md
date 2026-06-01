---
name: phototology:batch-analyze
description: Use when the user has 2 or more photos to analyze. Routes through the analyze_batch MCP tool for cache-aware bulk processing. For thousands of photos, loops the tool in slices.
---

# Phototology: Batch Analyze

## When to use

Any job with more than 1 photo. The single-photo `analyze_photo` is for one-offs; for everything else, prefer `analyze_batch`.

Signals that this skill applies:
- "Analyze these 30 photos"
- "I have a folder of vehicle photos"
- "Process my whole listing"
- A list of image URLs / SHA-256 hashes in the prompt
- A directory of images attached

## Local-file batch with globs

When the user has photos on disk, pass `imagePaths` with glob patterns or literal paths:

```
analyze_batch({
  imagePaths: ['~/vacation-2024/*.jpg', '/Users/me/headshot.png'],
  stack: 'full-analysis'
})
```

Globs are expanded internally. Arrays combine freely (`imageUrls`, `imagePaths`, `imagesBase64` can all be in the same call). Total inputs cap at 200 per call — for thousands of photos, loop in slices.

Per-file errors (missing file, oversized, unsupported format) are isolated — one bad file does not fail the whole batch. Each errored file shows as a `source: 'error'` outcome with the path and error code; the remaining files analyze normally.

## Steps

### Small batches (2 to 200 photos)

1. **Pre-flight credit check** with `get_credits` if you anticipate spending more than ~50 credits. For tiny batches (under 10 photos with 1-2 lenses), skip this.

2. **Pick lenses with `phototology:smart-stack`.** Cheaper subsets save 10x on cost. For a "describe these photos" batch with 50 photos at 1 lens = 50 credits ($0.50). At full-analysis = 800 credits ($8). Pick wisely.

3. **Call `analyze_batch`** with the URL list and your chosen `lenses: [...]`. The tool internally:
   - Bulk-looks up every photo (free)
   - Identifies cache hits (those return free)
   - Analyzes only the misses, chunked into 50s

4. **Surface the savings.** The response includes `totalCacheHits`, `totalCreditsCharged`, and `estimatedCreditsSaved`. Tell the user:
   > Analyzed 50 photos. 38 came from the registry (0 credits). 12 were new — analyzed for 12 credits. Saved an estimated 38 credits from the cache.

### Large jobs (200+ photos, into the thousands)

The `analyze_batch` tool is hard-capped at **200 photos per call**. For larger jobs, loop in slices:

```
for slice in chunks(image_urls, 200):
    result = analyze_batch(imageUrls=slice, lenses=["dating"])
    aggregate(result)
```

After each slice, surface progress:
> 600 / 1,500 photos done — 412 cache hits so far, 23 credits spent.

If credits run low mid-job, stop and call `purchase_credits`. Resume from where you left off after the user buys more.

## Cost intuition

| Job | Lenses | Cache hit rate | Cost |
|---|---|---|---|
| 50 photos, all new | `dating` (1) | 0% | 50 credits ($0.50) |
| 50 photos, mixed | `dating, describe` (2) | 60% | 40 credits ($0.40) |
| 200 photos, repeat batch | `dating, automobile` (2) | 95% | 20 credits ($0.20) |
| 1,000 photos, fresh client | `dating, describe, location` (3) | 0% | 3,000 credits ($30) |
| 1,000 photos, registry-warm | `dating, describe, location` (3) | 80% | 600 credits ($6) |

The registry compounds with use. A second-time-through batch is usually 80%+ free.

## Anti-patterns

- Don't loop `analyze_photo` one-at-a-time when you have a list. Use `analyze_batch` so the lookup is bulked.
- Don't pass `refresh: true` on `analyze_batch` unless the user explicitly asks to re-analyze. That bypasses the cache and rebills everything.
- Don't default to `stack: 'full-analysis'` on a big batch. The cost is linear in lens count × photo count. Pick lenses targeted to the user's question via `phototology:smart-stack`.
