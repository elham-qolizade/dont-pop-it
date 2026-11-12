# Don't Pop It · نترکونش

One balloon, shared by everyone online. Every click pumps it. It pops at a secret size, and nobody knows when.

- Click for a puff, hold for a bigger breath (up to +20).
- Every safe pump grows your streak. Bank it for points (streak²), or pop the balloon and lose it all.
- When it pops, everyone gets an obituary: who did it, from which city, how long it lived, and how close you were. The one who popped it is stamped **GUILTY**.
- English and Persian (فارسی), with right-to-left layout.

## Run

Needs only Node.js 18+. No dependencies.

```bash
node server.js
```

Open http://localhost:8790.

### Options (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8790` | Port to listen on |
| `POP_MIN` | `20` | No balloon pops before this many pumps |
| `POP_SCALE` | `90` | Average balloon size above `POP_MIN`, per 5 people online |
| `DEMO_BOTS` | `0` | Simulated players from random cities, for trying the game alone. **Local testing only:** never show fake players as real ones in production. |

Try it busy:

```bash
DEMO_BOTS=10 node server.js
```

## How it works

- `server.js`: Node's `http` module. Server-Sent Events push state to browsers; `POST /pump` and `POST /bank` take actions. The server owns the balloon and its secret pop point, so browsers cannot peek or cheat. Each player can pump at most once every 300 ms.
- `public/index.html`: the whole client, plain HTML/CSS/JS. Sounds are synthesized with the Web Audio API; share images are drawn on a canvas.
- City names come from Cloudflare's `cf-ipcity` header when deployed behind Cloudflare, and from the browser's time zone otherwise.

State lives in memory, so records reset when the server restarts.
