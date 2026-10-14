# Deploy — DOORS on platformvv.com

Deploys alongside Platform, Auction, Level 0, and AC/DC on the same droplet.

## What this adds

- A new Node service on **port 3400** (binds to `127.0.0.1`)
- A new nginx `/doors/` route
- A new DOORS tile on the landing hub

## Ports in use

- `8080` — Platform
- `3100` — Auction
- `3200` — Level 0
- `3300` — AC/DC
- `3400` — DOORS (new)

## One-time setup on the droplet

```bash
# 1. Clone the repo
sudo git clone https://github.com/AntillaX/doors.git /opt/doors
cd /opt/doors
sudo npm ci --omit=dev

# 2. Install the systemd unit
sudo cp deploy/doors.service /etc/systemd/system/doors.service
sudo systemctl daemon-reload
sudo systemctl enable --now doors
sudo systemctl status doors   # should show "active (running)"

# 3. Add the nginx route
sudo nano /etc/nginx/sites-available/vv
# Paste the contents of deploy/nginx-snippet.conf inside the server { ... }
# block, next to the /acdc/ block.

# 4. Test & reload nginx
sudo nginx -t && sudo systemctl reload nginx

# 5. Refresh the landing hub (now includes the DOORS tile)
#    The updated hub HTML is in the Auction repo's deploy/hub/index.html.
#    Once that is deployed:
sudo cp /opt/auction/deploy/hub/index.html /var/www/vv/index.html
```

## Auto-deploy

Once enabled, anything merged to `main` is live within about two
minutes, without anyone touching the droplet — the same setup as
Level 0.

A systemd timer runs `deploy/deploy.sh` every two minutes and the
script decides whether there's anything to do:

- **No new commits** — exits immediately, no restart.
- **A game is in progress** — defers and tries again next tick. Rooms
  live in memory, so a restart mid-game would end it. After 45 minutes
  of waiting it deploys anyway. "In progress" comes from
  `GET /api/status` on the local port, which reports counts only.
- **`package-lock.json` changed** — reinstalls dependencies first.
- **The checkout isn't on `main`** — switches it to `main` (the clone
  may have been made from GitHub's old default branch).

`GET /doors/api/status` also reports the commit that's running, so
"is it live yet?" can be answered from a phone browser.

### Enabling it

From the DigitalOcean web console (**Droplets → your droplet →
Access → Launch Droplet Console**):

```bash
cd /opt/doors
sudo git fetch origin && sudo git checkout main && sudo git pull --ff-only origin main
sudo cp deploy/doors-autodeploy.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo /opt/doors/deploy/deploy.sh --force      # deploy what's on main now
sudo systemctl enable --now doors-autodeploy.timer
```

Check it:

```bash
systemctl list-timers doors-autodeploy   # next run time
sudo systemctl start doors-autodeploy    # force a check right now
journalctl -u doors-autodeploy -n 30     # what it did
```

Turn it off with `sudo systemctl disable --now doors-autodeploy.timer`;
deploys go back to being manual with the same script.

## Updating by hand

Always available, whether or not the timer is enabled:

```bash
sudo /opt/doors/deploy/deploy.sh          # deploy if main has moved
sudo /opt/doors/deploy/deploy.sh --force  # deploy even if it hasn't
```

It fast-forwards `/opt/doors` to the latest `main`, reinstalls
dependencies only if `package-lock.json` changed, restarts
`doors.service`, and verifies the service came back up.

## Layout on the droplet

```
/opt/doors/
  server.js
  server/
    Game.js
    Room.js
    Player.js
    PuzzleBank.js
    PuzzleSelector.js
    data/
      puzzles.json
  public/
    index.html
    app.js
    style.css
```
