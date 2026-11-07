---
name: cloud-link
owner: larder-cloud
consumers: [home-inventory, larder-app]
version: 0.2
status: draft
---

# Contract: cloud-link

How Larder at home, the phones and Larder Cloud share a household. Larder at home can be the Home Assistant add-on, Docker or the Pi box. This draft records what was agreed in the design conversation; `larder-cloud` writes the rest in M1, with `home-inventory` and `larder-app`.

## Agreed so far

**Who's who.**
- A household has one Larder at home and any number of people (Larder accounts, or Home Assistant users for the add-on), each with phones.
- Firebase custom tokens carry `hid`, plus one of:
  - `home: true`, for Larder at home
  - for a phone: `person` (the Larder user id), `role` and `phone`
- Larder at home signs in with its own key. Phones sign in by signing a challenge with a key Larder registered.
- There are no usernames, passwords or email addresses in the cloud.

**Creating a household** needs all four of:
1. Larder's signature
2. App Check
3. the set-up code Larder showed in its settings and the app scanned (see `local-enrolment`)
4. a store purchase, or a claim to the free plan

There's no other way to create one.

**One connection per household.** A second Larder using the same identity (for example, a Home Assistant backup restored on another machine) is refused until the household is moved to it, which asks first.

**Firestore layout.**

| Path | Holds |
|---|---|
| `households/{hid}` | home's Larder version, `upTo` (the highest record number the cloud holds), plan, status |
| `households/{hid}/records/{kind}:{id}` | `seq`, `gone`, `data` (encrypted) |
| `households/{hid}/changes/{changeId}` | `by` (person and phone), `madeAt`, `base` (the record versions it was based on), `request` (encrypted: method, path, body), `live`, `status`, `result`, `doneAt` (a record number) |
| `households/{hid}/members/{personId}` | name, role |
| `households/{hid}/members/{personId}/phones/{phoneId}` | name, public key, added, switched off |
| `households/{hid}/keys/{phoneId}` | the household key, encrypted for that phone |

Outside Firestore:
- Realtime Database `presence/{hid}`: whether home is connected, and since when, plus the addresses Larder last reported (encrypted).
- Storage `households/{hid}/snapshots/{seq}`: compressed and encrypted.

**Records up.**
- Every write at home has a number.
- Larder sends the latest version of each changed record in batches, with `upTo` updated in the same batch.
- A removed record becomes a `gone` marker. Markers are cleared after a few months; a phone away longer than that starts again from a snapshot.
- History entries are only ever added, and kept for 12 months (D4).

**Changes down.**
- Larder applies changes in the order they reach Firestore, as of `madeAt`, with ids made from the change id, and never twice.
- Statuses: `waiting`, `done`, `couldnt` (with a reason and options), `overtaken`, `needs-look`, `switched-off`.
- `live` changes need an answer now (start a shop, an unknown barcode). They expire quickly if home isn't connected.

**Clash rules.** As in `PLAN.md`, Sync.

**Encryption (D2).**
- AES-GCM with the household key.
- Envelope: `{ v, key, iv, data }`, where `key` is the household key's version.
- When a person or phone is removed, there's a new key version, delivered through `keys/`.

**The live view** (track B) doesn't go through Firestore: see `live-view` and the Cloud Run relay.

## To write in M1

- exact field types and limits
- function signatures and errors
- the security rules
- the snapshot format
- conformance tests for both sides, run against the emulators

## Changes

- 0.2 (2026-11-07): any Larder at home, not just the Pi; households are created with the set-up code from Larder's settings; one connection per household.
- 0.1 (2026-11-07): first draft, from the design conversation.
