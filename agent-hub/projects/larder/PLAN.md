# Plan: Larder in the cloud and on your phone, with any Larder at home

The plan for the Larder project. Every agent reads this, then its brief in `agents/`. The owner changes this file; agents suggest changes by message (see `PROTOCOL.md`).

1. What we're building
2. Principles
3. Repos and agents
4. How it fits together
5. Design: sync, what works where, people, phones and keys, sign-up and plans, Larder in Home Assistant, cloud services, automations (track B), the Larder Pi box (track B), security and privacy
6. Milestones
7. What depends on what
8. Board items
9. Risks
10. Getting started

## 1. What we're building

Larder runs at home today, as a Home Assistant add-on, in Docker, or on a Raspberry Pi. The main track builds two things that work with any of them, including the Home Assistant add-on:

- **Larder Cloud:** one Firebase project for every household.
  - Any Larder can link to it from its own settings.
  - It keeps a copy of each household, so the app works away from home, even when home is offline.
  - It passes changes back to Larder at home.
  - Later, it adds plug-and-play services: AI reads with no key of your own, backups to Google Drive, the Claude connector from anywhere, and phone notifications.
- **The Larder app**, in the App Store and Google Play. It's Larder's own web app in a native shell, which:
  - talks to Larder at home on the Wi-Fi: directly, or through Home Assistant when Larder is the add-on
  - goes through Larder Cloud everywhere else
  - opens with no connection at all

A second track, **track B**, runs alongside whenever there's time. Nothing in the main track waits for it, except the live view from away from home.
- **Automations on any device:** Larder Automations and the shop providers run beside any Larder (as an add-on, in Docker, on a Mac or on a Pi), and are controlled entirely from Larder.
- **The Larder Pi box:** an image to flash onto a Raspberry Pi. It sets up its own Wi-Fi, runs Larder and the automations, and updates itself.

## 2. Principles

1. **Any Larder at home will do:** the Home Assistant add-on, Docker or the Pi box. The first milestones are tested with the add-on.
2. **Larder at home is the source of truth.** Larder Cloud keeps a copy and a queue. It never runs Larder's rules.
3. **Changes go up as API requests; results come down as records.** "Used 2 milk" is `POST /stock/use`, and Larder at home applies it through its own API.
4. **One front end.** The same Larder web app runs at home, in the app and in Larder Cloud; only how it reaches Larder changes. No feature is built twice.
5. **The phone runs the version home runs.** The app and Larder Cloud load the version of the web app that Larder at home reports.
6. **Adding access needs the home network; taking it away works from anywhere.**
7. **Secrets stay where they're used:**
   - Passwords stay in Larder at home, or in Home Assistant.
   - Shop sign-in details stay on the automations device.
   - Larder Cloud's own keys stay in Larder Cloud.
   - Records and changes in the cloud are encrypted end to end (D2).
8. **Repos meet only at contracts.** Each contract is versioned, owned by one agent, and has conformance tests on both sides.
9. **One agent per repo; the owner decides.**

## 3. Repos and agents

| Repo | | What it is | Agent |
|---|---|---|---|
| `home-inventory` | existing, public | Larder: core, server, web app, modules, the Home Assistant add-on and integration | `home-inventory` |
| `larder-cloud` | new | The Firebase project: rules, functions, hosting, the live view relay | `larder-cloud` |
| `larder-app` | new | The store app: a Capacitor shell around Larder's web app | `larder-app` |
| `larder-automations` | existing, track B | The automations hub, today a Mac menu bar app with a Chrome extension | `larder-automations` |
| `larder-provider-tesco` | existing, track B | The Tesco provider | `larder-provider-tesco` |
| `larder-provider-toolstation` | existing, track B | The Toolstation provider | `larder-provider-toolstation` |
| `larder-pi` | new, track B | The Pi image, Wi-Fi set-up, updater and system helper | `larder-pi` |
| `agent-hub` | new | This hub: plan, contracts, status, messages | `coordinator` (optional) |

## 4. How it fits together

```
Phone or laptop, anywhere
  The Larder app, or Larder Cloud in a browser
  └ Larder's web app, the version home runs,
    with Larder's core answering from the phone's copy

        ↑ changes (API requests)      ↓ records

Larder Cloud: one Firebase project, every household
  Auth         phones sign in with keys Larder registered
  Firestore    records · changes · members and phones
  Realtime DB  is home connected?
  Storage      snapshots · photos
  Hosting      /v/<version>/ web apps
  Functions    households · sign-in · AI reads · Drive · MCP
  Cloud Run    live view relay (track B)

        ↑ records (every write, numbered)   ↓ changes

Larder at home: the Home Assistant add-on, Docker or the Pi box
  Larder, with the Cloud link module
  └ Larder Automations, track B: an add-on, Docker, a Mac or the Pi
    └ providers: Tesco, Toolstation

At home on the Wi-Fi, the app talks to Larder directly,
or through Home Assistant when Larder is the add-on.
```

## 5. Design

### Sync

**From Larder at home to the cloud: records.**
- Every write at home gets the next number, in the same transaction as the write.
- The Cloud link module sends the latest version of each changed record in batches. The household's "up to" number moves in the same batch, so nobody ever sees half a batch.
- After an outage it carries on from the last number Larder Cloud acknowledged.
- A removed record becomes a "gone" marker, cleared after a few months. A phone away longer than that starts again from a snapshot.
- History entries are only ever added. The cloud keeps 12 months of them (D4).
- Larder at home saves a compressed snapshot now and then (daily, say). A new phone downloads it, then only the records numbered after it.
- Photos travel separately, and are fetched the first time they're shown (D3).

**From the cloud to Larder at home: changes.**
- A change is the API request, plus:
  - its id
  - who made it (person and phone)
  - when it was made
  - which version of each record the phone was looking at
- With no signal, a change waits on the phone (Firestore keeps it) and goes when there's signal. At home, the app hands it to Larder over the Wi-Fi.
- Larder at home applies changes in the order they reach Firestore:
  - through its own API, as the person who made them
  - as of when they were made
  - with ids made from the change's id
- Each change is marked:
  - **done**, with the number it reached
  - **couldn't do**, with why and some options
  - **overtaken**
  - **needs a look**
- No change is ever applied twice, even across a power cut: it's recorded in the same transaction as its writes.

**On the phone.**
- The phone keeps its own copy (the records, and the highest number it has) and runs Larder's core over it (D1), so every page, search and list works anywhere.
- It shows its copy plus every change home hasn't done yet, from this phone and any other. These are re-applied in order whenever new records arrive.
- A change drops off the waiting list once the phone's copy reaches the number it was done at, so nothing flickers.
- It's the same code as at home, so a mistake shows straight away, even with home offline.

**When things clash.** Home decides, and every phone uses the same rules:
1. **Things you did add up:** add, use, move, buy, tick off, in any order. If there isn't enough left by the time a change arrives, it isn't forced. It shows as "Couldn't do: there's only 1 pint of milk to use", with **Use what's left** or **Drop it**.
2. **Things you set** (a minimum, a name, a place): the most recent decision wins, field by field.
   - Phone clocks are checked against Firebase's, and a change can't claim to have been made after it arrived.
   - An exact count is sent as the difference from what the phone showed, so stock added at home meanwhile still counts.
3. **Removing something** that changed after your phone last saw it waits for a yes. Changing something that's already been removed fails, with **Add it back** or **Drop it**.
4. **The same thing recorded twice:** if the same item is bought at the same shop within minutes from two phones, Larder asks "Count both?". Purchases at different shops both count.
5. **Questions** show on every phone and at home. The first answer settles it.

**Durability:** SQLite runs with `synchronous = FULL`. Larder at home reports a change done only once it's on disk.

### What works where

| | Away, home connected | Away, home offline |
|---|---|---|
| Search, items, places, lists, scenarios, recipes, prices, purchases | ✔ | ✔ as of the last sync |
| Add, use, move, edit, shopping list, ticking off a shop | ✔ | ✔ shown now, done when home's back |
| Scanning | ✔ | Known barcodes ✔; new ones need home |
| Add by photo, receipts | ✔ | ✔ through Larder Cloud's AI reads |
| Start a shop, slots, fill basket | ✔ | Waits, if you choose |
| Live view of the automations (track B) | ✔ | ✗ |
| Household settings, module switches | ✔ | ✔ waits |
| Settings with secrets, shop sign-in details | ✔ encrypted | ✗ |
| Adding people and phones | Home only | Home only |
| Switching off a phone or person | ✔ | ✔ |

At home on the Wi-Fi, the app talks to Larder directly. With the Home Assistant add-on it goes through Home Assistant instead, so the add-on's own port stays closed (see Larder in Home Assistant). Home Assistant, NFC, MQTT and assistants keep talking to Larder at home as they do now. Larder opened at home, or inside Home Assistant, is unchanged.

### People, phones and keys

- **Larder at home is the only place people exist.** Accounts, usernames, passwords and roles belong to Larder (or, for the add-on, come from Home Assistant) and are managed as today. Larder Cloud only knows:
  - the household
  - each person's Larder id, name and role
  - each phone's public key
- **Setting up a phone happens at home** (D22). How the person proves who they are depends on how Larder is installed:
  - **The Home Assistant add-on: Sign in with Home Assistant.**
    - The app finds Home Assistant on the home network (or the person types its address) and opens Home Assistant's own login page.
    - Then a page asks "Allow the Larder app to use Larder?". This is the same sign-in Larder's Claude connector already uses through Home Assistant.
    - The integration only shows that page when the sign-in comes from the home network, not through Nabu Casa or another outside address.
    - Nobody needs a Larder password.
  - **Docker or the Pi box: a code from Larder's settings.**
    - Signed in to Larder as usual, the person opens Settings → Larder app → **Add a phone**, and Larder shows a QR code for a few minutes.
    - On the home Wi-Fi, they scan it with the app. The code tells the app where Larder is and which Larder it is, so a look-alike can't fool it.
    - The app connects straight to Larder to finish. Larder only accepts the code from its own network, not through a tunnel or Larder Cloud.
- **Either way, the set-up then finishes the same:**
  1. The phone makes a key pair. The private half stays in its secure chip, optionally behind Face ID or a fingerprint.
  2. Larder gives the phone:
     - a Larder token for that person: never a Home Assistant token, so the app can use Larder but nothing else in Home Assistant
     - a registration with Larder Cloud, if the household is linked
     - the household key, locked to the phone's key
  3. Admins see a notice: "Alex added a Pixel 8 at 19:42 · Remove".
- **Signing in to Larder Cloud.** The phone signs a challenge. A function checks it against the phones Larder registered and returns a Firebase custom token naming the household, person, role and phone. Firebase then keeps the phone signed in, and Larder Cloud can cancel that at any time.
- **Removing someone, or one of their phones,** happens in Larder at home:
  - The phone's Larder token is revoked.
  - Larder Cloud cancels its sessions and refuses new ones.
  - The household key changes. The new key reaches the remaining phones through the cloud, locked to each phone's own key.
  - The removed app wipes its copy as soon as it's told.
  - Nothing new is readable on that phone straight away, and within the hour it can't reach Firebase at all. What it already had stays on it.
- **Switching off a phone or a person** works from anywhere (admins only), even with Larder offline. Larder confirms it when it's back. Keys are per phone, so a lost phone can go without removing the person.
- **Usernames, passwords and roles** change only in Larder at home, or in Home Assistant. Phones use keys, not the password, so **Change password** asks "Sign out your phones too?".
- **Laptops:** the same code, typed into Larder Cloud on that computer. The key then lives in that browser.
- **No-login mode:** Larder Cloud needs accounts switched on.
- **No email or Google sign-in.** Recovery means going home and setting the phone up again (D16).

### Sign-up and plans

- **Sign-up only from the Larder app, started in Larder's own settings** (Settings → Larder Cloud → **Link**), never from a web page. The one function that creates a household needs all four of:
  1. Larder's signature
  2. proof it's the genuine app on a real phone (App Check, using App Attest or Play Integrity; test builds use App Check's debug provider)
  3. a one-time code from Larder: shown in Larder's settings and scanned by the app, or passed straight to the app for an admin signed in through Home Assistant
  4. a store purchase, or a claim to the free plan

  Larder's own page can't pass the app check, so the app is the only way in. It works the same for the add-on, Docker and the Pi box.
- **After sign-up, Larder Cloud has three ways in:**
  - Larder at home, with its key
  - the phones Larder added, with their keys
  - the stores' payment notices, through RevenueCat

  No client can create or change a household directly.
- **Plans (D10):**
  - Any admin can buy a plan for the household in the app, through Apple or Google.
  - Changing or cancelling a plan goes through the store.
  - Self-hosted Larder stays free.
- **Free plan guards.** Anyone can run a Larder, so a script could create fake households to collect free AI reads. The guards are:
  - the genuine-app check
  - one free household per phone (Apple's DeviceCheck does this on iPhone; Android leans more on the next two)
  - rate limits per household
  - a monthly spending cap across all households, with alerts

### Larder in Home Assistant

The add-on is the first Larder the main track is tested with. Everything goes through Home Assistant's own API, with a Home Assistant user in front of it, so the add-on's own port stays closed.
- **Linking:** the add-on links to Larder Cloud like any other Larder, from Settings → Larder Cloud, opened through Home Assistant as now. It only needs ordinary outbound internet.
- **The app goes through Home Assistant**, the way Larder's Claude connector already does:
  - Today the integration passes MCP through Home Assistant at `/api/larder/mcp` (`custom_components/larder/mcp.py`). Its sign-in (`oauth.py`) gives the connector a Larder token after Home Assistant's own login.
  - The app uses the same sign-in, plus a new passthrough for Larder's whole API at `/api/larder/v1/…`, including photos and live updates.
  - The app only ever holds a Larder token for that person, never a Home Assistant token, so it can use Larder but nothing else in Home Assistant.
- **Routes:** at home, the app uses Home Assistant's home address. Away, it uses Larder Cloud, or Home Assistant's outside address if there is one (Nabu Casa, or your own).
- **When Home Assistant is restarting** (an update, say), the app uses its copy or Larder Cloud until it's back.
- **Backups:**
  - Larder's credential for Larder Cloud lives in the add-on's data folder, so it's in Home Assistant backups.
  - A backup restored on a second machine mustn't become a second home for the same household. Larder Cloud accepts one connection per household and asks before moving it.
  - Home Assistant's cold backups stop Larder for a few seconds. Larder Cloud shows home as offline briefly, and changes wait.
- **Unchanged:** the integration's sensors and actions, and MCP through Home Assistant, carry on as now.

### Cloud services

- **AI reads** (`ai-lookups`):
  - Larder Cloud is the first reader in Settings → AI ("63 of 100 left this month"), ahead of the household's own Claude or Gemini key.
  - Larder at home, or a phone when home is offline, sends the photo.
  - A function checks the plan and this month's count, reads the photo with Larder Cloud's key (from Secret Manager), records the read in the same transaction as the count, and answers in the AI module's own format.
  - Photos aren't kept. Web searches cost more (D10).
- **Google Drive backups:**
  - Larder Cloud owns one verified Google client that only asks for the files it creates (`drive.file`).
  - Larder at home makes and encrypts the backup (the database and photos, each photo only once) and uploads it straight to a "Larder backups" folder using a short-lived pass. The last 30 are kept.
  - Restore happens when setting up a new Larder, using the household key from a phone or a backup password.
  - Home Assistant users can already back up to Drive through Home Assistant.
- **The Claude connector:**
  - Larder Cloud's MCP address passes each request to Larder's own `/mcp` at home and brings back the answer.
  - Connector sign-in is approved at home (D14).
  - It works whenever home is connected; while home is offline, the assistant says so (D9).
- **Notifications:** "Needs you", basket filled, running low.
- **Live view relay** (for track B): a small Cloud Run service that Larder at home and the phone both connect out to.
- **Secrets in the cloud**, all in collections no app can read:

  | Secret | Kept as |
  |---|---|
  | Larder at home's credential, connector tokens | hashes |
  | Google Drive sign-ins | encrypted with Cloud KMS |
  | Subscriptions | held by RevenueCat |
  | Larder Cloud's own keys | Secret Manager |

  Never in the cloud: passwords, usernames, shop sign-in details, households' own AI keys, or Gmail sign-ins.

### Automations (track B)

**Where they run.** Larder Automations runs beside any Larder, on any paired device: a second Home Assistant add-on, a second Docker service, a Mac, or the Pi box. In Larder: Settings → Automations → **Run automations on this device**.
- It's always a separate service or container, never part of Larder. That way:
  - shop passwords stay out of Larder's data and backups
  - a browser visiting shop websites is kept apart from the inventory
  - it can crash or update without touching Larder
- A device that's always on (the add-on, Docker, the Pi box) never needs waking.

**Settings → Automations:**

```
Run automations on this device              [On]

Devices
  This device      Larder Automations 1.6   Ready
  Mac mini                                  Asleep · woken when needed
  + Add a device

Providers
  Tesco         on This device  shop: Tesco          Signed in · s•••@gmail.com
  Toolstation   on Mac mini     shop: Toolstation    Needs you: sign in again
  + Add a provider
```

- **Adding a device:** Larder finds it on the home network, you press **Allow** on the device, and they swap keys. There's no address or token to copy.
- **Providers** come from a catalogue the project publishes and signs. The device installs and updates them itself. To add one, pick it, pick the device, link a Larder shop and enter the sign-in details.
- **Shop sign-in details:**
  - They're encrypted in the browser for that device before they leave it.
  - Larder and Larder Cloud pass them on without being able to read them.
  - The device keeps them encrypted: in the Keychain on a Mac, or with the key kept elsewhere on Linux (D11).
  - Larder only shows "Signed in as s•••@gmail.com, set 7 Nov", with **Change** and **Remove**.
  - Moving a provider to another device means typing them again.
- **Needs you:** when a provider has to sign in again, or Tesco sends a code, the app asks for it and passes the answer straight back.
- **Run trail:** for every run, a line and a small screenshot per step, plus a full screenshot where it stopped. The device keeps the last 10 runs, and Larder fetches them when someone looks. They stay on the device because they can show addresses and orders.
- **Live view:**
  - What you see: only the provider's tab, streamed with Chrome's own screencast (a frame whenever the page changes), with taps and typing sent back.
  - Control: it opens just watching. **Take control** pauses the run; **Hand back** resumes it.
  - On a phone: pinch to zoom, tap to click, and a text box for typing that's marked for one-time codes.
  - Who: admins only. Each session is recorded in history, shown on the device while it's open, and ended when idle.
  - How it travels: at home through Larder; away through Larder Cloud's relay, encrypted end to end.
  - Later, a Pi could optionally show its whole virtual screen through noVNC. A Mac's desktop is never shown.
- **Never in the cloud:** providers don't run in Larder Cloud. That would put everyone's shop passwords in one place, and the shops' bot checks would see datacentre addresses.

### The Larder Pi box (track B)

This brings in the Pi plan from the owner's other chat, as an optional second way to run Larder.

- **Hardware:** a Pi 4 (4 GB) at least; a Pi 5 is recommended (D12). Later, a Zero 2 W could get a separate "Larder only" image.
- **The image:**
  - Raspberry Pi OS 64-bit, with a light desktop session that logs in by itself so Chromium can run. No monitor needed.
  - Built by pi-gen with a Larder stage, in GitHub Actions, on each version tag. The `.img.xz` is attached to the release and flashed with Raspberry Pi Imager.
- **On it:**
  - Node 24 (arm64).
  - Larder in `/opt/larder/releases/<version>`, with a `current` link to the version in use. It runs as a systemd service, with its data in `/var/lib/larder`.
  - Larder Automations and the providers as systemd services.
  - Chromium with a persistent profile and the extension.
  - avahi, so the box is `larder.local`.
  - Tailscale, installed but not signed in.
  - The Wi-Fi set-up, the updater, and a small system helper for Larder's settings.
- **First boot, connecting to Wi-Fi:**
  1. If Ethernet is plugged in, it goes straight on.
  2. Otherwise it scans for networks first, because the Pi's single radio can't scan once the hotspot is up.
  3. It starts a hotspot, `Larder-XXXX`, with its password on a card in the box.
  4. Joining the hotspot opens a set-up page (a captive portal) asking for the home network, its password and the Wi-Fi country (GB by default).
  5. It connects without a reboot, and the phone shows "Connected: open http://larder.local" with a QR code.
  6. If the password was wrong, the hotspot comes back with an error.
  - If the saved network isn't seen for a few minutes after boot, the hotspot comes back. That covers a new router or moving house.
  - A factory reset clears Wi-Fi and data: a button, or a file on the boot partition.
- **First visit:**
  1. Create the admin account (this already exists).
  2. Choose how to reach Larder away from home: Larder Cloud (with the app), Tailscale (free, signed in with a QR code; it also gives the AI routes a public address through Funnel), a Cloudflare tunnel token, or home only.
  3. Sign in to Tesco once, using the live view. The details are stored on the device.
  4. Updates are automatic by default.
- **Updates:** the updater (run as root) checks GitHub Releases daily, verifies signatures (D18), and rolls back if Larder doesn't come back healthy. Providers update through the signed catalogue.
- **What changed from the original Pi plan:**
  - The image lives in `larder-pi`, not in a `pi/` folder in `home-inventory`.
  - The updater moves to `larder-pi`.
  - "Away from home" now includes Larder Cloud.
  - Screenshots and VNC become the run trail and live view.
  - Where the device keeps the shop sign-in key is D11.
  - The per-box certificate authority waits (D15), because the app and Tailscale cover most people.

### Security and privacy

- Records, changes, snapshots and backups are encrypted with the household key (D2). The cloud sees only ids, numbers, sizes and times.
- The connector and AI reads can't be end to end, because Claude and Gemini need to see the request. They pass through Larder Cloud's memory and aren't stored.
- UK GDPR needs:
  - a privacy notice
  - deleting a household removes everything
  - Google's data processing terms
  - a European location for the data (D5)
- Costs: functions need the pay-as-you-go plan, so we'll set budget alerts and per-household limits.
- Check the shops' terms before offering providers publicly (D19).

## 6. Milestones

The main track runs M0 to M6. Your two milestones are **M2 (Linked)** and **M3 (The app, at home and away)**. Track B runs alongside whenever there's time. Each agent's brief breaks its part down into tasks.

### M0 — Decide and try

Try the risky parts first, and make the decisions that shape M1.

| Spike | Who | Question |
|---|---|---|
| S2 | `home-inventory` | Can Larder's core, running in a browser, answer every page of the example household? |
| S3 | `larder-cloud`, `home-inventory` | How do Firestore and Firebase Auth behave from Node inside the Home Assistant add-on, on aarch64 and amd64: memory use, reconnecting after a drop, custom-token sign-in? |
| S4 | `larder-app` | Can a Capacitor shell load a Larder web build, reach a Docker Larder on the home network, and sign in through Home Assistant's own login page? Set up App Attest and Play Integrity with App Check. |
| S5 | `larder-app`, `home-inventory` | How long does encrypting and decrypting a big household take on a mid-range phone? |
| S6 | `home-inventory` | Can the integration pass Larder's whole API through Home Assistant, photos and live updates included? Can it tell whether a request came from the home network or through Nabu Casa? |

Decisions needed first: D1, D2, D5, D20 and D22.

**Done when:** each spike is reported to the owner, those decisions are made, and drafting of `cloud-link` has started.

### M1 — Ready to link

- `home-inventory`:
  - numbered changes
  - applying changes as of a time, done once
  - home-only data
  - history sorted by when things were made
- `larder-cloud`: `cloud-link` 0.x, with conformance tests against the emulators.

**Done when:**
- The storage contract tests cover numbered changes, and a home-only collection can't appear in them.
- `home-inventory` and `larder-app` have agreed `cloud-link` 0.x.

### M2 — Linked

The owner's first milestone.
- `larder-cloud`:
  - the project, in its location
  - the rules
  - functions to create a household and for Larder's sign-in
  - one connection per household
  - presence and snapshots
  - web app hosting and limits
- `home-inventory`:
  - the Cloud link module: Settings → Larder Cloud (link with a code, status, waiting changes)
  - records up, changes down, presence
  - working from the add-on
  - the web app bundle in each release
- `larder-app`: a first version, through TestFlight and Play internal testing, that scans the code and links the household.

**Done when:**
- A Larder running as the Home Assistant add-on is linked from its own settings using the app, and so is a Docker Larder.
- Its records are in Larder Cloud and stay up to date, including after Larder has been off.
- A change put in Larder Cloud (from the app's test screen or the conformance tests) is done at home within seconds, or when Larder comes back.

### M3 — The app, at home and away

The owner's second milestone.
- `home-inventory`:
  - routes as data
  - phone mode
  - Larder's core in the browser, with offline copies running on it too
  - the integration's passthrough for Larder's whole API, and Sign in with Home Assistant for the app
  - setting up a phone with a code, for Docker and the Pi box
  - removing a phone
  - the web app's third way to reach Larder (the phone's copy), with the sync bar and waiting changes
- `larder-app`:
  - three routes: at home (through Home Assistant, or straight to Larder), through Larder Cloud, and no connection
  - the phone's copy
  - loading the version home runs
  - setting up a phone, and finding Larder again after its address changes
- `larder-cloud`:
  - registering and removing phones
  - phone sign-in
  - the household key for each phone, changed when one is removed

**Done when:**
- The app, signed in with Home Assistant, works three ways: on the home Wi-Fi through Home Assistant, through Larder Cloud on 4G, and with no connection at all. The add-on's port stays closed.
- A change made on 4G while Larder is off arrives at home when it's back.
- A phone can be removed, after which it can't read anything new.

### M4 — Everyone in the house

- Changes show straight away, and every phone agrees.
- The clash rules, and the "Count both?" check.
- Switching off a phone or person from anywhere.
- Phone clock checks.
- "Sign out your phones too?" on a password change.

**Done when:**
- Two phones with Larder off agree.
- Every clash rule has a test.
- A lost phone can be switched off from another phone while Larder is off.

### M5 — In the stores

- Plans through the stores, with the free plan first.
- App Check enforced.
- The free plan guards.
- A privacy notice, and deletion.
- Store listings and review.
- Larder Cloud in a browser, for laptops.

**Done when:** anyone can install the app, link their Larder (the add-on, Docker or the Pi box) on the free plan, and delete everything again.

### M6 — Plug and play

- AI reads, with the free 100 a month.
- Drive backups.
- The Claude connector through Larder Cloud.
- Notifications.
- Share to Larder.
- Native scanning.
- The live view away from home, once B1 is done.

**Done when:**
- A new household gets 100 AI reads without a key of its own.
- A backup lands in Drive and restores.
- The Claude app reaches Larder through Larder Cloud.

### Track B — Automations and the Larder Pi box

This runs alongside the main track whenever there's time. Only the live view away from home (M6) waits for it.

#### B0 — Try

Spike S1, run by `larder-pi`, `larder-automations` and `larder-provider-tesco`: does Chromium on a Pi 4, with the extension, read Tesco favourites without being blocked? This also covers the add-on case, since Home Assistant often runs on a Pi. It decides how automations run on Linux.

#### B1 — Automations on any device

- `larder-automations` and the providers:
  - Linux support, a Home Assistant add-on and a Docker service
  - pairing without tokens
  - sign-in details
  - "Needs you"
  - the run trail and live view
  - contract 1.5 and the signed catalogue
- `home-inventory`:
  - Settings → Automations
  - sign-in details encrypted for the device
  - "Needs you"
  - the run trail, and live view at home
  - a module hook for connections that stay open

**Done when:** with Larder running as the Home Assistant add-on, the Larder Automations add-on fills a Tesco basket by itself, set up and watched entirely from Larder.

#### B2 — The Larder Pi box

- `larder-pi`: the image, Wi-Fi set-up, updater and system helper.
- `larder-automations`: packaging for the Pi.
- `home-inventory`: the Pi box's settings, signed tarballs, and a listener for the AI routes only (Tailscale Funnel).

**Done when:** a freshly flashed Pi:
- joins the Wi-Fi and opens at `larder.local`
- fills a Tesco basket by itself
- updates itself, and rolls back a bad update

### Later

- Restore a new Larder from the cloud.
- HTTPS at home without Tailscale (D15).
- The whole virtual screen through noVNC on a Pi.
- A "Larder only" image for a Zero 2 W.
- The assistant answering while home is offline (D9).

## 7. What depends on what

| This | Needs |
|---|---|
| Linking (M2) | Numbered changes, as-of, done once and home-only data (`home-inventory` M1); `cloud-link` (`larder-cloud` M1) |
| Web app hosting (`larder-cloud` M2) | The web app bundle in each release (`home-inventory` M2, `releases`) |
| The app's local and offline routes (M3) | Larder's core in the browser and `local-enrolment` (`home-inventory` M3) |
| The app talking to the add-on at home (M3) | The integration's passthrough (`home-inventory` M3) and spike S6 |
| Changes showing straight away (M4) | The app's three routes (M3) |
| Plans (M5) | The cost model (`larder-cloud` M0) |
| Live view away from home (M6) | Live view (B1) and the relay (`larder-cloud` M6) |
| Settings → Automations (`home-inventory` B1) | Contract 1.5 and `live-view` (`larder-automations` B1) |
| The Pi box (B2) | Spike S1 (B0), signed tarballs (`releases`), `pi-system` |

## 8. Board items

The items noted during the design conversation, and where they now live.

| # | Item | Repos | Milestone |
|---|---|---|---|
| 1 | SQLite `synchronous = FULL` | `home-inventory` | Now |
| 2 | Merging two items into one | `home-inventory` | Now |
| 3 | Sharing shopping ticks as they happen (D17) | `home-inventory` | Now |
| 4 | History sorted by when things were made | `home-inventory` | M1 |
| 5 | A cloud change marked done in the same transaction as its writes | `home-inventory` | M1 |
| 6 | Household members, each with their own sign-in | `home-inventory`, `larder-cloud`, `larder-app` | M3 |
| 7 | Phone clocks checked against Firebase's | `larder-cloud`, `larder-app` | M4 |
| 8 | "Count both?" for the same purchase from two phones | `home-inventory` | M4 |
| 9 | Phones listed under each person, each removable | `home-inventory` | M3 |
| 10 | Switching off a phone or person from anywhere | `larder-cloud`, `larder-app`, `home-inventory` | M4 |
| 11 | Changing the household key when someone is removed | `home-inventory`, `larder-cloud` | M3 |
| 12 | Change password: "Sign out your phones too?" | `home-inventory` | M4 |
| 13 | Controlling providers from Larder: sign-in details, "Needs you", pairing | `larder-automations`, `home-inventory` | B1 |
| 14 | Larder Cloud as an AI reader, with a monthly allowance | `larder-cloud`, `home-inventory` | M6 |
| 15 | Households created only from the app, with four proofs | `larder-cloud`, `larder-app`, `home-inventory` | M2 |
| 16 | Free plan guards | `larder-cloud`, `larder-app` | M5 |
| 17 | Run automations on this device | `larder-automations`, `home-inventory` | B1 |
| 18 | Devices and Providers lists, with a signed catalogue | `home-inventory`, `larder-automations` | B1 |
| 19 | Sign-in details encrypted in the browser for the device; write-only in Larder | `larder-automations`, `home-inventory` | B1 |
| 20 | Where a Linux device keeps the key to sign-in details (D11) | `larder-automations`, `larder-pi` | B1, B2 |
| 21 | Spike: Tesco from Chromium on a Pi | `larder-pi`, `larder-automations`, `larder-provider-tesco` | B0 |
| 22 | A screenshot trail for every run | `larder-automations`, `home-inventory` | B1 |
| 23 | Live view, with Take control and Hand back | `larder-automations`, `home-inventory` | B1 |
| 24 | The live view relay, encrypted end to end | `larder-cloud` | M6 |
| 25 | A module hook for connections that stay open | `home-inventory` | B1 |
| 26 | The whole virtual screen through noVNC on a Pi | `larder-pi`, `larder-automations` | Later |

## 9. Risks

| Risk | What we do about it |
|---|---|
| The phone and home disagree | Home always wins; a parity test compares them |
| Firebase from Node inside the add-on (memory, reconnecting) | Spike S3 |
| Home Assistant restarting (an update, say) cuts the app's route at home for a minute | The app uses its copy, or Larder Cloud |
| The passthrough has to carry photos and live updates through Home Assistant | Spike S6 |
| A Home Assistant backup restored on another machine looks like a second home for the household | One connection per household; Larder Cloud asks before moving it |
| SD cards and power cuts | `synchronous = FULL`; an SSD or a UPS helps |
| Losing the household key | Home holds it; an optional recovery key |
| Free plan abuse (anyone can run a Larder) | The free plan guards (M5) |
| Store review (downloaded web code, apps that wrap a website) | Real native features, and clear review notes |
| Costs | Budget alerts, per-household limits, a cost model (`larder-cloud` M0) |
| UK GDPR | A privacy notice, deletion, Google's terms, a European location |
| The shops' bot checks against Chromium on Linux (track B) | Spike S1; a Mac stays an option for each provider |
| The shops' terms (track B) | D19 |

## 10. Getting started

For the owner:
1. Create the private repos `agent-hub` (with this hub in it), `larder-cloud` and `larder-app`. `larder-pi` can wait for track B.
2. Add the snippet from `templates/AGENTS-snippet.md` to each repo's `AGENTS.md` or `CLAUDE.md`.
3. Decide D1, D2, D5, D20 and D22.
4. Start a session for each agent, each with its own repo and this hub:
   - `home-inventory`: its Now tasks, then spikes S2 and S6
   - `larder-cloud`: set-up, spike S3 and the cost model
   - `larder-app`: spikes S4 and S5
5. Start track B (`larder-automations`, the providers, `larder-pi`) whenever there's time.
