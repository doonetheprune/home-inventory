# AI

Add things by photo. Take a photo of the pack and Claude or Gemini reads it: the generic name, brand and size, what it's counted in, its category, roughly how long it keeps, and the shop for a shop's own brand. Larder opens Add item filled in, to check before saving. Nothing is saved from a reading by itself.

- **Choosing the AI:** Settings → AI: **Off**, **Claude** or **Gemini**. Each has its own API key and model, kept when switching between them. Models are listed from the AI's own service (only ones that can read photos), so new ones appear without a Larder update.
- **Default models:** Claude Haiku 5.5 (`claude-haiku-5-5`). For Gemini, the newest plain Flash model in Google's list when first used. The model actually used is saved and shown in Settings.
- **Keys:** pasted in Settings by an admin, or set on the server with `LARDER_MODULE_AI_CLAUDE_API_KEY` / `LARDER_MODULE_AI_GEMINI_API_KEY` (one saved in Settings wins). A saved key is never sent back to the app: Settings shows its last four characters. It's kept in Larder's data folder, so it's in backups.
- **Add by photo** (on Home and in the sidebar, once an AI is set up): the photo is shrunk on the phone to about 1600 pixels as a JPEG, and sent only to the chosen AI. A barcode in the photo is read on the phone (never by the AI); if it's already an item, that item is offered instead (Add 1, Open). If the AI names a shop Larder doesn't have, it asks "Add Tesco?" first (a preset shop comes with what it sells; another shop sells the item's category). On saving, the photo becomes the item's photo, and the brand and barcode its first brand.
- **Couldn't read it:** a blurry or unclear photo says so, with its best guess to use or a retake.
- **Assistants (MCP):** an assistant that can see a photo doesn't need this module: `add_item` takes `brand`, and asks before adding a shop Larder doesn't have (`new_shop: true` once the person says yes).

## Routes

| Route | |
|---|---|
| `GET /api/v1/modules/ai` | Which AI, whether it's ready, and per AI: key set (last four characters), where from, model. Never the key |
| `PUT /api/v1/modules/ai/settings` | Admins. `{ provider?: "claude" \| "gemini" \| null, claude?: { apiKey?, model? }, gemini?: { apiKey?, model? } }`; `null` forgets a key or goes back to the default model |
| `GET /api/v1/modules/ai/models?provider=claude` | Admins. Models that can read photos, and the default. Also shows whether the key works |
| `POST /api/v1/modules/ai/identify` | `{ image: base64 }` (JPEG, PNG, WebP or GIF, checked from its bytes; under about 1.4 MB). Answers name, brand, unit, categoryId, shelfLifeDays, aliases, shop (`id` null if Larder doesn't have it, `preset` if it's a known UK shop), provider and model |

## How it talks to the AIs

- **Claude:** the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`, allowed for this module in `tests/architecture.test.ts`), with structured output (a JSON schema from the module's zod schema) and low effort on models that offer it.
- **Gemini:** Google's REST API (`generateContent` with a response schema), key in the `x-goog-api-key` header, never in the address.
- Both go through `ctx.fetch`, with a 60 second limit. Errors say what to do: a refused key points to Settings → AI, a busy service says to try again.

## Data

`ai:settings` collection, one document: the chosen AI, keys and models.
