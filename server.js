// Don't Pop It: one balloon shared by everyone online. Each click pumps it; it pops at a secret size.
// No dependencies: Node's http module, Server-Sent Events (server -> browser) and POST /pump (browser -> server).
// The server owns the balloon and its secret pop point, so a browser cannot peek or cheat.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 8790;
const PUMP_COOLDOWN_MS = 300; // per player, blocks auto-clickers
const NEXT_BALLOON_MS = 8000; // long enough to read the pop report
// Pop point = POP_MIN + POP_SCALE * sqrt(-ln U): the risk of each pump grows as the balloon grows.
// Average balloon is about POP_MIN + 0.89 * POP_SCALE pumps. Shrink POP_SCALE for quick local testing.
// POP_SCALE is per PLAYERS_PER_SCALE people online, so a balloon lasts about as long with 5 people as with 5,000.
const POP_MIN = Number(process.env.POP_MIN) || 20;
const POP_SCALE = Number(process.env.POP_SCALE) || 90; // about a minute per balloon, so every visitor sees a pop
const PLAYERS_PER_SCALE = 5;
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');

// Demo mode: DEMO_BOTS=10 adds simulated players from random cities so you can feel a busy game alone.
// Never enable this in production: showing fake players as real ones would be lying to visitors.
// TEMPORARY: demo players are on by default so the live site can be shown to a friend. Set back to 0 afterwards.
const DEMO_BOTS = process.env.DEMO_BOTS != null ? Number(process.env.DEMO_BOTS) : 10;
const DEMO_CITIES = [
  'Tokyo, Japan', 'São Paulo, Brazil', 'Lagos, Nigeria', 'Berlin, Germany', 'Toronto, Canada', 'Mumbai, India',
  'Istanbul, Türkiye', 'Mexico City, Mexico', 'Seoul, South Korea', 'Cairo, Egypt', 'Sydney, Australia', 'Paris, France',
  'Buenos Aires, Argentina', 'Nairobi, Kenya', 'Jakarta, Indonesia', 'Oslo, Norway', 'Lima, Peru', 'Bangkok, Thailand',
];

const players = new Map(); // id -> { id, city, res, lastPumpAt }
const wall = new Map(); // city -> pops
const records = { biggest: null, smallest: null, longestStreak: null, biggestBank: null };
const totals = { pumps: 0, pops: 0 };
const news = [];
let balloon = null;
let balloonSeq = 0;
let lastPop = null;
let broadcastQueued = false;

const rand = (a, b) => a + Math.random() * (b - a);

// News goes out as data ({ k, ...params }) so each browser can word it in its own language.
function addNews(item) {
  news.unshift(item);
  if (news.length > 12) news.length = 12;
}

function cityFromRequest(req, url) {
  // In production behind Cloudflare this header carries the real city; locally we fall back to the browser's time zone.
  const cf = req.headers['cf-ipcity'];
  if (typeof cf === 'string' && cf) return cf.slice(0, 40);
  const tz = url.searchParams.get('tz') || '';
  if (tz.length < 60 && /^[A-Za-z_]+\/[A-Za-z_/-]+$/.test(tz)) return tz.split('/').pop().replace(/_/g, ' ');
  return 'somewhere';
}

function send(pl, event, data) {
  pl.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function snapshot() {
  return {
    balloon: balloon && { id: balloon.id, pumps: balloon.pumps, last: balloon.last, people: balloon.people.size, ageMs: Date.now() - balloon.bornAt, danger: danger(balloon) },
    lastPop,
    online: players.size + DEMO_BOTS,
    demo: DEMO_BOTS > 0,
    wall: [...wall.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([city, n]) => ({ city, n })),
    records,
    totals,
    news,
  };
}

// Many pumps can land in the same instant, so state goes out at most once every 50 ms.
function broadcast() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  setTimeout(() => {
    broadcastQueued = false;
    const data = snapshot();
    for (const pl of players.values()) send(pl, 'state', data);
  }, 50);
}

const crowdFactor = () => Math.max(1, (players.size + DEMO_BOTS) / PLAYERS_PER_SCALE);

// Share of balloons that have already popped by this size: the honest odds, shown to players as rising danger.
function danger(b) {
  const x = (b.pumps - POP_MIN) / b.scale;
  return x <= 0 ? 0 : 1 - Math.exp(-x * x);
}

function newBalloon() {
  const scale = POP_SCALE * crowdFactor();
  balloon = {
    scale,
    id: ++balloonSeq, pumps: 0, bornAt: Date.now(), last: null, lastId: null, people: new Set(),
    stats: new Map(), // id -> { pumps, lastAt, lastNo } for the pop report
    cityPumps: new Map(), bigBreath: null,
    popAt: Math.round(POP_MIN + scale * Math.sqrt(-Math.log(1 - Math.random()))),
  };
  addNews({ k: 'ready', id: balloon.id });
}

// `pl` is the human player, when there is one: each safe pump grows their streak, popping wipes it.
const MAX_BREATH = 100;

function pump(id, city, pl, amount = 1) {
  const b = balloon;
  if (!b) return { status: 409, body: { error: 'No balloon right now. A new one is coming.' } };
  const prev = { id: b.lastId, city: b.last };
  const before = b.pumps;
  b.pumps = Math.min(b.popAt, b.pumps + amount); // a big breath that crosses the limit pops it right there
  b.people.add(id);
  b.last = city;
  b.lastId = id;
  const added = b.pumps - before;
  totals.pumps += added;
  const st = b.stats.get(id) || { pumps: 0, lastAt: 0, lastNo: 0 };
  st.pumps += added; st.lastAt = Date.now(); st.lastNo = b.pumps;
  b.stats.set(id, st);
  b.cityPumps.set(city, (b.cityPumps.get(city) || 0) + added);
  if (!b.bigBreath || amount > b.bigBreath.amount) b.bigBreath = { amount, city };
  if (b.pumps >= b.popAt) {
    const lostStreak = pl ? pl.streak : 0;
    if (pl) pl.streak = 0;
    pop(b, id, city, prev, lostStreak);
    return { status: 200, body: { popped: true, pumps: b.pumps, streak: 0 } };
  }
  if (pl) {
    pl.lastPumpNo = b.pumps;
    pl.lastPumpBalloon = b.id;
    pl.streak += amount;
    if (!records.longestStreak || pl.streak > records.longestStreak.n) records.longestStreak = { n: pl.streak, city };
  }
  const milestone = [50, 100, 250, 500, 1000].find((m) => before < m && b.pumps >= m);
  if (amount >= 15) addNews({ k: 'breath', id: b.id, city, amount });
  else if (milestone) addNews({ k: 'milestone', id: b.id, n: milestone });
  broadcast();
  return { status: 200, body: { popped: false, pumps: b.pumps, streak: pl ? pl.streak : 0 } };
}

function pop(b, id, city, prev, lostStreak) {
  balloon = null;
  totals.pops++;
  wall.set(city, (wall.get(city) || 0) + 1);
  if (!records.biggest || b.pumps > records.biggest.pumps) records.biggest = { pumps: b.pumps, city };
  if (!records.smallest || b.pumps < records.smallest.pumps) records.smallest = { pumps: b.pumps, city };
  lastPop = { id: b.id, pumps: b.pumps, city, lastSafe: prev.city, people: b.people.size, ageMs: Date.now() - b.bornAt };
  addNews({ k: 'popped', id: b.id, pumps: b.pumps, city });
  const now = Date.now();
  const [topCity, topCityPumps] = [...b.cityPumps.entries()].sort((a, c) => c[1] - a[1])[0] || [city, b.pumps];
  const ranking = [...b.stats.entries()].sort((a, c) => c[1].pumps - a[1].pumps).map(([pid]) => pid);
  Object.assign(lastPop, {
    cities: b.cityPumps.size, topCity, topCityPumps,
    bigBreath: b.bigBreath && b.bigBreath.amount > 1 ? b.bigBreath : null,
  });
  for (const pl of players.values()) {
    const you = pl.id === id;
    const st = b.stats.get(pl.id);
    send(pl, 'pop', {
      ...lastPop, you, lostStreak: you ? lostStreak : 0,
      youLastSafe: !you && pl.id === prev.id, // made the last safe pump: an accomplice
      // This player's part in the balloon's life (all null if they never touched it).
      yourPumps: st ? st.pumps : 0,
      yourRank: st ? ranking.indexOf(pl.id) + 1 : null,
      yourLastBefore: st ? b.pumps - st.lastNo : null,
      yourLastAgoMs: st ? now - st.lastAt : null,
    });
  }
  broadcast();
  setTimeout(() => { newBalloon(); broadcast(); }, NEXT_BALLOON_MS);
}

function startBots() {
  for (let i = 0; i < DEMO_BOTS; i++) {
    const id = 'bot-' + i;
    const city = DEMO_CITIES[i % DEMO_CITIES.length];
    const loop = () => {
      setTimeout(() => {
        // Bots only play while a human is watching, and get more nervous as the balloon grows.
        const nervous = balloon ? Math.min(0.75, balloon.pumps / 400) : 1;
        if (players.size && balloon && Math.random() > nervous) pump(id, city, null, Math.random() < .25 ? 2 + Math.floor(Math.random() * 6) : 1);
        loop();
      }, rand(1500, 7000)).unref();
    };
    loop();
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(INDEX_PATH)); // read per request so edits show up on reload
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    // x-accel-buffering: stops hosting proxies (Render, nginx) from holding events back.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const pl = { id: crypto.randomUUID(), city: cityFromRequest(req, url), res, lastPumpAt: 0, streak: 0, score: 0, lastPumpNo: 0, lastPumpBalloon: 0 };
    players.set(pl.id, pl);
    send(pl, 'hello', { id: pl.id, city: pl.city });
    send(pl, 'state', snapshot());
    broadcast();
    req.on('close', () => { players.delete(pl.id); broadcast(); });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/pump') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      let id, amount;
      try { ({ id, amount } = JSON.parse(body)); } catch { return json(res, 400, { error: 'Bad request body.' }); }
      const pl = players.get(id);
      if (!pl) return json(res, 404, { error: 'Unknown player.' });
      amount = Math.max(1, Math.min(MAX_BREATH, Math.floor(Number(amount)) || 1));
      const now = Date.now();
      if (now - pl.lastPumpAt < PUMP_COOLDOWN_MS) return json(res, 429, { error: 'Too fast. One pump at a time.' });
      pl.lastPumpAt = now;
      const r = pump(pl.id, pl.city, pl, amount);
      json(res, r.status, r.body);
    });
    return;
  }

  // Bank: lock the current streak in as points (streak squared, so long streaks are worth far more) and start over.
  if (req.method === 'POST' && url.pathname === '/bank') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      let id;
      try { ({ id } = JSON.parse(body)); } catch { return json(res, 400, { error: 'Bad request body.' }); }
      const pl = players.get(id);
      if (!pl) return json(res, 404, { error: 'Unknown player.' });
      if (!pl.streak) return json(res, 409, { error: 'Nothing to bank yet.' });
      const points = pl.streak * pl.streak;
      const streak = pl.streak;
      pl.score += points;
      pl.streak = 0;
      if (!records.biggestBank || points > records.biggestBank.points) records.biggestBank = { points, streak, city: pl.city };
      if (streak >= 15) addNews({ k: 'bank', city: pl.city, streak });
      broadcast();
      json(res, 200, { points, score: pl.score });
    });
    return;
  }

  res.writeHead(404).end();
});

// Keep idle SSE connections open through proxies.
setInterval(() => { for (const pl of players.values()) pl.res.write(': ping\n\n'); }, 20_000).unref();

newBalloon();
startBots();
server.listen(PORT, () => console.log(`Don't Pop It running at http://localhost:${PORT}`));
