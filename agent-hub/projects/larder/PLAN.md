# Plan: Larder at home, in the cloud, on a phone and on a Pi

The plan for the Larder project. Every agent reads this, then its brief in `agents/`. The owner changes this file; agents suggest changes by message (see `PROTOCOL.md`).

1. What we're building
2. Principles
3. Repos and agents
4. How it fits together
5. Design: sync, what works where, people, phones and keys, sign-up and plans, automations, cloud services, the Larder Pi box, security and privacy
6. Milestones
7. What depends on what
8. Board items
9. Risks
10. Getting started

## 1. What we're building

Larder runs at home today, on a Raspberry Pi, a NAS or as a Home Assistant add-on, with the shopping automations running on a Mac. This project adds four things:

- **Larder Cloud:** one Firebase project for every household.
  - It keeps a copy of each household, so the app works away from home, even when home is offline.
  - It passes changes back to Larder at home.
  - It offers plug-and-play services: AI reads with no key of your own, backups to Google Drive, the Claude connector from anywhere, and a live view of the automations.
- **The Larder app**, in the App Store and Google Play. It's Larder's own web app in a native shell, which:
  - finds Larder at home and talks to it directly on the home Wi-Fi
  - goes through Larder Cloud everywhere else
  - opens with no connection at all
- **The Larder Pi box:** an image to flash onto a Raspberry Pi. It sets up its own Wi-Fi, runs Larder and the shopping automations, and updates itself.
- **Automations on any device:** Larder Automations and the shop providers run on the Pi box or a Mac, and are controlled entirely from Larder.

## 2. Principles

1. **Larder at home is the source of truth.** Larder Cloud keeps a copy and a queue. It never runs Larder's rules.
2. **Changes go up as API requests; results come down as records.** "Used 2 milk" is `POST /stock/use`, and Larder at home applies it through its own API.
3. **One front end.** The same Larder web app runs on the Pi, in the app and in Larder Cloud. Only how it reaches Larder changes. No feature is built twice.
4. **The phone runs the version home runs.** The app and Larder Cloud load the version of the web app that Larder at home reports.
5. **Adding access needs the home network; taking it away works from anywhere.**
6. **Secrets stay where they're used:**
   - Passwords live only on the Pi.
   - Shop sign-in details live only on the automations device.
   - Larder Cloud's own keys live only in Larder Cloud.
   - Records and changes in the cloud are encrypted end to end (D2).
7. **Repos meet only at contracts.** Each contract is versioned, owned by one agent and has conformance tests on both sides.
8. **One agent per repo; the owner decides.**

## 3. Repos and agents

| Repo | | What it is | Agent |
|---|---|---|---|
| `home-inventory` | existing, public | Larder: core, server, web app, modules, the Home Assistant add-on and integration | `home-inventory` |
| `larder-automations` | existing | The automations hub, today a Mac menu bar app with a Chrome extension | `larder-automations` |
| `larder-provider-tesco` | existing | The Tesco provider | `larder-provider-tesco` |
| `larder-provider-toolstation` | existing | The Toolstation provider | `larder-provider-toolstation` |
| `larder-cloud` | new | The Firebase project: rules, functions, hosting, the live view relay | `larder-cloud` |
| `larder-app` | new | The store app: a Capacitor shell around Larder's web app | `larder-app` |
| `larder-pi` | new | The Pi image, Wi-Fi set-up, updater and system helper | `larder-pi` |
| `agent-hub` | new | This hub: plan, contracts, status, messages | `coordinator` (optional) |

## 4. How it fits together

```
Phone or laptop, anywhere
  The Larder app, or Larder Cloud in a browser
  └ Larder's web app, the version home runs,
    with Larder's core answering from the phone's copy

        ↑ changes (API requests)      ↓ records

Larder Cloud: one Firebase project, every household
  Auth         phones sign in with keys the Pi registered
  Firestore    records · changes · members and phones
  Realtime DB  is home connected?
  Storage      snapshots · photos
  Hosting      /v/<version>/ web apps
  Functions    households · sign-in · AI reads · Drive · MCP
  Cloud Run    live view relay

        ↑ records (every write, numbered)   ↓ changes

Larder at home: the Pi box, a Home Assistant add-on or Docker
  Larder, with the Cloud link module
  └ Larder Automations: on this Pi, or a paired Mac
    └ providers: Tesco, Toolstation

At home on the Wi-Fi, the app talks to Larder directly.
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
- With no signal, a change waits on the phone (Firestore keeps it) and goes when there's signal. At home, the app hands it to the Pi over Wi-Fi.
- The Pi applies changes in the order they reach Firestore:
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

**Durability:** SQLite runs with `synchronous = FULL`. The Pi reports a change done only once it's on disk.

### What works where

| | Away, home connected | Away, home offline |
|---|---|---|
| Search, items, places, lists, scenarios, recipes, prices, purchases | ✔ | ✔ as of the last sync |
| Add, use, move, edit, shopping list, ticking off a shop | ✔ | ✔ shown now, done when home's back |
| Scanning | ✔ | Known barcodes ✔; new ones need home |
| Add by photo, receipts | ✔ | ✔ through Larder Cloud's AI reads |
| Start a shop, slots, fill basket | ✔ | Waits, if you choose |
| Live view of the automations | ✔ | ✗ |
| Household settings, module switches | ✔ | ✔ waits |
| Settings with secrets, shop sign-in details | ✔ encrypted | ✗ |
| Adding people and phones | Home only | Home only |
| Switching off a phone or person | ✔ | ✔ |

Home Assistant, NFC, MQTT and assistants keep talking to Larder at home directly. The Larder you open at home is unchanged.

### People, phones and keys

- **The Pi is the only place people exist.** Accounts, usernames, passwords and roles belong to Larder and are managed in Settings → Accounts, as today. Larder Cloud only knows:
  - the household
  - each person's Larder id, name and role
  - each phone's public key
- **Setting up a phone happens at home only.**
  1. On the home Wi-Fi, the app finds Larder and the person signs in with their Larder username and password.
  2. The phone proves it's at home by quoting the code Larder is announcing on the network that minute. Checking the address alone isn't enough, because tunnels and Docker can make outside requests look local.
  3. The phone makes a key pair. The private half stays in its secure chip, optionally behind Face ID or a fingerprint.
  4. Larder registers the phone with Larder Cloud, and gives it the household key locked to the phone's key.
  5. Admins see a notice: "Alex added a Pixel 8 at 19:42 · Remove".
- **Signing in to Larder Cloud.** The phone signs a challenge. A function checks it against the phones Larder registered and returns a Firebase custom token naming the household, person, role and phone. Firebase then keeps the phone signed in, and Larder Cloud can cancel that at any time.
- **Removing someone** happens on the Pi:
  - Larder Cloud cancels that person's sessions and refuses new ones.
  - The household key changes. The new key reaches the remaining phones through the cloud, locked to each phone's own key.
  - Their app wipes its copy as soon as it's told.
  - Nothing new is readable on their phones straight away, and within the hour they can't reach Firebase at all. What their phones already had stays on them.
- **Switching off a phone or a person** works from anywhere (admins only), even with the Pi offline. The Pi confirms it when it's back. Keys are per phone, so a lost phone can go without removing the person.
- **Usernames, passwords and roles** change on the Pi only. Phones use keys, not the password, so **Change password** asks "Sign out your phones too?".
- **Laptops:** Larder's own page at home shows a short-lived code under **Add this computer**, which you type into Larder Cloud on that computer. The key then lives in that browser.
- **The Home Assistant add-on:** people need Larder accounts, as offline copies already do.
- **No-login mode:** Larder Cloud needs accounts switched on.
- **No email or Google sign-in.** Recovery means going home and signing in again. A new phone is set up at home (D16).

### Sign-up and plans

- **Sign-up happens only from the Larder app at home.** There's no sign-up page anywhere. The one function that creates a household needs all four of:
  1. the Pi's signature
  2. proof it's the genuine app on a real phone (App Check, using App Attest or Play Integrity)
  3. the code Larder is announcing at home
  4. a store purchase, or a claim to the free plan

  The Pi's own web page can't pass the app check, so the app is the only way in.
- **After sign-up, Larder Cloud has three ways in:**
  - the Pi, with its key
  - the phones the Pi added, with their keys
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

### Automations

**Where they run.** Larder Automations runs on any paired device: the Larder box itself (Settings → Automations → **Run automations on this device**), a Mac, or another computer.
- On the same device it's a separate service or container, never part of Larder. That way:
  - shop passwords stay out of Larder's data and backups
  - a browser visiting shop websites is kept apart from the inventory
  - it can crash or update without touching Larder
- How it's installed:
  - Home Assistant add-on: a second add-on.
  - Docker: a second service.
  - The Pi box: already installed.
- The Pi is always on, so it never needs waking, and Home Assistant isn't needed for shopping.

**Settings → Automations:**

```
Run automations on this Pi                  [On]

Devices
  This Pi          Larder Automations 1.6   Ready
  Mac mini                                  Asleep · woken when needed
  + Add a device

Providers
  Tesco         on This Pi    shop: Tesco          Signed in · s•••@gmail.com
  Toolstation   on Mac mini   shop: Toolstation    Needs you: sign in again
  + Add a provider
```

- **Adding a device:** Larder finds it on the home network, you press **Allow** on the device, and they swap keys. There's no address or token to copy.
- **Providers** come from a catalogue the project publishes and signs. The device installs and updates them itself. To add one, pick it, pick the device, link a Larder shop and enter the sign-in details.
- **Shop sign-in details:**
  - They're encrypted in the browser for that device before they leave it.
  - Larder and Larder Cloud pass them on without being able to read them.
  - The device keeps them encrypted: in the Keychain on a Mac, or with the key kept elsewhere on a Pi (D11).
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

### Cloud services

- **AI reads** (`ai-lookups`):
  - Larder Cloud is the first reader in Settings → AI ("63 of 100 left this month"), ahead of the household's own Claude or Gemini key.
  - Larder at home, or a phone when home is offline, sends the photo.
  - A function checks the plan and this month's count, reads the photo with Larder Cloud's key (from Secret Manager), records the read in the same transaction as the count, and answers in the AI module's own format.
  - Photos aren't kept. Web searches cost more (D10).
- **Google Drive backups:**
  - Larder Cloud owns one verified Google client that only asks for the files it creates (`drive.file`).
  - The Pi makes and encrypts the backup (the database and photos, each photo only once) and uploads it straight to a "Larder backups" folder using a short-lived pass. The last 30 are kept.
  - Restore happens when setting up a new Larder, using the household key from a phone or a backup password.
  - Home Assistant users can already back up to Drive through Home Assistant.
- **The Claude connector:**
  - Larder Cloud's MCP address passes each request to Larder's own `/mcp` at home and brings back the answer.
  - Connector sign-in is approved at home (D14).
  - It works whenever home is connected; while home is offline, the assistant says so (D9).
- **Live view relay:** a small Cloud Run service. The Pi and the phone both connect out to it.
- **Notifications:** "Needs you", basket filled, running low.
- **Secrets in the cloud**, all in collections no app can read:

  | Secret | Kept as |
  |---|---|
  | The Pi's credential, connector tokens | hashes |
  | Google Drive sign-ins | encrypted with Cloud KMS |
  | Subscriptions | held by RevenueCat |
  | Larder Cloud's own keys | Secret Manager |

  Never in the cloud: passwords, usernames, shop sign-in details, households' own AI keys, or Gmail sign-ins.

### The Larder Pi box

This brings in the Pi plan from the owner's other chat, reconciled with the rest of this plan.

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
  - Where the Pi keeps the shop sign-in key is D11.
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

M2 and M3 run side by side once M1 is done. Each agent's brief breaks its part down into tasks.

### M0 — Decide and try

Try the risky parts first, and make the decisions that shape M1.

| Spike | Who | Question |
|---|---|---|
| S1 | `larder-pi`, `larder-automations`, `larder-provider-tesco` | Does Chromium on a Pi 4, with the extension, read Tesco favourites without being blocked? This decides whether the image needs a desktop session. |
| S2 | `home-inventory` | Can Larder's core, running in a browser, answer every page of the example household? |
| S3 | `larder-cloud`, `home-inventory` | How do Firestore and Firebase Auth behave from Node on a Pi: memory use, reconnecting after a drop, custom-token sign-in? |
| S4 | `larder-app` | Can a Capacitor shell load a Larder web build and reach a Larder on the home network? Set up App Attest and Play Integrity with App Check. |
| S5 | `larder-app`, `home-inventory` | How long does encrypting and decrypting a big household take on a mid-range phone? |

Decisions needed first: D1, D2, D5, D12, D20.

**Done when:** each spike is reported to the owner, those decisions are made, and drafting of `cloud-link` and automations 1.5 has started.

### M1 — Foundations

There's no cloud yet; each piece is useful on its own.
- `home-inventory`:
  - routes as data
  - numbered changes
  - applying changes as of a time, done once
  - home-only data
  - phone mode
  - Larder's core in the browser, with offline copies running on it
- `larder-automations` and the providers: Linux support, pairing, sign-in details, "Needs you", the run trail, live view, contract 1.5.
- `larder-cloud`: `cloud-link` 0.x, with conformance tests.

**Done when:**
- Offline copies run on Larder's core in the browser, with every page and search working.
- A provider on Linux is paired without tokens and can be watched live.
- The contract drafts are agreed.

### M2 — The Larder Pi box

- `larder-pi`: the image, Wi-Fi set-up, updater and system helper.
- `larder-automations`: the signed catalogue, and packaging for the Pi, the add-on and Docker.
- `home-inventory`:
  - Settings → Automations
  - live view at home
  - the Pi box's settings
  - a listener that serves only the AI routes
  - signed releases

**Done when:** a freshly flashed Pi:
- joins the Wi-Fi and opens at `larder.local`
- fills a Tesco basket by itself, and can be watched live from Larder
- updates itself, and rolls back a bad update

### M3 — Larder Cloud, first version

- `larder-cloud`: the project, rules, functions, presence, snapshots, hosting, limits and privacy.
- `home-inventory`:
  - phone set-up at home
  - the Cloud link module
  - people and phones
  - the web app's third way to reach Larder
- `larder-app`:
  - the shell
  - finding home
  - setting up a phone
  - the three routes: at home, through Larder Cloud, no connection
  - sign-up on the free plan

**Done when:**
- A household signs up from the app at home.
- Something added in Tesco reaches home within seconds.
- With the Pi off, a change waits and arrives when the Pi is back.
- A second person can be added at home and removed again.

### M4 — Away from home, properly

- Changes show straight away, and every phone agrees.
- The clash rules, and the "Count both?" check.
- Switching off a phone or person from anywhere.
- Phone clock checks.
- Larder Cloud in a browser, for laptops.

**Done when:**
- Two phones with the Pi off agree.
- Every clash rule has a test.
- A lost phone can be switched off from another phone while the Pi is off.

### M5 — Plug and play

- Plans and purchases.
- AI reads, with the free 100 a month, and the free-plan guards.
- Live view away from home.
- Drive backups.
- The Claude connector through Larder Cloud.
- Notifications.
- Share to Larder.

**Done when:**
- A new household gets 100 AI reads without a key of its own.
- A paid plan unlocks the rest.
- A stuck shop can be fixed from a phone on 4G.
- A backup lands in Drive and restores.

### Later

- Restore a new Pi from the cloud.
- HTTPS at home without Tailscale (D15).
- The whole virtual screen through noVNC on a Pi.
- A "Larder only" image for a Zero 2 W.
- The assistant answering while home is offline (D9).

## 7. What depends on what

| This | Needs |
|---|---|
| The app (M3), offline copies on the core | Larder's core in the browser (`home-inventory` M1) |
| The Cloud link module (M3) | Numbered changes and done-once (`home-inventory` M1); `cloud-link` (`larder-cloud` M1) |
| The app's set-up, and creating a household (M3) | `local-enrolment` (`home-inventory` M3) |
| Settings → Automations and live view (`home-inventory` M2); packaging (`larder-pi` M2) | Contract 1.5 and `live-view` (`larder-automations` M1) |
| The Pi image and updater (`larder-pi` M2); web app hosting (`larder-cloud` M3); the app's bundles (`larder-app` M3) | `releases` (`home-inventory` M2) |
| The Pi box's settings in Larder (`home-inventory` M2) | `pi-system` (`larder-pi` M2) |
| Whether the image has a desktop session (`larder-pi` M2) | Spike S1 |
| Live view away from home (M5) | The relay (`larder-cloud` M5) |

## 8. Board items

The items noted during the design conversation, and where they live.

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
| 12 | Change password: "Sign out your phones too?" | `home-inventory` | M3 |
| 13 | Controlling providers from Larder: sign-in details, "Needs you", pairing | `larder-automations`, `home-inventory` | M1, M2 |
| 14 | Larder Cloud as an AI reader, with a monthly allowance | `larder-cloud`, `home-inventory` | M5 |
| 15 | Households created only from the app at home, with four proofs | `larder-cloud`, `larder-app`, `home-inventory` | M3 |
| 16 | Free plan guards | `larder-cloud`, `larder-app` | M5 |
| 17 | Run automations on this device | `larder-automations`, `larder-pi`, `home-inventory` | M2 |
| 18 | Devices and Providers lists, with a signed catalogue | `home-inventory`, `larder-automations` | M2 |
| 19 | Sign-in details encrypted in the browser for the device; write-only in Larder | `larder-automations`, `home-inventory` | M1, M2 |
| 20 | Where a Pi keeps the key to sign-in details (D11) | `larder-automations`, `larder-pi` | M2 |
| 21 | Spike: Tesco from Chromium on a Pi | `larder-pi`, `larder-automations`, `larder-provider-tesco` | M0 |
| 22 | A screenshot trail for every run | `larder-automations`, `home-inventory` | M1, M2 |
| 23 | Live view, with Take control and Hand back | `larder-automations`, `home-inventory` | M1, M2 |
| 24 | The live view relay, encrypted end to end | `larder-cloud` | M5 |
| 25 | A module hook for connections that stay open | `home-inventory` | M2 |
| 26 | The whole virtual screen through noVNC on a Pi | `larder-pi`, `larder-automations` | Later |

## 9. Risks

| Risk | What we do about it |
|---|---|
| The phone and home disagree | Home always wins; a parity test compares them |
| Firestore's SDK on a Pi (memory, reconnecting) | Spike S3 |
| The shops' bot checks against Chromium on a Pi | Spike S1; a Mac stays an option for each provider |
| A Pi's resources | One shop at a time; a Pi 5 recommended |
| SD cards and power cuts | `synchronous = FULL`; an SSD or a UPS helps |
| Losing the household key | Home holds it; an optional recovery key |
| Free plan abuse (anyone can run a Larder) | The free plan guards (M5) |
| Store review (downloaded web code, apps that wrap a website) | Real native features, and clear review notes |
| The shops' terms | D19 |
| Costs | Budget alerts, per-household limits, a cost model (`larder-cloud` M0) |
| UK GDPR | A privacy notice, deletion, Google's terms, a European location |

## 10. Getting started

For the owner:
1. Create the private repos `agent-hub` (with this hub in it), `larder-cloud`, `larder-app` and `larder-pi`.
2. Add the snippet from `templates/AGENTS-snippet.md` to each repo's `AGENTS.md` or `CLAUDE.md`.
3. Decide D1, D2, D5, D12 and D20.
4. Start a session for each agent, each with its own repo and this hub:
   - `home-inventory`: its Now tasks
   - `larder-automations`, `larder-provider-tesco` and `larder-pi`: spike S1
   - `larder-cloud`: set-up, and S3
   - `larder-app`: S4
