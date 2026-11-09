# Order emails

Larder reads shops' order and delivery emails from Gmail. An **order confirmation** puts what's coming on its way (confirming a filled basket's pending order) and takes what's unavailable off the order, so it's bought next time. A **delivered** (or "order complete") email marks that shop's delivery arrived. Set up in **Settings → Order emails**.

## Connecting Gmail

Gmail only, read-only (`https://www.googleapis.com/auth/gmail.readonly`), through the household's own Google Cloud project: Larder can't ship one shared client (reading email is a restricted scope that needs Google's paid security review for a published app). The Order emails page walks through it, with links and Copy buttons:

1. **Home Assistant's address from outside the house** (Nabu Casa's Remote control address, or the household's own, https only). Google sends people back to `<address>/api/larder/gmail/callback`, where the Larder integration passes the sign-in on to this module.
2. Make a Google Cloud project (free).
3. Turn on the Gmail API.
4. Set up Google's sign-in page: app name Larder, audience External.
5. Data access: add the `gmail.readonly` scope.
6. Audience: **Publish app**. Left in Testing, Google ends the sign-in after 7 days. Google then shows "Google hasn't verified this app", which is expected for an app only the household uses.
7. Clients: a **Web application** client with the redirect URI from step 1.
8. Paste the client ID and secret into Larder. The secret and the sign-in are kept in Larder's data folder and never sent to the app.
9. **Connect Gmail**: Google opens in a new tab (Advanced → Go to Larder → allow), then Home Assistant's page says it's connected and the Larder page notices.

Google can't limit access to a label or an address, so the page suggests a Gmail account just for Larder, with shops' emails forwarded to it. Larder itself only searches for and opens emails whose subject the household names.

**Disconnect** stops Larder reading Gmail and asks Google to forget the sign-in. Changing the address, client ID or secret signs Larder out too (Google ties the sign-in to them). If Google signs Larder out (a revoked or expired sign-in), checking stops, the page says so with **Connect Gmail again**, and `email.failed` fires.

## Which emails are which

Rules, each: a shop, **Order confirmed** or **Delivered**, words the subject contains (case doesn't matter) and, optionally, words the sender contains. Gmail is searched for just those subjects (`{subject:"…" subject:"…"} after:<time>`), and an email is only read when a rule matches it; the most particular subject wins. Emails are never read twice (their Gmail ids are kept).

- **Order confirmed:** sent to the AI module's reader (`ai.order-reader`, see modules/ai/SPEC.md). Without an AI set up, the email waits with **Read it**. Lines it's sure of (or matched before at that shop) go on the delivery as `<shop> delivery` with the order number and the day (a line's own day when it comes separately), confirming a pending order from that shop first. Unavailable lines come off that shop's pending order. Lines it isn't sure of wait on the page with **Match** (pick the item and how many of what it's bought in, so 2 boxes of tea bags bought in boxes are 2: it goes on the delivery, and the shop's name for it is remembered) and **Not in Larder**. The same order number from the same shop is never added twice (an "order updated" email says it was read already). The delivery's day and slot are kept, to watch for its delivered email.
- **Delivered:** that shop's deliveries (and pending orders) due by today arrive (`stock.arrive` with `dueBy`), so a later order from the same shop stays on its way. No AI.

## When Gmail is checked

All changeable on the page:

- **After a basket is filled** (a pending order): every 5 minutes for 2 hours, for its confirmation.
- **Around a delivery**: every 5 minutes, from 3 hours before its slot to 2 hours after. The slot comes from the order email, or from a slot booked through online shopping (`online-shopping.slot_booked`). A delivery with only a day is watched 08:00–20:00 (with the hours before and after).
- **The rest of the time**: every 3 hours (0: not at all), for orders placed outside Larder.
- **Check now** on the page, or the `check_order_emails` tool. The first check looks back three days.

Larder looks once a minute whether a check is due (`schedule.ts`: `watches` and `nextCheck`, plain functions of the time). One check runs at a time.

## Without Gmail: Claude

When Gmail isn't connected, the page also explains the alternative: connect Gmail and Larder (`<home-assistant>/api/larder/mcp`) to Claude as connectors, and ask Claude for a scheduled task with the given prompt, which uses `search`, `add_expected`, `cancel_order`, `mark_arrived` and `add_receipt` and labels what it dealt with.

## Routes

| Route | |
|---|---|
| `GET /api/v1/modules/email` | How it's set up: connected, account, address, redirect URI, client ID (not the secret), problem, rules, timing, last check and its result, the next check and why, whether an AI can read orders |
| `PUT /settings` | `{ rules?, timing? }` (admin) |
| `PUT /gmail` | `{ address?, clientId?, clientSecret? }` (admin) |
| `POST /gmail/start` | Answers `{ url }`: Google's sign-in page, with a one-off state (admin) |
| `POST /gmail/callback` | `{ state, code?, error? }` from Google, passed on by the integration. The state must be Larder's, from the last 15 minutes, unused |
| `DELETE /gmail` | Disconnect (admin) |
| `POST /check` | Check now. Answers `{ message }` |
| `GET /emails` | What was read, newest first (the last 30) |
| `POST /emails/:id/lines/:n` | `{ productId, quantity }`: match a line |
| `POST /emails/:id/lines/:n/skip` | A line that isn't in Larder |
| `POST /emails/:id/read` | Read an order confirmation no AI could read before |

## Data

`email:gmail` (the connection: address, client, sign-in tokens, problem), `email:settings` (rules and timing), `email:sign-ins` (states under way), `email:emails` (each email dealt with, by Gmail id; the latest 60 keep their lines), `email:windows` (delivery slots to watch), `email:checks` (the last check).

## Events

`email.order_read`: `{ shop, reference, coming, unavailable, to_check, delivery_date, delivery_from, delivery_to, message }`. `email.delivered`: `{ shop, arrived }`. `email.failed`: `{ message, needs_you }` (Gmail needs signing in again).

## Hooks used

`addRoute`, `addTool`, `collection`, `publish`, `on` (`online-shopping.slot_booked`), `offered` (`ai.order-reader`), `ctx.fetch` (Google), `core.stock.expect` / `cancelOrders` / `arrive` (`dueBy`) / `deliveries` / `pendingOrders`, `core.shops`, `core.products.summary`, `core.resolve.shop`, `core.settings` (time zone); on the web, a Settings panel and a page.
