---
name: local-enrolment
owner: home-inventory
consumers: [larder-app, larder-cloud]
version: 0.3
status: draft
---

# Contract: local-enrolment

How the app sets up a phone with Larder at home, and how a household is linked. There are two ways in: **Sign in with Home Assistant** for the add-on, and **a code from Larder's settings** for Docker and the Pi box. Both finish the same way.

## Agreed so far

### The Home Assistant add-on: Sign in with Home Assistant

- This reuses the sign-in the Larder integration already gives MCP connectors (`custom_components/larder/oauth.py`).
- The app finds Home Assistant on the home network, or the person types its address. It opens Home Assistant's own login page, then a page asking "Allow the Larder app to use Larder?".
- The integration only shows that page when the sign-in comes from the home network, not through Nabu Casa or another outside address.
- Larder then issues a Larder token for that Home Assistant user, never a Home Assistant token. The app can use Larder through Home Assistant, but nothing else in Home Assistant.
- After that, every request goes through the integration's passthrough at `/api/larder/v1/…` on Home Assistant's address, with the Larder token passed on as it is (as `/api/larder/mcp` does). The add-on's own port stays closed.

### Docker and the Pi box: a code from Larder's settings

- Signed in to Larder as usual, a person opens Settings → Larder app → **Add a phone**. Larder shows a code (a QR code) that lasts a few minutes and works once. It holds:
  - Larder's addresses on the home network
  - the fingerprint of Larder's own key, so the app can tell it's talking to that Larder and not a look-alike
  - a one-time secret tied to the person who asked for it
  - the household's id, if it's linked
- The app connects to one of those addresses, checks Larder's key, and sends the secret.
- Larder checks the secret, and checks that the request came straight from the home network, not through a proxy, tunnel or Larder Cloud.

### Either way

- The app sends the phone's public key.
- Larder answers with:
  - the person and the phone's id
  - a Larder token for that person
  - the household key, encrypted for the phone's key
- If the household is linked, Larder registers the phone with Larder Cloud.
- Admins see a notice that a phone was added.

### Linking a household

Linking uses a one-time code too, scanned from Settings → Larder Cloud → **Link**, or passed straight to the app for an admin signed in through Home Assistant. The app sends the code to Larder Cloud with App Check and the plan, Larder sends it with its signature, and Larder Cloud checks they match.

### Other cases

- **Laptops:** a code from Larder's settings, typed into Larder Cloud in a browser on that computer.
- **Finding Larder again** after an address changes:
  - Larder reports its addresses through Larder Cloud: for the add-on, Home Assistant's home and outside addresses.
  - The app also tries `homeassistant.local`, or `_larder._tcp` where Larder announces it.
- **No-login mode:** accounts must be switched on first.

## To write in M3

- the passthrough's exact paths, and how it carries photos and live updates (spike S6)
- the app's sign-in details: client registration and the "Allow" page
- the code's exact format, and how long it lasts
- how "from the home network" is checked, in Home Assistant and in Docker
- rate limits and errors
- tests

## Changes

- 0.3 (2026-11-07): the add-on goes through Home Assistant: Sign in with Home Assistant and a passthrough for Larder's API. The add-on's port stays closed, and codes are only for Docker and the Pi box.
- 0.2 (2026-11-07): a code from Larder's settings replaced typing a username and password.
- 0.1 (2026-11-07): first draft.
