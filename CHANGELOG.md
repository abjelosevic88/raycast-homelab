# Changelog

## 2026-09-05 — Services & Jobs

- Added Services & Jobs for native systemd services and timers in both the system
  and SSH user's scope, with current state, last result, next run and recent logs.
- Added optional SSH host, port and identity file preferences. The bundled Python
  collector runs over SSH without installing a daemon or using sudo.
- Added explicit connection, scope and log errors, stale data indicators, and
  overdue timer status. Successful inactive oneshot jobs are shown as completed.
- Added Services & Jobs to Homelab Home and documented SSH setup and status limits.

## 2026-09-04 — Paperless Search

- Added Paperless Search for recent documents and full-text OCR search, with tags,
  correspondent, previews, browser links and original/archive downloads.
- Added optional Paperless URL and API token preferences (`PAPERLESS_URL` and
  `PAPERLESS_TOKEN`), plus a command and quick link in Homelab Home.

## 2026-09-04 — Public release prep

- Removed every hardcoded host. All URLs and credentials now come from the extension
  preferences or an optional env file (`~/.config/raycast-homelab/.env`, see `.env.example`).
- Added a URL preference for every service (Radarr, Sonarr, Lidarr, Chaptarr, Prowlarr, Bazarr,
  Jellyfin, AdGuard Home, Komodo, Backrest, Scrutiny, Speedtest Tracker, Forgejo, dashboard).
- MeTube destinations, the extra mount point, temps JSON and subscriptions JSON are preferences.
- Views show a "not configured" empty state with a Configure Extension action instead of an error.
- Home links and browser actions only appear for services that have a URL.
- New: `npm run gen:env` regenerates `.env.example` from `package.json`.
