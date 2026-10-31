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
