# larder-app: brief

**Repo:** `doonetheprune/larder-app` (new) · **Project:** larder

## Mission

The Larder app in the App Store and Google Play: a Capacitor shell around Larder's own web app. It works with any Larder at home, including the Home Assistant add-on. It:
- talks to Larder directly on the home Wi-Fi
- goes through Larder Cloud everywhere else
- opens with no connection at all
- holds the phone's keys
- handles sign-up and purchases

Every Larder screen is Larder's web app. The shell only adds set-up, connection and native extras.

## Read first

- In the hub, `PLAN.md`: Principles; Sync; People, phones and keys; Sign-up and plans; Larder in Home Assistant.
- In `home-inventory`: `src/web`, especially `src/web/src/api.ts` (the one request function) and `src/web/src/offline/`, plus the integration's sign-in, `custom_components/larder/oauth.py`.

## Contracts

- **Uses:**
  - `web-transport` and `local-enrolment`, from `home-inventory`
  - `cloud-link`, from `larder-cloud`
  - `live-view` (track B), from `larder-automations`

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### M0 — Decide and try

- [ ] Spike S4: a Capacitor shell loads a Larder web build, reaches a Docker Larder on the home network through native HTTP, and signs in through Home Assistant's own login page. Set up App Attest and Play Integrity with Firebase App Check.
- [ ] Spike S5, with `home-inventory`: time encrypting and decrypting a big household's records on a mid-range phone.

### M2 — Linked

- [ ] A first version for testing, through TestFlight and Play internal testing, that:
  - scans the code from Settings → Larder Cloud
  - links the household, using App Check with the debug provider while testing (board 15)
- [ ] A test screen that sends a change through Larder Cloud and shows when home has done it.

### M3 — The app, at home and away

- [ ] The shell loads the version of the web app that home runs, downloaded from `/v/<version>/` and kept on the phone, with a bundled version for the first run.
- [ ] Set up this phone (`local-enrolment`, D22):
  - the Home Assistant add-on: **Sign in with Home Assistant**, finding Home Assistant on the home network or by its address
  - Docker or the Pi box: scan the code from Settings → Larder app, check Larder's key, and finish on the home network
  - either way, keep the Larder token and a key pair made in the Secure Enclave or Android Keystore (Face ID or fingerprint optional), and receive the household key
- [ ] Three routes:
  - at home: through Home Assistant's home address (the add-on), or straight to Larder (Docker or the Pi box)
  - elsewhere: through Larder Cloud, or Home Assistant's outside address if there is one
  - no connection: the phone's copy, kept in SQLite

  At home, hand waiting changes to Larder first. The bar says which route is in use.
- [ ] Find Larder again after an address changes: the latest addresses reported through Larder Cloud, then `homeassistant.local` or `_larder._tcp` where available.

### M4 — Everyone in the house

- [ ] Changes shown straight away, and "Needs a look". These are built in Larder's web app; the shell keeps the phone's copy and the waiting changes.
- [ ] Switch off a phone or person from anywhere (board 10).
- [ ] Check the phone's clock against Firebase's (board 7).

### M5 — In the stores

- [ ] Purchases through RevenueCat, including restoring purchases.
- [ ] App Check with the production providers.
- [ ] Store listings, privacy labels, and review notes explaining that the downloaded web code is the app's own.

### M6 — Plug and play

- [ ] Notifications, where "Needs you" opens the live view (track B) at the step that's stuck.
- [ ] Share to Larder from other apps.
- [ ] Native barcode scanning, offered to Larder's scanner.

## Boundaries

- No Larder screens or rules in the shell.
- Keys never leave the secure chip, and no passwords are stored.
- No Google or other third-party sign-in, so Sign in with Apple isn't required.

## Who to ask

- `home-inventory`: the web app, `web-transport`, `local-enrolment`, the add-on.
- `larder-cloud`: `cloud-link`, App Check, purchases.
- `owner`: store listings and prices.
