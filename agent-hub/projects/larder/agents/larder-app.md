# larder-app: brief

**Repo:** `doonetheprune/larder-app` (new) · **Project:** larder

## Mission

The Larder app in the App Store and Google Play: a Capacitor shell around Larder's own web app. It:
- finds Larder at home and talks to it directly
- goes through Larder Cloud everywhere else
- opens with no connection at all
- holds the phone's keys
- handles sign-up and purchases

Every Larder screen is Larder's web app. The shell only adds set-up, connection and native extras.

## Read first

- In the hub, `PLAN.md`: Principles; Sync; People, phones and keys; Sign-up and plans.
- In `home-inventory`: `src/web`, especially `src/web/src/api.ts` (the one request function) and `src/web/src/offline/`.

## Contracts

- **Uses:**
  - `web-transport` and `local-enrolment`, from `home-inventory`
  - `cloud-link`, from `larder-cloud`
  - `live-view`, from `larder-automations`

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### M0 — Decide and try

- [ ] Spike S4: a Capacitor shell loads a Larder web build and reaches a Larder on the home network through native HTTP. Set up App Attest and Play Integrity with Firebase App Check.
- [ ] Spike S5, with `home-inventory`: time encrypting and decrypting a big household's records on a mid-range phone.

### M3 — Larder Cloud, first version

- [ ] The shell loads the version of the web app that home runs, downloaded from `/v/<version>/` and kept on the phone, with a bundled version for the first run.
- [ ] Find Larder at home: try the last known address first, then look for `_larder._tcp`. Check it really is your Larder before sending anything.
- [ ] Set up this phone at home (`local-enrolment`):
  - sign in to Larder
  - make a key pair in the Secure Enclave or Android Keystore, with Face ID or fingerprint optional
  - receive the household key
- [ ] Three routes:
  - at home: straight to the Pi
  - elsewhere: through Larder Cloud
  - no connection: the phone's copy, kept in SQLite

  At home, hand waiting changes to the Pi over Wi-Fi first. The bar says which route is in use.
- [ ] Sign-up from the app at home: Settings → Larder Cloud, free plan first, with App Check and the at-home code (board 15).

### M4 — Away from home, properly

- [ ] Changes shown straight away, and "Needs a look". These are built in Larder's web app; the shell keeps the phone's copy and the waiting changes.
- [ ] Switch off a phone or person from anywhere (board 10).
- [ ] Check the phone's clock against Firebase's (board 7).

### M5 — Plug and play

- [ ] Purchases through RevenueCat, including restoring purchases.
- [ ] Notifications, where "Needs you" opens the live view at the step that's stuck.
- [ ] Share to Larder from other apps.
- [ ] Native barcode scanning, offered to Larder's scanner.
- [ ] Store listings, privacy labels, and review notes explaining that the downloaded web code is the app's own.

## Boundaries

- No Larder screens or rules in the shell.
- Keys never leave the secure chip, and no passwords are stored.
- No Google or other third-party sign-in, so Sign in with Apple isn't required.

## Who to ask

- `home-inventory`: the web app, `web-transport`, `local-enrolment`.
- `larder-cloud`: `cloud-link`, App Check, purchases.
- `owner`: store listings and prices.
