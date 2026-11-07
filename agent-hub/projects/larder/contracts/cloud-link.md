---
name: cloud-link
owner: larder-cloud
consumers: [home-inventory, larder-app]
version: 0.1
status: draft
---

# Contract: cloud-link

How Larder at home, the phones and Larder Cloud share a household. This draft records what was agreed in the design conversation; `larder-cloud` writes the rest in M1, with `home-inventory` and `larder-app`.

## Agreed so far

**Who's who.**
- A household has one Larder at home (the Pi) and any number of people (Larder accounts), each with phones.
- Firebase custom tokens carry `hid`, plus one of:
  - `pi: true`, for Larder at home
  - for a phone: `person` (the Larder user id), `role` and `phone`
- Phones sign in by signing a challenge with a key the Pi registered. The Pi signs in with its own key.
- There are no usernames, passwords or email addresses in the cloud.

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
- Realtime Database `presence/{hid}`: whether home is connected, and since when.
- Storage `households/{hid}/snapshots/{seq}`: compressed and encrypted.

**Records up.**
- Every write at home has a number.
- The Pi sends the latest version of each changed record in batches, with `upTo` updated in the same batch.
- A removed record becomes a `gone` marker. Markers are cleared after a few months; a phone away longer than that starts again from a snapshot.
- History entries are only ever added, and kept for 12 months (D4).

**Changes down.**
- The Pi applies changes in the order they reach Firestore, as of `madeAt`, with ids made from the change id, and never twice.
- Statuses: `waiting`, `done`, `couldnt` (with a reason and options), `overtaken`, `needs-look`, `switched-off`.
- `live` changes need an answer now (start a shop, an unknown barcode). They expire quickly if home isn't connected.

**Clash rules.** As in `PLAN.md`, Sync.

**Encryption (D2).**
- AES-GCM with the household key.
- Envelope: `{ v, key, iv, data }`, where `key` is the household key's version.
- When someone is removed, there's a new key version, delivered through `keys/`.

**The live view.** It doesn't go through Firestore: see `live-view` and the Cloud Run relay.

## To write in M1

- exact field types and limits
- function signatures and errors
- the security rules
- the snapshot format
- conformance tests for both sides, run against the emulators

## Changes

- 0.1 (2026-11-07): first draft, from the design conversation.
