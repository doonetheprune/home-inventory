# home-inventory: brief

**Repo:** `doonetheprune/home-inventory` (Larder) · **Project:** larder

## Mission

Larder stays the source of truth for each household. This repo grows the hooks that let Larder:
- sync with Larder Cloud
- run its core on a phone
- set up phones at home
- drive automations on any device

It must not become tied to Firebase: Firebase code lives only in `modules/cloud-link`.

## Read first

- In this repo: `AGENTS.md`, `docs/DECISIONS.md` and `docs/ARCHITECTURE.md`.
- In the hub, `PLAN.md`, especially these sections: Sync; People, phones and keys; Automations.

## Contracts

- **Owns:** `web-transport`, `local-enrolment`, `releases`.
- **Uses:**
  - `cloud-link` and `ai-lookups`, from `larder-cloud`
  - `automations` and `live-view`, from `larder-automations`
  - `pi-system`, from `larder-pi`

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### Now — no dependencies

- [ ] Set SQLite to `synchronous = FULL` in `src/adapters/storage-sqlite/index.ts`, so a power cut can't roll back recent changes (board 1). **Done when:** a test checks the setting, and `docs/DECISIONS.md` says why.
- [ ] Merge two items into one. Stock, history, variants, barcodes, aliases, module fields and purchase history move to the item that's kept (board 2). **Done when:** it works in the API, in the app and as an assistant tool, with tests.
- [ ] Send shopping ticks as they happen instead of all together on Done (board 3), once the owner decides D17.

### M1 — Foundations

- [ ] Routes as data.
  - Core and server routes become one table, in the `ModuleRoute` shape.
  - Fastify registers the table.
  - `core.api.handle()` serves a request without HTTP.

  **Done when:** `docs/openapi.json` is unchanged and every test passes.
- [ ] Numbered changes.
  - The Storage port gains `changesSince(seq, limit)` and `currentSeq()`.
  - Every write gets the next number in the same transaction: SQLite triggers in one migration, and the memory adapter in code.
  - Both are added to the storage contract tests.
- [ ] Apply a request as of a given time, with ids made from a change's id. This uses a per-request clock and id source: the server's Clock through AsyncLocalStorage, and a hook on `newId` in the core. It applies only to requests that carry a change id.
- [ ] Done once: record a change's id in the same transaction as its writes, so after a power cut a change is either finished or not started (board 5).
- [ ] Sort history by when things were made, not when they were saved (board 4).
- [ ] Home-only data.
  - Users, sessions, tokens and the lookup cache never leave home.
  - Modules mark collections that hold secrets as home-only: AI keys, Gmail, and online shopping's hub and providers.

  **Done when:** a test fails if a home-only collection appears in the numbered changes.
- [ ] Phone mode: a `createCore` option in which:
  - `ctx.fetch` answers "needs home"
  - Home Assistant is a stand-in that also answers "needs home"
  - timers only run through a new `ctx.every`; move email, MQTT and shop locations to it
  - modules that only make sense at home are marked, and skipped
- [ ] Run Larder's core in the browser: a chunk that loads only when needed, holding the core, the modules and the memory adapters, and answering the web app's requests from a set of records. Start with spike S2.
- [ ] Offline copies run on the core in the browser. A copy becomes a set of records, and every page and search works in it.
- [ ] Tests:
  - every module's pages answer in phone mode on the example household
  - a parity test runs random requests two ways, through phone mode plus sync and directly, and compares the records
- [ ] Add rules to `AGENTS.md`: routes are data; mark secret collections home-only; timers use `ctx.every`; modules must be safe in phone mode. Add the matching `docs/DECISIONS.md` entries.

### M2 — The Larder Pi box

- [ ] A module hook for connections that stay open (WebSocket), documented in `docs/modules.md` (board 25).
- [ ] Settings → Automations (boards 13, 17, 18):
  - **Run automations on this device**
  - Devices: paired by finding them on the home network and pressing **Allow** on the device
  - Providers: from the device's catalogue, each with its device, Larder shop and sign-in details
- [ ] Encrypt shop sign-in details in the browser for the device, and pass them on unread. Larder only shows "Signed in as s•••@gmail.com, set 7 Nov" (board 19).
- [ ] Show providers' "Needs you" questions in the app, and pass the answers straight back.
- [ ] The run trail, and live view at home with **Take control** and **Hand back**. Admins only, and recorded in history (boards 22, 23).
- [ ] Settings for the Pi box's Wi-Fi, updates, and remote access (Larder Cloud, Tailscale, a Cloudflare tunnel, or home only), all through the `pi-system` contract. Hide them on Docker and Home Assistant.
- [ ] A second listener that serves only `/mcp`, `/.well-known/*`, `/oauth/register` and `/oauth/token`, for Tailscale Funnel. Connector approval only from the home network (D14).
- [ ] Releases: on every version tag, publish signed arm64 and amd64 tarballs, the web app bundle and a manifest (`releases` contract).

### M3 — Larder Cloud, first version

- [ ] Finding Larder and setting up a phone (`local-enrolment` contract):
  - announce `_larder._tcp` on the home network, with a code that changes every minute
  - set-up endpoints taking the Larder sign-in, the phone's public key and the code
  - give the phone the household key, locked to the phone's key
- [ ] `modules/cloud-link`: link to Larder Cloud together with the app, at home, as part of creating the household (board 15).
- [ ] Records up:
  - numbered records, latest version only, sent in batches with the household's "up to" number
  - "gone" markers for removed records
  - history
  - snapshots
  - photos when asked for
- [ ] Changes down:
  - applied in arrival order through the API, as the person who made them, as of when they were made, and done once
  - each marked done (with the number), couldn't do (with options) or needs a look
- [ ] Presence, and Settings → Cloud link at home: status, waiting changes, and "send everything again".
- [ ] People and phones (boards 6, 9, 11, 12):
  - Settings → Accounts lists each person's phones.
  - Removing a person or a phone tells Larder Cloud and changes the household key.
  - Changing a password asks "Sign out your phones too?"
- [ ] The web app's third way to reach Larder, alongside straight to Larder and a saved copy: the phone's copy (`web-transport` contract). This includes:
  - a sync bar ("At home", "Through Larder Cloud", "No connection")
  - the list of waiting changes
  - reporting Larder's version to the shell

### M4 — Away from home, properly

- [ ] Changes show on the phone straight away, and are applied again on top of the records as new ones arrive. Every phone agrees.
- [ ] The clash rules from `PLAN.md` (Sync):
  - the most recent decision wins, field by field
  - exact counts are sent as differences
  - removing something that's changed asks first
  - changing something already removed fails, with options
  - "Needs a look" appears on every phone and at home
- [ ] "Count both?" when the same purchase comes from two phones (board 8).
- [ ] Switch off a phone or person from anywhere; the Pi confirms it when it's back (board 10).

### M5 — Plug and play

- [ ] Larder Cloud as the first reader in Settings → AI, showing "63 of 100 left this month" (board 14, `ai-lookups` contract).
- [ ] Google Drive backups, using Larder Cloud's short-lived pass, and **Restore from Google Drive** on a new Larder.
- [ ] Live view away from home, through the Larder Cloud relay (board 24).

### Later

- [ ] Restore a new Pi from Larder Cloud.
- [ ] HTTPS at home without Tailscale, using a certificate authority per box, if D15 keeps it.

## Boundaries

- No Firebase code outside `modules/cloud-link`; list its package for that module in `tests/architecture.test.ts`.
- Follow the existing `AGENTS.md` rules: the core stays free of Node APIs, API changes only add, and versions move together.
- Never store shop sign-in details, even briefly, and never log request bodies that carry them.
- Larder's rules never move to the cloud.

## Who to ask

- `larder-cloud`: `cloud-link`, `ai-lookups`, the relay.
- `larder-app`: how the app uses `web-transport` and `local-enrolment`.
- `larder-automations`: `automations`, `live-view`.
- `larder-pi`: `pi-system`, and what the image needs from releases.
- `owner`: anything in `DECISIONS.md`.
