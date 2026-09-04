# Changelog

## 2026-09-04 — Public release prep

- Removed every hardcoded host. All URLs and credentials now come from the extension
  preferences or an optional env file (`~/.config/raycast-homelab/.env`, see `.env.example`).
- Added a URL preference for every service (Radarr, Sonarr, Lidarr, Chaptarr, Prowlarr, Bazarr,
  Jellyfin, AdGuard Home, Komodo, Backrest, Scrutiny, Speedtest Tracker, Forgejo, dashboard).
- MeTube destinations, the extra mount point, temps JSON and subscriptions JSON are preferences.
- Views show a "not configured" empty state with a Configure Extension action instead of an error.
- Home links and browser actions only appear for services that have a URL.
- New: `npm run gen:env` regenerates `.env.example` from `package.json`.
