---
name: local-enrolment
owner: home-inventory
consumers: [larder-app, larder-cloud]
version: 0.1
status: draft
---

# Contract: local-enrolment

How the app finds Larder at home, proves it's at home, and sets up a phone.

## Agreed so far

- **Announcing.** Larder announces `_larder._tcp` on the home network (mDNS), with:
  - its name and version
  - whether it's linked to Larder Cloud
  - a code that changes every minute, worked out from a household secret and the time
- **Setting up a phone** happens only on the home network.
  - The app sends the person's Larder username and password, the phone's public key, and the current code.
  - Larder checks the code, and checks that the request came straight from the home network, not through a proxy, tunnel or Larder Cloud.
  - Larder registers the phone with Larder Cloud.
  - It answers with the person, the phone's id, and the household key encrypted for the phone's key.
- **Checking it's the right Larder.** Before sending a password, the app checks it's talking to the Larder it found, using a challenge signed with Larder's own key.
- **Laptops:** Larder's own page at home shows a short-lived code under **Add this computer**, which you type into Larder Cloud on that computer.
- **Home Assistant add-on:** needs Larder accounts.
- **No-login mode:** accounts must be switched on first.
- **Creating a household** uses the same code. The app and the Pi both send it, so Larder Cloud knows they're together.

## To write in M3

- endpoints and formats
- how "straight from the home network" is checked under Docker and Home Assistant
- rate limits and errors
- tests

## Changes

- 0.1 (2026-11-07): first draft.
