# home-inventory: brief

**Repo:** `doonetheprune/home-inventory` (Larder) · **Project:** larder

## Mission

Larder stays the source of truth for each household, however it's installed: as the Home Assistant add-on, in Docker or on the Pi box. This repo grows the hooks that let any Larder:
- link to Larder Cloud
- run its core on a phone
- set up phones at home
- later, drive automations on any device

It must not become tied to Firebase: Firebase code lives only in `modules/cloud-link`. The main track is tested with the Home Assistant add-on first.

## Read first

- In this repo: `AGENTS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `addon/config.yaml`, and the integration's `custom_components/larder/oauth.py` and `mcp.py`.
- In the hub, `PLAN.md`, especially these sections: Sync; People, phones and keys; Larder in Home Assistant.

## Contracts

- **Owns:** `web-transport`, `local-enrolment`, `releases`.
- **Uses:**
  - `cloud-link` and `ai-lookups`, from `larder-cloud`
  - track B only: `automations` and `live-view` from `larder-automations`, and `pi-system` from `larder-pi`

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### Now — no dependencies

- [ ] Set SQLite to `synchronous = FULL` in `src/adapters/storage-sqlite/index.ts`, so a power cut can't roll back recent changes (board 1). **Done when:** a test checks the setting, and `docs/DECISIONS.md` says why.
- [ ] Merge two items into one. Stock, history, variants, barcodes, aliases, module fields and purchase history move to the item that's kept (board 2). **Done when:** it works in the API, in the app and as an assistant tool, with tests.
- [ ] Send shopping ticks as they happen instead of all together on Done (board 3), once the owner decides D17.

### M0 — Decide and try

- [ ] Spike S2: Larder's core, running in a browser, answers every page of the example household. Report the results in a message to the owner.
- [ ] Spike S6: can the integration pass Larder's whole API through Home Assistant, photos and live updates included? Can it tell whether a request came from the home network or through Nabu Casa? Report to the owner.
- [ ] Spike S3, with `larder-cloud`: Firestore and Firebase Auth from Node inside the add-on, on aarch64 and amd64.

### M1 — Ready to link

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

### M2 — Linked

- [ ] `modules/cloud-link`, Settings → Larder Cloud:
  - **Link** shows a code for the app to scan (board 15)
  - status, waiting changes, "send everything again", and unlink
- [ ] Records up:
  - numbered records, latest version only, sent in batches with the household's "up to" number
  - "gone" markers for removed records
  - history
  - snapshots
  - photos when asked for
- [ ] Changes down:
  - applied in arrival order through the API, as the person who made them, as of when they were made, and done once
  - each marked done (with the number), couldn't do (with options) or needs a look
- [ ] Presence: Larder Cloud can show whether home is connected.
- [ ] Works from the Home Assistant add-on:
  - outbound connections only
  - the credential kept in the data folder
  - a backup restored on another machine asks before taking over the household
- [ ] Releases: the web app bundle and a manifest on every version tag, for Larder Cloud to host (`releases`).

**Done when:** an add-on Larder and a Docker Larder are linked from their own settings using the app's first version, and stay in step.

### M3 — The app, at home and away

- [ ] Routes as data.
  - Core and server routes become one table, in the `ModuleRoute` shape.
  - Fastify registers the table.
  - `core.api.handle()` serves a request without HTTP.

  **Done when:** `docs/openapi.json` is unchanged and every test passes.
- [ ] Phone mode: a `createCore` option in which:
  - `ctx.fetch` answers "needs home"
  - Home Assistant is a stand-in that also answers "needs home"
  - timers only run through a new `ctx.every`; move email, MQTT and shop locations to it
  - modules that only make sense at home are marked, and skipped
- [ ] Run Larder's core in the browser: a chunk that loads only when needed, holding the core, the modules and the memory adapters, and answering the web app's requests from a set of records. Offline copies move onto it, so every page and search works in a copy.
- [ ] Tests:
  - every module's pages answer in phone mode on the example household
  - a parity test runs random requests two ways, through phone mode plus sync and directly, and compares the records
- [ ] The integration's passthrough (`custom_components/larder`, with tests in `tests/ha`):
  - Larder's whole API at `/api/larder/v1/…`, with photos and live updates streamed
  - Larder tokens passed on as they are, as `/api/larder/mcp` does
- [ ] Sign in with Home Assistant for the app (`local-enrolment`, D22, board 6):
  - reuse the connector sign-in in `oauth.py` for the Larder app
  - only from the home network, not through Nabu Casa or another outside address
  - the same step registers the phone's key, and hands back a Larder token and the household key
- [ ] Setting up a phone with a code, for Docker and the Pi box (`local-enrolment`): Settings → Larder app → **Add a phone** shows a code with Larder's addresses and key, and the app finishes the set-up on the home network.
- [ ] Removing a phone (boards 9, 11):
  - its Larder token is revoked
  - Larder Cloud is told
  - the household key changes
  - Settings → Accounts lists each person's phones
- [ ] The web app's third way to reach Larder, alongside straight to Larder and a saved copy: the phone's copy (`web-transport`). This includes:
  - a sync bar ("At home", "Through Larder Cloud", "No connection")
  - the list of waiting changes
  - reporting Larder's version to the shell
- [ ] Add rules to `AGENTS.md`: routes are data; mark secret collections home-only; timers use `ctx.every`; modules must be safe in phone mode. Add the matching `docs/DECISIONS.md` entries, and describe the app in `docs/home-assistant.md`.

### M4 — Everyone in the house

- [ ] Changes show on the phone straight away, and are applied again on top of the records as new ones arrive. Every phone agrees.
- [ ] The clash rules from `PLAN.md` (Sync):
  - the most recent decision wins, field by field
  - exact counts are sent as differences
  - removing something that's changed asks first
  - changing something already removed fails, with options
  - "Needs a look" appears on every phone and at home
- [ ] "Count both?" when the same purchase comes from two phones (board 8).
- [ ] Switch off a phone or person from anywhere; Larder confirms it when it's back (board 10).
- [ ] Changing a password asks "Sign out your phones too?" (board 12).

### M5 — In the stores

- [ ] Settings → Larder Cloud shows the household's plan and what it includes. Larder hides features the plan doesn't include.

### M6 — Plug and play

- [ ] Larder Cloud as the first reader in Settings → AI, showing "63 of 100 left this month" (board 14, `ai-lookups` contract).
- [ ] Google Drive backups, using Larder Cloud's short-lived pass, and **Restore from Google Drive** on a new Larder.
- [ ] Live view away from home, through the Larder Cloud relay (board 24), once B1 is done.

### B1 — Automations on any device

- [ ] A module hook for connections that stay open (WebSocket), documented in `docs/modules.md` (board 25).
- [ ] Settings → Automations (boards 13, 17, 18):
  - **Run automations on this device**
  - Devices: paired by finding them on the home network and pressing **Allow** on the device
  - Providers: from the device's catalogue, each with its device, Larder shop and sign-in details
- [ ] Encrypt shop sign-in details in the browser for the device, and pass them on unread. Larder only shows "Signed in as s•••@gmail.com, set 7 Nov" (board 19).
- [ ] Show providers' "Needs you" questions in the app, and pass the answers straight back.
- [ ] The run trail, and live view at home with **Take control** and **Hand back**. Admins only, and recorded in history (boards 22, 23).

### B2 — The Larder Pi box

- [ ] Settings for the Pi box's Wi-Fi, updates, and remote access (Larder Cloud, Tailscale, a Cloudflare tunnel, or home only), all through the `pi-system` contract. Hide them on Docker and Home Assistant.
- [ ] A second listener that serves only `/mcp`, `/.well-known/*`, `/oauth/register` and `/oauth/token`, for Tailscale Funnel. Connector approval only from the home network (D14).
- [ ] Signed arm64 and amd64 tarballs on every version tag (`releases`).

### Later

- [ ] Restore a new Larder from Larder Cloud.
- [ ] HTTPS at home without Tailscale, using a certificate authority per box, if D15 keeps it.

## Boundaries

- No Firebase code outside `modules/cloud-link`; list its package for that module in `tests/architecture.test.ts`.
- Follow the existing `AGENTS.md` rules: the core stays free of Node APIs, API changes only add, and versions move together.
- Never store shop sign-in details, even briefly, and never log request bodies that carry them.
- Larder's rules never move to the cloud.

## Who to ask

- `larder-cloud`: `cloud-link`, `ai-lookups`, the relay.
- `larder-app`: how the app uses `web-transport` and `local-enrolment`.
- `larder-automations` (track B): `automations`, `live-view`.
- `larder-pi` (track B): `pi-system`.
- `owner`: anything in `DECISIONS.md`.
