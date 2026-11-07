---
name: local-enrolment
owner: home-inventory
consumers: [larder-app, larder-cloud]
version: 0.2
status: draft
---

# Contract: local-enrolment

How the app sets up a phone with Larder at home, and how a household is linked. It works the same for the Home Assistant add-on, Docker and the Pi box.

## Agreed so far

- **The set-up code.** Signed in to Larder as usual (with a Larder password, or through Home Assistant), a person opens Settings → Larder app → **Add a phone**. Larder shows a code (a QR code) that lasts a few minutes and works once. It holds:
  - Larder's addresses on the home network: for the add-on, the Home Assistant machine's address and the add-on's own port
  - the fingerprint of Larder's own key, so the app can tell it's talking to that Larder and not a look-alike
  - a one-time secret tied to the person who asked for it
  - the household's id, if it's linked
- **Finishing at home:**
  1. The app connects to one of those addresses and checks Larder's key.
  2. It sends the one-time secret and the phone's public key.
  3. Larder checks the secret, and checks that the request came straight from the home network (not through a proxy, tunnel or Larder Cloud). This proves the phone is at home.
  4. Larder answers with:
     - the person and the phone's id
     - an access token for Larder's own port
     - the household key, encrypted for the phone's key
  5. If the household is linked, Larder also registers the phone with Larder Cloud.
- **The add-on** needs its own port open on the home network for this (D21). D23 covers what happens if it stays closed. People who sign in through Home Assistant need no Larder password (D22).
- **Linking a household** uses the same kind of code, shown under Settings → Larder Cloud → **Link**. The app sends it to Larder Cloud with App Check and the plan, Larder sends it with its signature, and Larder Cloud checks they match.
- **Laptops:** the same code, typed into Larder Cloud in a browser on that computer.
- **Finding Larder again** after its address changes:
  - Larder reports its current addresses through Larder Cloud.
  - Where it can, it also announces `_larder._tcp` on the network; the add-on can only do this with host networking.
  - Neither is part of set-up's security.
- **No-login mode:** accounts must be switched on first.

## To write in M3

- the code's exact format, and how long it lasts
- endpoints and answers
- how "straight from the home network" is checked under Docker and Home Assistant (spike S6)
- rate limits and errors
- tests

## Changes

- 0.2 (2026-11-07): a code from Larder's settings replaces typing a username and password and the code announced on the network, so the add-on and Home Assistant users work the same as everyone else.
- 0.1 (2026-11-07): first draft.
