# Caddie

© 2026 Cow Rock Construction, LLC. All rights reserved. Proprietary and confidential. No copying, reproduction,
redistribution, AI/ML training or data mining without written permission.

An offline phone web app (installed from Safari to the Home Screen) that opens on the call for where you stand: the best
club with a one-line reason and the next-best option, recalculated from GPS for any spot (a moved tee, a shot off line).

- **Engine** (`js/engine.js`): plays-like distance from the 2025 NC lidar ground (player's elevation factor table),
  temperature, wind and lie; a tree and hill check along the ball flight against the lidar canopy; water; full shots and
  layups ranked by expected strokes (tour baseline, fairway rates, in-between penalty).
- **Aim view** (`js/aim.js`): the hole in 3D from your spot with the planned flight, aim point (wind) and landing.
- **Shot log**: Ball here before each shot; Settings shows real distance per club and fairway rate off the tee, and can
  use them as your numbers.
- **Competition mode**: distances only.
- **Data** (`data/`): course geometry only, built by `cowrock-tools/golf-map/pack_phone.py` from the golf-map pipeline.
  No player data is in this repo: club numbers live on the phone (Settings, or a setup link `#setup=<base64>` that is
  read once and removed from the address bar).

Hosted on GitHub Pages. After changing any file, bump `VERSION` in `sw.js` so phones pick up the new copy.
Weather: Open-Meteo (no key), only when there is signal; otherwise the last reading or what you type in Settings.
