# Homelab for Raycast

Your whole homelab in one Raycast extension: server stats, downloads, media requests,
uptime monitors, music, photos, audiobooks, ebooks, DNS, containers, backups and money.
Twenty-three commands, one **Home** hub that ties them together, and a menu bar item.

Every service is optional. Configure the ones you run, leave the rest empty, and the
extension hides them.

> This extension is **not** in the Raycast Store. It ties together twenty self-hosted
> apps in one hub, which the store does not accept. You install it from source
> (two commands, below) and it behaves exactly like a store extension afterwards.

## Screenshots

<p align="center"><img src="docs/screenshots/home-commands.jpg" width="800" alt="Homelab Home — the hub"></p>

| | |
|---|---|
| **Homelab Stats** — CPU, memory, uptime, NAS pool, drive temps<br><img src="docs/screenshots/stats.jpg"> | **Top processes** — the same view scrolled down<br><img src="docs/screenshots/stats-processes.jpg"> |
| **Homelab Downloads** — qBittorrent and SABnzbd live<br><img src="docs/screenshots/downloads.jpg"> | **Disk Health** — Scrutiny SMART for every host<br><img src="docs/screenshots/disk-health.jpg"> |
| **Discover Media** — Jellyseerr trending and search<br><img src="docs/screenshots/discover-media.jpg"> | **Request from the grid** — all seasons or a profile<br><img src="docs/screenshots/discover-actions.jpg"> |
| **Request History** — approve, decline, retry<br><img src="docs/screenshots/request-history.jpg"> | **Continue Watching** — Jellyfin resume and next up<br><img src="docs/screenshots/continue-watching.jpg"> |
| **Media Calendar** — upcoming releases from the arr stack<br><img src="docs/screenshots/media-calendar.jpg"> | **Subtitles** — sync queue and Bazarr wanted list<br><img src="docs/screenshots/subtitles.jpg"> |
| **Nudge Subtitles** — shift one file by ±ms<br><img src="docs/screenshots/nudge-subtitles.jpg"> | **Music Library** — Navidrome albums with cover art<br><img src="docs/screenshots/music-library.jpg"> |
| **Album tracks** — format, bitrate, length<br><img src="docs/screenshots/album-tracks.jpg"> | **Audiobooks** — Audiobookshelf library<br><img src="docs/screenshots/audiobooks.jpg"> |
| **Ebooks** — Calibre-Web with Send to Kindle<br><img src="docs/screenshots/ebooks.jpg"> | **Send to MeTube** — clipboard URL to a folder<br><img src="docs/screenshots/send-to-metube.jpg"> |
| **Notifications** — ntfy messages with detail pane<br><img src="docs/screenshots/notifications.jpg"> | **Containers** — Komodo stacks, restart from Raycast<br><img src="docs/screenshots/containers.jpg"> |
| **AdGuard Home** — protection toggle, stats, top blocked<br><img src="docs/screenshots/adguard.jpg"> | **Add Transaction** — Firefly Pico assistant parses "cg resto 400"<br><img src="docs/screenshots/add-transaction.jpg"> |

<p align="center"><img src="docs/screenshots/raycast-search.jpg" width="800" alt="All commands are searchable from the Raycast root"></p>

## Commands

| Command | What it does |
|---|---|
| **Homelab Home** | One place for everything: live status rows, every command, quick links. Esc returns here. |
| **Homelab Stats** | CPU, memory, disks, uptime, temperatures, NAS pool, top processes |
| **Homelab Menu Bar** | CPU load and temperature in the macOS menu bar, alerts when something is down |
| **Homelab Downloads** | qBittorrent, SABnzbd and slskd activity, pause and resume |
| **Discover Media** | Browse trending and popular, search, and request movies and shows in Jellyseerr |
| **Request History** | Pending and past Jellyseerr requests: approve, decline, retry, delete |
| **Continue Watching** | Jellyfin now playing, resume, next up |
| **Media Calendar** | Upcoming movies, episodes and albums from the arr stack, plus stuck queues |
| **Search Indexers** | Prowlarr search across every indexer, grab straight to your download client |
| **Subtitles** | Bazarr wanted list and the sync queue |
| **Nudge Subtitles** | Shift one subtitle file by a few ms, undo, unpin |
| **Music Library** | Navidrome albums with cover art, search |
| **Photos** | Immich browse, smart search, on-this-day memories |
| **Audiobooks** | Audiobookshelf continue listening, browse, search |
| **Ebooks** | Calibre-Web search, download, send to Kindle |
| **Send to MeTube** | Queue a video or audio download from the URL on your clipboard |
| **Homelab Monitors** | Uptime Kuma: what is down right now |
| **Notifications** | ntfy messages from the last seven days |
| **Disk Health** | Scrutiny SMART status for every disk |
| **Containers** | Komodo stacks: state, restart, start, stop |
| **AdGuard Home** | Protection toggle, query stats, top blocked, recent log, blocklists |
| **Upcoming Bills** | Firefly III month spend and subscriptions due |
| **Add Transaction** | Firefly Pico quick entry with templates |

## Requirements

- macOS with [Raycast](https://raycast.com)
- [Node.js](https://nodejs.org) 20 or newer (`brew install node`)
- Network access to your services. Over Tailscale or a VPN is fine, the extension only
  needs to reach the URLs you configure.

## Install

```sh
git clone https://github.com/<you>/raycast-homelab.git
cd raycast-homelab
npm ci
npm run build
```

`npm run build` compiles the extension and registers it with Raycast permanently. You do
not need to keep a terminal open. To update later:

```sh
git pull && npm run build
```

Keep the folder where it is. Raycast links to the build output inside it.

## Configure

There are two ways to enter URLs and keys. They can be mixed.

### 1. Raycast preferences

Open any command, press `⌘K` → **Configure Extension**. Every service has a URL field and
its credential fields. Fill in the ones you run.

### 2. Env file

Copy the example and fill it in:

```sh
mkdir -p ~/.config/raycast-homelab
cp .env.example ~/.config/raycast-homelab/.env
```

Keys are the preference names in `UPPER_SNAKE` form (`JELLYFIN_URL`, `JELLYFIN_API_KEY`).
A value entered in the Raycast preferences always wins over the file, so the file is a
good place for the long list of URLs while secrets stay in Raycast, or the other way
round. The file path itself is a preference (**Env File**) if you want it elsewhere.

The env file is read once per command launch. After editing it, re-run the command.

### Settings by service

| Service | Settings | Where to find the credential |
|---|---|---|
| Glances | `GLANCES_URL`, `STORAGE_MOUNT` | No auth. Glances v4 API. `STORAGE_MOUNT` is an extra mount point to show beside `/`. |
| Temperatures | `TEMPS_URL` | Optional JSON published by the companion `temps-publish` script (see below) |
| Dashboard | `HOMEPAGE_URL` | Link only (Homepage, Dashy, anything) |
| TrueNAS | `TRUENAS_URL`, `TRUENAS_API_KEY` | Credentials → Local Users → API Keys |
| qBittorrent | `QBIT_URL`, `QBIT_USERNAME`, `QBIT_PASSWORD` | Web UI login |
| SABnzbd | `SABNZBD_URL`, `SABNZBD_API_KEY` | Config → General → API Key |
| slskd | `SLSKD_URL`, `SLSKD_API_KEY` | Options → Web → Authentication → API keys |
| Jellyfin | `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID` | Dashboard → API Keys. User ID optional. |
| Jellyseerr | `JELLYSEERR_URL`, `JELLYSEERR_API_KEY` | Settings → General → API Key |
| Radarr / Sonarr / Lidarr | `RADARR_URL`, `RADARR_API_KEY` (same for Sonarr, Lidarr) | Settings → General |
| Chaptarr / Readarr | `CHAPTARR_URL`, `CHAPTARR_API_KEY` | Settings → General. Any Readarr-compatible fork. |
| Prowlarr | `PROWLARR_URL`, `PROWLARR_API_KEY` | Settings → General |
| Bazarr | `BAZARR_URL`, `BAZARR_API_KEY` | Settings → General |
| Subtitle sync server | `SUBSYNC_URL` | Companion script, see below |
| Audiobookshelf | `ABS_URL`, `ABS_TOKEN` | Settings → Users → your user → API token |
| Navidrome | `NAVIDROME_URL`, `NAVIDROME_USER`, `NAVIDROME_PASSWORD` | Any user. Subsonic token auth. |
| Immich | `IMMICH_URL`, `IMMICH_API_KEY` | Account Settings → API Keys |
| Calibre-Web | `CALIBRE_URL`, `CALIBRE_USER`, `CALIBRE_PASSWORD` | Web UI login |
| MeTube | `METUBE_URL`, `METUBE_FOLDERS` | No auth. Folders: `name\|Label[\|video],…` |
| Uptime Kuma | `KUMA_URL`, `KUMA_STATUS_SLUG` or `KUMA_API_KEY` | Status page slug needs no key. Settings → API Keys for all monitors. |
| ntfy | `NTFY_URL`, `NTFY_TOPICS` | Comma-separated topics |
| AdGuard Home | `ADGUARD_URL`, `ADGUARD_USERNAME`, `ADGUARD_PASSWORD` | Web UI login |
| Komodo | `KOMODO_URL`, `KOMODO_API_KEY`, `KOMODO_API_SECRET` | Settings → Profile → API keys |
| Backrest | `BACKREST_URL`, `BACKREST_USERNAME`, `BACKREST_PASSWORD` | Web UI login |
| Scrutiny | `SCRUTINY_URL` | No auth |
| Speedtest Tracker | `SPEEDTEST_URL` | Legacy open `/api/speedtest/latest` endpoint |
| Firefly III | `FIREFLY_URL`, `FIREFLY_TOKEN` | Options → Profile → OAuth → Personal Access Tokens |
| Firefly Pico | `PICO_URL` | Same token as Firefly III |
| Subscriptions | `SUBSCRIPTIONS_URL` | Optional JSON from the companion `firefly-sub-publish` script |
| Forgejo / Gitea | `FORGEJO_URL` | Link only |

`.env.example` lists every key with its description. Regenerate it after changing
preferences in `package.json` with `npm run gen:env`.

## Companion scripts

Three rows depend on small server-side scripts that are not part of this repository.
Leave their URLs empty and the rows simply do not appear.

- **Temperatures** (`TEMPS_URL`): a JSON file with server CPU and disk temperatures plus
  NAS disk temperatures, published by a timer on the server. Shape:
  `{ "server": { "cpu": { "name", "temp", "warn" }, "disks": [ … ] }, "nas": { "disks": [ … ] } }`.
- **Subtitle sync server** (`SUBSYNC_URL`): a tiny HTTP status server for a subtitle sync
  queue. Powers the Subtitles status row and the Nudge Subtitles command.
- **Subscriptions** (`SUBSCRIPTIONS_URL`): a JSON summary of upcoming Firefly III bills.
  Shape: `{ "due_30d", "count_30d", "next", "items": [ { "name", "detail" } ] }`.

## Development

```sh
npm run dev        # build, install and hot-reload on save
npm run typecheck  # tsc
npm run lint       # ray lint (macOS only); npm run lint:local runs eslint anywhere
npm run gen:env    # regenerate .env.example from package.json
```

Each service lives in its own `src/<service>-api.ts` module. Views are the `.tsx` files
of the same name. `src/config.ts` is the only place settings are read; every module goes
through `setting()`, `optionalUrl()` and `requireUrl()` from there, so no hostname ever
appears in the source.

## Security notes

- Secrets are stored by Raycast in its preferences store, or in your env file if you use
  one. Nothing is sent anywhere except to the services you configure.
- qBittorrent is never contacted while its password is empty: it bans an IP after five
  failed logins, and behind a reverse proxy that bans the whole host.
- Audiobookshelf and Immich thumbnails embed the API key in the image URL, which is how
  their APIs work. Those requests stay between Raycast and your server.

## License

MIT, see `LICENSE`.
