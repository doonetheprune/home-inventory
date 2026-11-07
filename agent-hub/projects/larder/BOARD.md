# Board: larder

Built by `scripts/board.mjs` from the briefs, status files, messages, decisions and contracts. Don't edit it by hand.

Latest status update: 2026-11-07.

## Waiting for the owner

Decisions (from `DECISIONS.md`):

- D1. Run Larder's core on the phone
- D2. End-to-end encryption of records and changes
- D3. Photos in the cloud
- D4. History kept in the cloud
- D5. Where Firestore stores the data
- D6. How far behind Larder at home can be
- D7. A public service, and also bring-your-own Firebase project
- D8. Names
- D9. The assistant answering while home is offline
- D10. Plans and prices
- D11. Where a Linux device keeps the key to shop sign-in details
- D12. Main hardware for the Pi box
- D13. The Pi box's Wi-Fi set-up page
- D14. Approving the Claude connector
- D15. HTTPS at home without Tailscale
- D16. Setting up a new phone
- D17. Shopping ticks
- D18. Signing releases
- D19. The shops' terms
- D20. How agents use this hub
- D22. How a phone is set up

No messages waiting.

## Blocking

Nothing is blocked.

## Agents

| Agent | State | Milestone | Now | Next | Updated | Blockers |
|---|---|---|---|---|---|---|
| `coordinator` | not-started | – | – | Optional: the owner may keep the hub themselves | 2026-11-07 | – |
| `home-inventory` | not-started | Now | – | SQLite synchronous = FULL; then spikes S2 and S6 | 2026-11-07 | – |
| `larder-app` | not-started | M0 | – | Waiting for the repo to be created; then spike S4: a Docker Larder, and signing in through Home Assistant | 2026-11-07 | – |
| `larder-automations` | not-started | B0 | – | Track B, when there's time: spike S1, with larder-pi and larder-provider-tesco | 2026-11-07 | – |
| `larder-cloud` | not-started | M0 | – | Waiting for the repo to be created; then set-up, spike S3 inside the add-on, and the cost model | 2026-11-07 | – |
| `larder-pi` | not-started | B0 | – | Track B: the repo can wait; then spike S1 and measuring a Pi 4 and a Pi 5 | 2026-11-07 | – |
| `larder-provider-tesco` | not-started | B0 | – | Track B, when there's time: spike S1 | 2026-11-07 | – |
| `larder-provider-toolstation` | not-started | B0 | – | Track B: the same check as spike S1, once it passes for Tesco | 2026-11-07 | – |

## Progress

Tasks ticked in each brief, by milestone.

| Agent | Now | M0 | M1 | M2 | M3 | M4 | M5 | M6 | B0 | B1 | B2 | Later |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `home-inventory` | 0/3 | 0/3 | 0/5 | 0/6 | 0/10 | 0/5 | 0/1 | 0/3 | – | 0/5 | 0/3 | 0/2 |
| `larder-app` | – | 0/2 | – | 0/2 | 0/4 | 0/3 | 0/3 | 0/3 | – | – | – | – |
| `larder-automations` | – | – | – | – | – | – | – | – | 0/1 | 0/9 | 0/1 | 0/1 |
| `larder-cloud` | – | 0/3 | 0/2 | 0/7 | 0/4 | 0/2 | 0/4 | 0/5 | – | – | – | 0/2 |
| `larder-pi` | – | – | – | – | – | – | – | – | 0/2 | – | 0/10 | 0/2 |
| `larder-provider-tesco` | – | – | – | – | – | – | – | – | 0/1 | 0/4 | – | – |
| `larder-provider-toolstation` | – | – | – | – | – | – | – | – | 0/1 | 0/4 | – | – |

## Open messages

None.

## Contracts

| Contract | Owner | Version | Status | Used by |
|---|---|---|---|---|
| [ai-lookups](contracts/ai-lookups.md) | larder-cloud | 0.1 | draft | home-inventory, larder-app |
| [automations](contracts/automations.md) | larder-automations | 1.4 | released | home-inventory, larder-provider-tesco, larder-provider-toolstation, larder-pi |
| [cloud-link](contracts/cloud-link.md) | larder-cloud | 0.2 | draft | home-inventory, larder-app |
| [live-view](contracts/live-view.md) | larder-automations | 0.1 | draft | home-inventory, larder-cloud, larder-app |
| [local-enrolment](contracts/local-enrolment.md) | home-inventory | 0.3 | draft | larder-app, larder-cloud |
| [pi-system](contracts/pi-system.md) | larder-pi | 0.1 | draft | home-inventory, larder-automations |
| [releases](contracts/releases.md) | home-inventory | 0.2 | draft | larder-cloud, larder-app, larder-pi, larder-automations |
| [web-transport](contracts/web-transport.md) | home-inventory | 0.2 | draft | larder-app, larder-cloud |
