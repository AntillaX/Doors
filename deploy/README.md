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

## Updates

```bash
cd /opt/doors
sudo git pull
sudo npm ci --omit=dev   # only if package-lock.json changed
sudo systemctl restart doors
```

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
