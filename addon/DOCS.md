# Larder

What you've got, and where. A home inventory for everything in the house: food, household stuff, pet supplies, tools, fuel, batteries, emergency supplies, and renewals like insurance.

## Getting started

1. Start the add-on and turn on **Show in sidebar**. It installs the matching Larder integration in Home Assistant (no HACS needed), and Home Assistant asks you to restart: do that once (Settings → System → Restart).
2. Open **Larder** from the sidebar. You're signed in as your Home Assistant user. Everyone with a Home Assistant login sees it, admins or not. To keep Larder's settings, accounts and modules to some of you, list them under **Larder admins** in the options.
3. Home Assistant offers to set up the **Larder** integration (Settings → Devices & services → Discovered). Click **Configure**.

Updating the add-on updates the integration too, with one more restart. If you'd rather install the integration with HACS, turn off **Install the Home Assistant integration** in the options. That adds the sensors, actions and events, and links NFC tags and batteries.

New to Larder? Turn on **Load the example household** in the options, restart, and look around. Turn it off again once you start adding your own things (it only fills an empty Larder).

## Scanning with the phone camera

Cameras need an https address. Opening Larder through Home Assistant (the companion app, or Nabu Casa) already is one, so camera scanning works there. USB and Bluetooth barcode scanners work anywhere.

## With no connection

A phone can keep Larder, and a copy of what's in it saved each day, for when the Wi-Fi or internet is down: Larder still opens and offers **Load data from** with the copies on the phone. Opened from the Home Assistant sidebar or app, it can't: the app has to reach Home Assistant before it shows Larder. So give Larder its own https address:

1. Open port 8080 in the **Network** section and put it behind Tailscale, a Cloudflare Tunnel or your reverse proxy, for an https address.
2. In Larder, make an account for each person (Settings → Accounts).
3. On each phone, open that address in the browser, sign in and add it to the home screen. **Settings → Offline copies** shows the copies and says whether the phone can use them with no connection.

More: <https://github.com/doonetheprune/home-inventory/blob/main/docs/running.md#with-no-connection>

## Backups

Home Assistant backups include all of Larder's data: items, stock, places, shops, recipes, history, settings (AI keys and the Gmail sign-in too) and photos, as long as your backups include add-ons. Larder stops while Home Assistant copies it (usually a few seconds) and then starts again, so the copy is always complete; its sensors show as unavailable meanwhile.

## Options

- **Log level**: how much goes in the log.
- **Larder's own backups**: off by default, because Home Assistant backups already include Larder's data.
- **Address for QR labels**: an https address printed on QR labels, so a phone's camera app can open them.
- **Load the example household**: example items to try Larder with.
- **Larder admins**: Home Assistant usernames who can change Larder's settings; empty means everyone.
- **Modules that stay off**: module ids that can't be switched on in the app.
- **Extra settings**: advanced; any other `LARDER_` setting.

The **Network** section can open port 8080 for MCP clients, scripts and Node-RED outside Home Assistant. They need an access token from Larder's Settings.

## AI assistants

Larder's MCP server lets Claude, ChatGPT, Gemini or a local model look things up and update stock. Through Home Assistant the address is `https://<home-assistant>/api/larder/mcp`: in the Claude app, add it as a custom connector, log in to Home Assistant and allow it; tools like Claude Code send a Home Assistant long-lived access token instead. Setup for each assistant: <https://github.com/doonetheprune/home-inventory/blob/main/docs/mcp.md>

## More

Sensors, actions, events, NFC tags and battery linking: <https://github.com/doonetheprune/home-inventory/blob/main/docs/home-assistant.md>
