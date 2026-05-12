# DOORS

Five-player cooperative puzzle-room game. The table progresses through ten
rooms by solving puzzles together. Each room: a puzzle appears, the team
discusses externally (Discord), the team votes one player to deliver the
answer. The deliverer loses 3 points regardless of outcome; -5 if wrong.
The puzzle stays on screen until somebody answers correctly, then the
table advances. Reach 0 points → eliminated. Clear room 10 → win.

## Run

```
npm install
npm start
```

Defaults to port 3000; on the droplet the systemd unit pins it to 3400
behind nginx at `/doors/`. See `deploy/README.md`.
