# Running Larder on its own

Larder runs anywhere Docker runs: a Raspberry Pi 4, a Synology or Unraid NAS, an old laptop, or a small cloud server. It needs very little memory and keeps everything in one folder.

## Quick start (Docker Compose)

```yaml
services:
  larder:
    image: ghcr.io/doonetheprune/home-inventory:latest
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./larder-data:/data
    environment:
      LARDER_AUTH: local
```

```bash
docker compose up -d
```

Open `http://<your-server>:8080`. The first visit asks you to create the household's admin account. Want to look around first? Set `LARDER_DEMO: "true"` to load the example household into an empty Larder, or use Settings → Data → Load the example household.

The image is published by the release workflow when a version tag (for example `v0.1.0`) is pushed. Until then, build it yourself with `docker build -t larder .` or `docker compose build`.

## Without Docker

Needs Node.js 22.13 or newer.

```bash
npm ci
npm run build
LARDER_DATA_DIR=/var/lib/larder npm start
```

## HTTPS (needed for camera scanning)

Browsers only allow the camera on a secure (https) address. Typing codes and USB scanners work without it. Easy options:

- **Tailscale**: install it on the server and your phones, then use `tailscale serve 8080` for an `https://<machine>.<tailnet>.ts.net` address. Nothing is opened to the internet.
- **Cloudflare Tunnel**: a free `https://larder.yourdomain` address without opening ports on your router.
- **A reverse proxy** you already run (Caddy, Nginx Proxy Manager, Traefik) with a certificate.
- **Home Assistant**: from Phase 2, the add-on is served through Home Assistant (and Nabu Casa), which is already HTTPS.

Behind Tailscale, a tunnel or a proxy, set `LARDER_TRUST_PROXY` to the proxy's address (for example `127.0.0.1` for Tailscale or a proxy on the same machine, or `172.16.0.0/12` for one in Docker), so Larder knows the connection is https and who is signing in. Without it, Larder ignores `X-Forwarded-*` headers, because anyone could send them.

Set `LARDER_BASE_URL` to the https address so QR labels point to it.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `LARDER_PORT` | `8080` | Port to listen on |
| `LARDER_HOST` | `0.0.0.0` | Address to listen on |
| `LARDER_DATA_DIR` | `./data` (`/data` in Docker) | Database, photos and backups |
| `LARDER_AUTH` | `local` | `local`: household accounts and access tokens. `none`: no login, for trusted networks only. `homeassistant`: set by the add-on (Home Assistant users through ingress, tokens otherwise) |
| `LARDER_STORAGE` | `sqlite` | `sqlite`, or `memory` (lost on restart; for testing) |
| `LARDER_BASE_URL` | none | Your public address, used in QR labels and links |
| `LARDER_DEMO` | `false` | Load the example household into an empty Larder on start |
| `LARDER_BACKUP_EVERY_HOURS` | `24` | Automatic backups (0 turns them off) |
| `LARDER_BACKUPS_TO_KEEP` | `7` | How many automatic backups to keep |
| `LARDER_MODULES_DISABLED` | none | Comma-separated module ids that are always off |
| `LARDER_MODULE_<ID>_<KEY>` | | Settings for a module, e.g. `LARDER_MODULE_LOOKUP_OPENFOODFACTS_URL`, or for MQTT: `LARDER_MODULE_MQTT_URL` (`mqtt://host:1883`), `_USERNAME`, `_PASSWORD`, `_TOPIC` |
| `LARDER_LOG_LEVEL` | `info` | `debug` also logs every request |
| `LARDER_TRUST_PROXY` | off | Reverse proxies to believe about `X-Forwarded-*`: addresses or ranges (comma-separated), a number of hops, or `true` for any |

## Accounts and tokens

- The first account is an admin. Admins can add people (Settings → Accounts), change household settings and switch modules on and off.
- **Access tokens** (Settings → Access tokens) are for Claude (MCP, Phase 3), Home Assistant (Phase 2), Node-RED and scripts. Send `Authorization: Bearer <token>`. Tokens are shown once and stored hashed.

## Backups and moving

- Automatic backups go to `/data/backups` (a consistent copy made with SQLite `VACUUM INTO`). Settings → Data → Back up now makes one straight away.
- Settings → Data → Export downloads everything as one JSON file that doesn't depend on the storage back end.
- To move to another machine, copy the data folder.

## Updating

Pull the new image and restart: `docker compose pull && docker compose up -d`. Database migrations run automatically on start.
