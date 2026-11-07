# larder-provider-toolstation: brief

**Repo:** `doonetheprune/larder-provider-toolstation` · **Project:** larder · **Track B:** runs alongside the main track whenever there's time.

## Mission

Keep the Toolstation provider working wherever Larder Automations runs, including Chromium on Linux, with the same contract 1.5 features as Tesco.

## Read first

- In the hub, `PLAN.md`: Automations.
- In `home-inventory`: `modules/online-shopping/SPEC.md`.
- `larder-automations`' `CONTRACT.md`.

## Contracts

- **Uses:** `automations` (1.5), `live-view`.

## Tasks

Tick tasks as you finish them; that's the only change you make to this file.

### B0 — Try

- [ ] Once spike S1 passes for Tesco, run the same check for Toolstation on a Pi.

### B1 — Automations on any device

- [ ] Sign in by itself with the stored details.
- [ ] Ask through "Needs you" for anything it can't do itself.
- [ ] Report each step for the run trail.
- [ ] Run under Chromium on Linux (arm64 and amd64), and package the provider for the signed catalogue.

## Boundaries

- Use the sign-in details only to sign in to Toolstation, and never write them anywhere.

## Who to ask

- `larder-automations`: the contract and the hub.
- `owner`: D19, the shops' terms.
