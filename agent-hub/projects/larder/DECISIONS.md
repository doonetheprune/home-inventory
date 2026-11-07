# Decisions: larder

The owner's decisions for this project. Agents ask in a `decision` message to `owner`; the owner, or the coordinator on the owner's behalf, records the answer here. Larder's own product decisions stay in `docs/DECISIONS.md` in `home-inventory`.

## Made

From the design conversation, November 2026:

- **One household per Larder at home.** One Pi, add-on or Docker install is one household in Larder Cloud.
- **People exist only on the Pi.**
  - A household can have several people, each a Larder account.
  - Phones are set up only on the home network, by signing in to the Pi.
  - The Pi tells Larder Cloud who's been added or removed.
  - Usernames and passwords are changed only on the Pi and never sent to Firebase.
- **Larder Cloud sign-up happens only from the Larder app at home**, never from a web page, so the Firebase side stays locked down.
- **Automations can run on the Larder box itself:** "Run automations on this device", with Devices and Providers lists in Larder's settings.
- **Shop sign-in details are typed into Larder and sent to Larder Automations to keep.** Larder never stores them.
- **Larder shows the automations' browser:** screenshots of where a run stopped, and a slim live view.
- **Plug and play:** Larder Cloud supplies the AI keys. The free cloud plan includes 100 product lookups a month, counted centrally.
- **A Larder Pi image, as its own project** (`larder-pi`), including the Wi-Fi set-up plan.
- **A Larder app in the stores**, built as Capacitor around Larder's own web app.
- **One agent per repo**, coordinated through this hub.

## Needed

Each has a recommendation. Tick one when it's decided, and say what was chosen.

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
- [ ] **D11. Where a Pi keeps the key to shop sign-in details.**
  - Recommendation: Larder Cloud holds the key for cloud households, so a stolen SD card on its own is no use.
  - A TPM board as an option.
  - On the SD card only as a last resort, with a warning.
- [ ] **D12. Main hardware.** Recommendation: Pi 5, with a 4 GB Pi 4 also supported.
- [ ] **D13. The Wi-Fi set-up page.** Recommendation: comitup's own page at first; a Larder-branded one later.
- [ ] **D14. Approving the Claude connector.** Recommendation: on the home network only.
- [ ] **D15. HTTPS at home without Tailscale**, using a certificate authority per box. Recommendation: leave it until later; the app and Tailscale cover most people.
- [ ] **D16. Setting up a new phone.** Recommendation: at home only, with a key per phone. Passkeys, which move with the person's Apple or Google account, could come later.
- [ ] **D17. Shopping ticks.** Recommendation: send each tick as it happens, so two people shopping at once see each other's. Today ticks are sent all together when you press Done.
- [ ] **D18. Signing releases.** Recommendation: minisign. It's simple, and the Pi can check signatures with no extra services.
- [ ] **D19. The shops' terms.** Recommendation: check Tesco's and Toolstation's terms before any store listing or website offers them.
- [ ] **D20. How agents use this hub.** Recommendation:
  - messages, status and ticks are pushed straight to `main`
  - the plan, briefs, contracts and decisions change by pull request
