# larder-cloud: brief

**Repo:** `doonetheprune/larder-cloud` (new) · **Project:** larder

## Mission

Larder Cloud is one Firebase project for every household, and any Larder can link to it: the Home Assistant add-on, Docker or the Pi box. It:
- keeps each household's records and waiting changes
- lets phones sign in with keys Larder registered
- offers the plug-and-play services

It never runs Larder's rules, never sees passwords or shop sign-in details, and has no sign-up page on the web.

## Read first

- In the hub, `PLAN.md`: Sync; People, phones and keys; Sign-up and plans; Larder in Home Assistant; Cloud services; Security and privacy.
- In `home-inventory`: `docs/ARCHITECTURE.md`, `docs/mcp.md` and `addon/config.yaml`.

## Contracts

- **Owns:** `cloud-link`, `ai-lookups`.
- **Uses:**
  - `releases`: the web app bundles to host
  - `local-enrolment`: the set-up code used when creating a household
  - `live-view` (track B): what the relay carries

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### M0 — Decide and try

- [ ] Set up the repo: Firebase project config, the emulators, and CI that runs the rules and function tests against the emulators.
- [ ] Spike S3, with `home-inventory`: how Firestore and Firebase Auth behave from Node inside the Home Assistant add-on, on aarch64 and amd64 (memory use, reconnecting after the network drops, custom-token sign-in). Report the results in a message to the owner.
- [ ] A cost model per household (reads, writes, storage, functions, data out), for the owner's plan decisions (D10).

### M1 — Ready to link

- [ ] Draft `cloud-link` 0.x, covering:
  - the Firestore layout
  - the change envelope and its statuses
  - numbering and "up to"
  - the encryption envelope (D2)
  - presence and snapshots
  - the functions' API and the custom token claims
  - one connection per household

  Agree it with `home-inventory` and `larder-app`.
- [ ] Conformance tests for `cloud-link`, which both the home side and the phone side run against the emulators.

### M2 — Linked

- [ ] Create the production project in the chosen location (D5), with budget alerts.
- [ ] Security rules, with emulator tests:
  - Larder at home writes its household's records and marks changes done
  - phones read their own household and add changes
  - nobody reaches another household
  - secrets go in collections only functions can read
- [ ] Functions:
  - create a household, checking Larder's signature, App Check, the set-up code and the free-plan claim (board 15)
  - Larder's sign-in
  - delete a household and everything in it
- [ ] One connection per household: a second Larder using the same identity (for example a restored Home Assistant backup) is refused until the household is moved to it.
- [ ] Presence in Realtime Database; snapshots in Storage; clearing out old "gone" markers.
- [ ] Hosting: the web app at `/v/<version>/` for every supported version (D6), taken from Larder's releases. Each deploy replaces the whole site, so it must include the old versions too.
- [ ] Per-household limits: records, storage, and changes a day.

### M3 — The app, at home and away

- [ ] Register and remove phones, only when Larder asks.
- [ ] Phone sign-in: a signed challenge returns a custom token naming the household, person, role and phone.
- [ ] The household key for each phone (`keys/`), changed when a phone is removed (board 11).
- [ ] App Check on every function that phones call (with the debug provider for test builds).

### M4 — Everyone in the house

- [ ] Switch off a phone or person from anywhere (admins only), and record it for Larder to confirm (board 10).
- [ ] Check phone clocks against Firebase's: a change can't claim to have been made after it arrived (board 7).

### M5 — In the stores

- [ ] Plans: RevenueCat webhooks set each household's plan, and the rules allow sync only on a current plan, with a grace period.
- [ ] Free plan guards (board 16):
  - the genuine-app check
  - one free household per phone (DeviceCheck)
  - rate limits
  - a monthly spending cap, with alerts
- [ ] A privacy notice, and deletion, that meet UK GDPR.
- [ ] Larder Cloud in a browser, for laptops: a shell that loads `/v/<version>/`, set up with a code from Larder's settings.

### M6 — Plug and play

- [ ] AI reads (`ai-lookups`, board 14):
  - a monthly allowance per household (100 on the free plan)
  - counted in the same transaction that records the read
  - Larder Cloud's keys kept in Secret Manager
  - photos not kept
- [ ] Google Drive: one verified Google client using `drive.file`. Keep Drive sign-ins encrypted with Cloud KMS, and give Larder short-lived passes to upload.
- [ ] The MCP relay: connector sign-in, approved at home (D14), with requests passed to Larder's own `/mcp`.
- [ ] Push notifications (FCM) for "Needs you", "basket filled" and similar.
- [ ] The live view relay on Cloud Run, for track B's live view (board 24). Larder at home and the phone both connect out to it; it's encrypted end to end and ends when idle.

### Later

- [ ] Restore a new Larder from the cloud, using the household key from a phone.
- [ ] The assistant answering while home is offline, if D9 says so.

## Boundaries

- No Larder rules in the cloud. Functions contain no Larder code beyond shared schemas.
- Never store passwords, usernames, shop sign-in details, households' own AI keys or Gmail sign-ins.
- No sign-up or account page on the web: households are only created by the function above.
- Secrets live in Secret Manager or are encrypted with KMS, in collections no client can read.

## Who to ask

- `home-inventory`: the home side of `cloud-link`, records and changes, the add-on.
- `larder-app`: App Check, purchases, the phone side of `cloud-link`.
- `larder-automations` (track B): what the relay carries.
- `owner`: location, plans, prices, privacy.
