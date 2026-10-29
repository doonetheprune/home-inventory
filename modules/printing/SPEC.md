# Printing

QR label sheets for places and items.

- **What to label:** a place and everything inside it (the grid set-up's 24 boxes in one go), or chosen items.
- **Layouts** (A4, measurements from the label makers' templates): Avery **L7160** (21 per sheet, 63.5 × 38.1 mm), **L7163** (14, 99.1 × 38.1 mm), **L7651** (65, 38.1 × 21.2 mm), and **plain A4 with cut lines** (24, 70 × 37.1 mm). The choice is remembered on the device. Print at 100% scale with no margins.
- **What the QR holds:** with `LARDER_BASE_URL` set, a link (`https://…/#/places/<id>`) that a phone's own camera opens; otherwise `larder:place:<id>`. Larder's scanner reads both.
- **Routes** (under `/api/v1/modules/printing`): `GET /areas` (places that have places inside them, biggest first) and `GET /labels?place=<id>&products=<id,id>` (the place first, then what's inside in code order: G1-1, G1-2 … G4-6).
- **UI:** "Label sheets" under Print in the sidebar (and in More), with a preview at the right scale. QR codes are drawn by the web SDK's `QrCode`, so any module can print them.
- **Printables from other modules:** scenario pages are in the scenarios module, using the SDK's `PrintSetup` and the `print-area` class (only that part of the screen prints).
