# Decisions: larder

The owner's decisions for this project. Agents ask in a `decision` message to `owner`; the owner, or the coordinator on the owner's behalf, records the answer here. Larder's own product decisions stay in `docs/DECISIONS.md` in `home-inventory`.

## Made

From the design conversation, November 2026:

- **The first milestones don't need the Pi box.**
  - First, any Larder links to Larder Cloud, including the one inside Home Assistant.
  - Then, the app works with any Larder both at home and through the cloud, including when Larder is the Home Assistant add-on.
  - Automations on any device, and the Pi box, are a second track that those milestones don't wait for.
- **The app reaches the Home Assistant add-on through Home Assistant's API**, signed in as a Home Assistant user, the way Larder's Claude connector already does. The add-on's own port stays closed.
- **One household per Larder at home.** One add-on, Docker or Pi install is one household in Larder Cloud.
- **People exist only in Larder at home.**
  - A household can have several people.
  - Phones are set up only on the home network, after signing in to Larder at home. D22 covers how this works for Home Assistant users.
  - Larder tells Larder Cloud who's been added or removed.
  - Usernames and passwords are changed only at home and never sent to Firebase.
- **Larder Cloud sign-up happens only from the Larder app, started in Larder's own settings**, never from a web page, so the Firebase side stays locked down.
- **Automations can run beside Larder:** "Run automations on this device", with Devices and Providers lists in Larder's settings.
- **Shop sign-in details are typed into Larder and sent to Larder Automations to keep.** Larder never stores them.
- **Larder shows the automations' browser:** screenshots of where a run stopped, and a slim live view.
- **Plug and play:** Larder Cloud supplies the AI keys. The free cloud plan includes 100 product lookups a month, counted centrally.
- **A Larder Pi image, as its own project** (`larder-pi`), including the Wi-Fi set-up plan.
- **A Larder app in the stores**, built as Capacitor around Larder's own web app.
- **One agent per repo**, coordinated through this hub.

## Needed

Each has a recommendation. Tick one when it's decided, and say what was chosen. Decisions marked **track B** can wait until that track starts.

- [ ] **D1. Run Larder's core on the phone.** Recommendation: yes. Every page then works and changes show straight away, even with home offline. The alternative is a mirror of the app's answers, like today's offline copies. That's less work in Larder, but changes made away don't show until home has done them, and only saved pages work.
- [ ] **D2. End-to-end encryption of records and changes.** Recommendation: yes, from the first cloud version. The cloud then sees only ids, numbers, sizes and times.
- [ ] **D3. Photos in the cloud.** Recommendation: smaller copies, capped by plan.
- [ ] **D4. History kept in the cloud.** Recommendation: the last 12 months.
- [ ] **D5. Where Firestore stores the data.** This can't be changed later. Recommendation: London (`europe-west2`).
- [ ] **D6. How far behind Larder at home can be** before Larder Cloud asks for an update. Recommendation: 12 months of releases.
- [ ] **D7. A public service, and also bring-your-own Firebase project.** Recommendation: both, from one codebase.
- [ ] **D8. Names.** Recommendation: Larder Cloud, Larder at home, Cloud link, the Larder app, the Larder Pi box.
- [ ] **D9. The assistant answering while home is offline.** This needs the cloud to read the records. Recommendation: not now; perhaps an opt-in later.
- [ ] **D10. Plans and prices.**
  - Recommendation for the free plan: sync, plus 100 AI reads a month without web searches.
  - Recommendation for paid plans: more reads, web searches, live view away from home, Drive backups and the Claude connector.
  - Set prices after `larder-cloud`'s cost model.
- [ ] **D11. Where a Linux device keeps the key to shop sign-in details** (track B).
  - Recommendation: Larder Cloud holds the key for cloud households, so a copied disk or backup on its own is no use.
  - A TPM board as an option on a Pi.
  - On the disk only as a last resort, with a warning.
- [ ] **D12. Main hardware for the Pi box** (track B). Recommendation: Pi 5, with a 4 GB Pi 4 also supported.
- [ ] **D13. The Pi box's Wi-Fi set-up page** (track B). Recommendation: comitup's own page at first; a Larder-branded one later.
- [ ] **D14. Approving the Claude connector.** Recommendation: on the home network only.
- [ ] **D15. HTTPS at home without Tailscale**, using a certificate authority per box. Recommendation: leave it until later; the app and Tailscale cover most people.
- [ ] **D16. Setting up a new phone.** Recommendation: at home only, with a code from Larder's settings and a key per phone. Passkeys, which move with the person's Apple or Google account, could come later.
- [ ] **D17. Shopping ticks.** Recommendation: send each tick as it happens, so two people shopping at once see each other's. Today ticks are sent all together when you press Done.
- [ ] **D18. Signing releases.** Recommendation: minisign. It's simple, and the Pi box can check signatures with no extra services.
- [ ] **D19. The shops' terms** (track B). Recommendation: check Tesco's and Toolstation's terms before any store listing or website offers them.
- [ ] **D20. How agents use this hub.** Recommendation:
  - messages, status and ticks are pushed straight to `main`
  - the plan, briefs, contracts and decisions change by pull request
- [x] **D21. The Home Assistant add-on's own port.** Decided: it stays closed (`8080/tcp: null`, as today). The app goes through Home Assistant's API instead.
- [ ] **D22. How a phone is set up.** Recommendation:
  - The Home Assistant add-on: **Sign in with Home Assistant** in the app (Home Assistant's own login, then "Allow the Larder app to use Larder?"), only from the home network.
  - Docker and the Pi box: a code shown in Larder's settings, scanned by the app, and finished on the home Wi-Fi.
  - Either way, nobody types a Larder username and password into the app, and nobody signing in through Home Assistant needs a Larder password.
- [x] **D23. If the add-on's port stays closed.** No longer needed: the app goes through Home Assistant whether the port is open or not.
