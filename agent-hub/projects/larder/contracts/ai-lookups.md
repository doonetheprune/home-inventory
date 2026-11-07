---
name: ai-lookups
owner: larder-cloud
consumers: [home-inventory, larder-app]
version: 0.1
status: draft
---

# Contract: ai-lookups

Larder Cloud reads photos for Larder (Add by photo, receipts) using its own AI keys, within a monthly allowance.

## Agreed so far

- **In Larder:** Larder Cloud appears as a reader in Settings → AI, before the household's own Claude or Gemini keys. When it can't read (the allowance is used up, or it's offline), the next reader takes over, as the AI module already does.
- **Who calls it:** Larder at home. A phone can call it directly when home is offline.
- **Request:** the photo or photos, and what's wanted (a product or a receipt).
- **Answer:** in the same format the AI module's readers use today, plus the allowance: how many used, the limit, and when it resets.
- **Counting** (D10):
  - The free plan gets 100 reads a month.
  - Only successful reads count.
  - The month follows the household's time zone.
  - Each read is counted in the same transaction that records it.
- **Web searches** cost more, so they're for paid plans only, or each one counts as a read (D10).
- **Photos aren't kept.**

## To write in M5

- the endpoint
- limits and rate limits
- errors, e.g. "You've used this month's 100. They're back on 1 Dec"
- tests

## Changes

- 0.1 (2026-11-07): first draft.
