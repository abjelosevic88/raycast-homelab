# Homelab Raycast Extension

Server + NAS stats in Raycast, mirroring the Homepage stats row: CPU load, RAM,
system/storage SSDs, uptime, tank pool capacity, and all temperatures.

Two commands:

- **Homelab Stats** — full list view (Server + NAS sections)
- **Homelab Menu Bar** — CPU % and CPU temp in the macOS menu bar, refreshed every minute

## Data sources (all read-only, over the tailnet)

| Data | Source |
|---|---|
| CPU / RAM / disks / uptime | Glances v4 API via `https://glances.bjelke.org` (Caddy) |
| Temperatures (server + NAS drives) | `temps.json` published by `temps-publish.timer`, via `https://home.bjelke.org/images/temps.json` (Caddy → Homepage) |
| NAS pool free/total + health | TrueNAS API `/api/v2.0/pool` via `https://nas.bjelke.org` (Bearer key) |

No server-side changes were needed; everything reuses what Homepage already polls.

## Setup on the Mac

Requires Raycast and Node ≥ 20 (`brew install node` if missing). Tailscale must be up.

```sh
git clone ssh://git@git.bjelke.org:2222/Homelab/raycast-homelab.git
cd raycast-homelab
npm ci
npm run dev
```

`npm run dev` registers the extension in Raycast with hot reload. After the first
run it stays installed even without the dev server (`npm run build` for a
permanent build). On first launch Raycast asks for the extension preferences —
the Glances/temps/TrueNAS URLs are pre-filled; paste the TrueNAS API key
(same one as `HOMEPAGE_VAR_TRUENAS_KEY` in `~/homepage/.env` on the server).
Leave the key empty to simply hide the NAS pool row.

## Development

Code lives on the server in `~/raycast-homelab`, pushed to Forgejo. Typecheck
with `npm run typecheck` (the `ray` CLI itself is macOS/Windows-only, so the
live preview only works on the Mac — edit here, `git pull` there, Raycast
hot-reloads).
