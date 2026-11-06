'use strict';
// Doktor's Curse tarzı saklambaç - otoriter WebSocket sunucusu (v2: büyük harita + el feneri görüşü)
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

// ---------------- Ayarlar (denge için buradan oyna) ----------------
const CFG = {
  W: 1800, H: 1200, TICK: 20,
  MIN_PLAYERS: num('MIN_PLAYERS', 2), MAX_PLAYERS: 10,
  COUNTDOWN: num('COUNTDOWN', 5),
  HIDE_TIME: num('HIDE_TIME', 15),
  ROUND_TIME: num('ROUND_TIME', 150),
  RESULT_TIME: num('RESULT_TIME', 6),
  HUNTER_SPEED: 200, MONSTER_SPEED: 175, INVIS_SPEED: 235,
  HUNTER_R: 14, MONSTER_R: 12,
  SWING_RANGE: 55, SWING_CD: 0.6,
  PING_CD: 10, PING_TIME: 1.2,
  INVIS_TIME: 1.5, INVIS_CD: 6,
  // El feneri: ambient = etrafındaki küçük aydınlık, range = ışık huzmesi uzunluğu,
  // half = huzmenin yarım açısı (radyan), blend = huzme kenarı yumuşaklığı
  LIGHT: {
    H: { ambient: 100, range: 400, half: 0.6, blend: 0.3 },
    M: { ambient: 110, range: 360, half: 0.65, blend: 0.3 },
  },
};
const DT = 1 / CFG.TICK;

// ---------------- Harita (malikâne) ----------------
const T = 24; // duvar kalınlığı
const WALLS = [];
function hwall(x1, x2, y, gaps = []) {
  let cur = x1;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > cur) WALLS.push([cur, y - T / 2, a - cur, T]);
    cur = b;
  }
  if (x2 > cur) WALLS.push([cur, y - T / 2, x2 - cur, T]);
}
function vwall(y1, y2, x, gaps = []) {
  let cur = y1;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (a > cur) WALLS.push([x - T / 2, cur, T, a - cur]);
    cur = b;
  }
  if (y2 > cur) WALLS.push([x - T / 2, cur, T, y2 - cur]);
}
const box = (x, y, w, h) => WALLS.push([x, y, w, h]);

// Giriş holü (sol) ile ana bölüm arası, 3 kapı
vwall(0, CFG.H, 220, [[80, 200], [540, 660], [1000, 1120]]);
// Üst ve alt oda sıraları ile orta salon arası
hwall(220, CFG.W, 400, [[380, 500], [800, 920], [1220, 1340], [1600, 1720]]);
hwall(220, CFG.W, 800, [[330, 450], [740, 860], [1180, 1300], [1560, 1680]]);
// Odalar arası duvarlar
vwall(0, 400, 640, [[140, 260]]);
vwall(0, 400, 1060, [[180, 300]]);
vwall(0, 400, 1480, [[120, 240]]);
vwall(800, 1200, 640, [[940, 1060]]);
vwall(800, 1200, 1060, [[900, 1020]]);
vwall(800, 1200, 1480, [[960, 1080]]);
// Giriş holü sandıkları
box(100, 300, 60, 60); box(100, 820, 60, 60);
// Orta salon sütunları / eşyalar
box(500, 500, 60, 60); box(500, 640, 60, 60); box(800, 560, 120, 80);
box(1100, 480, 60, 60); box(1100, 660, 60, 60); box(1350, 540, 100, 120);
box(1650, 500, 70, 70); box(1650, 660, 70, 70);
// Üst odalar
box(300, 150, 90, 50); box(520, 250, 50, 100);
box(720, 60, 50, 120); box(900, 260, 120, 50);
box(1140, 140, 100, 50); box(1350, 260, 50, 100);
box(1560, 60, 90, 50); box(1650, 250, 60, 60);
// Alt odalar
box(300, 900, 100, 50); box(520, 1000, 50, 120);
box(720, 880, 50, 120); box(920, 1080, 120, 50);
box(1160, 900, 120, 50); box(1380, 1040, 50, 100);
box(1580, 880, 100, 50); box(1650, 1060, 60, 60);

// Zemin bölgeleri (sadece görsel): [x, y, w, h, renkIndex]
const FLOORS = [[0, 0, 220, CFG.H, 0], [220, 400, CFG.W - 220, 400, 1]];

// ---------------- Yardımcılar ----------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function blocked(x, y, r) {
  if (x < r || x > CFG.W - r || y < r || y > CFG.H - r) return true;
  for (const [wx, wy, ww, wh] of WALLS) {
    if (x >= wx - r && x <= wx + ww + r && y >= wy - r && y <= wy + wh + r) return true;
  }
  return false;
}

function moveWithWalls(p, sx, sy, r) {
  if (!blocked(p.x + sx, p.y, r)) p.x += sx;
  if (!blocked(p.x, p.y + sy, r)) p.y += sy;
}

function hasLOS(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const steps = Math.ceil(Math.hypot(dx, dy) / 8);
  for (let i = 1; i < steps; i++) {
    const x = ax + (dx * i) / steps, y = ay + (dy * i) / steps;
    for (const [wx, wy, ww, wh] of WALLS) {
      if (x >= wx && x <= wx + ww && y >= wy && y <= wy + wh) return false;
    }
  }
  return true;
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

// Client'taki light_range() ile birebir aynı olmalı
function lightRange(team, diff) {
  const L = CFG.LIGHT[team];
  if (diff <= L.half) return L.range;
  if (diff >= L.half + L.blend) return L.ambient;
  const t = (diff - L.half) / L.blend;
  return L.range + (L.ambient - L.range) * t;
}

function randomFreePos(r) {
  for (let i = 0; i < 300; i++) {
    const x = 300 + Math.random() * (CFG.W - 340);
    const y = 40 + Math.random() * (CFG.H - 80);
    if (!blocked(x, y, r + 2)) return { x, y };
  }
  return { x: CFG.W - 80, y: CFG.H / 2 };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------- Durum ----------------
let nextId = 1;
const players = new Map();
let phase = 'lobby'; // lobby | countdown | hide | playing | result
let timer = 0;
let winner = null;
let events = [];

function newPlayer(ws, rawName) {
  const id = nextId++;
  let name = String(rawName || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12);
  if (!name) name = 'Oyuncu' + id;
  return {
    id, ws, name,
    team: 'S', alive: false,
    x: 0, y: 0, dx: 0, dy: 0, ang: 0,
    swingCd: 0, pingCd: 0, pingT: 0, invCd: 0, invisT: 0,
    pend: { swing: false, ping: false, invis: false },
  };
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function canMove(p) {
  if (!p.alive || p.team === 'S') return false;
  if (phase === 'hide') return p.team === 'M';
  if (phase === 'playing') return true;
  return false;
}

function speedOf(p) {
  if (p.team === 'H') return CFG.HUNTER_SPEED;
  return p.invisT > 0 ? CFG.INVIS_SPEED : CFG.MONSTER_SPEED;
}
const radiusOf = (p) => (p.team === 'H' ? CFG.HUNTER_R : CFG.MONSTER_R);

// ---------------- Round akışı ----------------
function startCountdown() {
  const list = shuffle([...players.values()]);
  const nH = Math.max(1, Math.floor(list.length / 2));
  list.forEach((p, i) => {
    p.team = i < nH ? 'H' : 'M';
    p.alive = true;
    p.dx = p.dy = 0;
    p.swingCd = p.pingCd = p.pingT = p.invCd = p.invisT = 0;
    p.pend = { swing: false, ping: false, invis: false };
  });
  const hs = list.filter((p) => p.team === 'H');
  hs.forEach((p, i) => { p.x = 50; p.y = (CFG.H * (i + 1)) / (hs.length + 1); p.ang = 0; });
  list.filter((p) => p.team === 'M').forEach((p) => {
    const s = randomFreePos(CFG.MONSTER_R);
    p.x = s.x; p.y = s.y; p.ang = Math.random() * Math.PI * 2 - Math.PI;
  });
  phase = 'countdown';
  timer = CFG.COUNTDOWN;
  winner = null;
}

function endRound(w) { phase = 'result'; winner = w; timer = CFG.RESULT_TIME; }

function toLobby() {
  phase = 'lobby';
  for (const p of players.values()) { p.team = 'S'; p.alive = false; p.dx = p.dy = 0; }
}

function counts() {
  let h = 0, m = 0;
  for (const p of players.values()) {
    if (p.team === 'H') h++;
    else if (p.team === 'M' && p.alive) m++;
  }
  return { h, m };
}

function checkWin() {
  if (phase !== 'hide' && phase !== 'playing') return;
  const { h, m } = counts();
  if (m === 0) endRound('H');
  else if (h === 0) endRound('M');
}

function simulate() {
  for (const p of players.values()) {
    if (p.team === 'S' || !p.alive) continue;
    p.swingCd = Math.max(0, p.swingCd - DT);
    p.pingCd = Math.max(0, p.pingCd - DT);
    p.pingT = Math.max(0, p.pingT - DT);
    p.invCd = Math.max(0, p.invCd - DT);
    p.invisT = Math.max(0, p.invisT - DT);

    if (canMove(p) && (p.dx || p.dy)) {
      const len = Math.hypot(p.dx, p.dy);
      const spd = speedOf(p) * DT;
      moveWithWalls(p, (p.dx / len) * spd, (p.dy / len) * spd, radiusOf(p));
    }

    if (p.team === 'H' && phase === 'playing') {
      if (p.pend.swing && p.swingCd <= 0) {
        p.swingCd = CFG.SWING_CD;
        for (const q of players.values()) {
          if (q.team !== 'M' || !q.alive) continue;
          if (Math.hypot(q.x - p.x, q.y - p.y) < CFG.SWING_RANGE) {
            q.alive = false;
            events.push(`${p.name} → ${q.name} elendi`);
          }
        }
      }
      if (p.pend.ping && p.pingCd <= 0) { p.pingCd = CFG.PING_CD; p.pingT = CFG.PING_TIME; }
    }
    if (p.team === 'M' && p.pend.invis && p.invCd <= 0) { p.invCd = CFG.INVIS_CD; p.invisT = CFG.INVIS_TIME; }
    p.pend = { swing: false, ping: false, invis: false };
  }
}

function tick() {
  const n = players.size;
  switch (phase) {
    case 'lobby':
      if (n >= CFG.MIN_PLAYERS) startCountdown();
      break;
    case 'countdown': {
      const c = counts();
      if (n < CFG.MIN_PLAYERS || c.h === 0 || c.m === 0) { toLobby(); break; }
      timer -= DT;
      if (timer <= 0) { phase = 'hide'; timer = CFG.HIDE_TIME; }
      break;
    }
    case 'hide':
      simulate(); timer -= DT; checkWin();
      if (phase === 'hide' && timer <= 0) { phase = 'playing'; timer = CFG.ROUND_TIME; }
      break;
    case 'playing':
      simulate(); timer -= DT; checkWin();
      if (phase === 'playing' && timer <= 0) endRound('M');
      break;
    case 'result':
      timer -= DT;
      if (timer <= 0) toLobby();
      break;
  }
  broadcast();
}

// ---------------- Görüş (el feneri) + yayın ----------------
function canSee(v, p) {
  const dx = p.x - v.x, dy = p.y - v.y;
  const d = Math.hypot(dx, dy);
  const cap = lightRange(v.team, angDiff(v.ang, Math.atan2(dy, dx)));
  return d <= cap && hasLOS(v.x, v.y, p.x, p.y);
}

function broadcast() {
  const all = [...players.values()];
  const { h, m } = counts();
  for (const v of all) {
    const spectator = v.team === 'S' || !v.alive;
    const list = [];
    for (const p of all) {
      if (p.team === 'S' || !p.alive) continue;
      let visible = false;
      if (p === v || spectator || p.team === v.team) visible = true;
      else if (v.team === 'H') { // p = Monster
        if (v.pingT > 0) visible = true;
        else if (p.invisT <= 0 && canSee(v, p)) visible = true;
      } else if (canSee(v, p)) visible = true; // v = Monster, p = Hunter
      if (visible) list.push({ id: p.id, n: p.name, tm: p.team, x: r1(p.x), y: r1(p.y), a: r2(p.ang), iv: p.invisT > 0 ? 1 : 0 });
    }
    send(v.ws, {
      t: 's', ph: phase, tr: Math.max(0, Math.ceil(timer)), w: winner,
      np: players.size, hc: h, mc: m,
      me: {
        tm: v.team, al: v.alive, cm: canMove(v),
        spd: speedOf(v), r: radiusOf(v),
        sw: r1(v.swingCd), pg: r1(v.pingCd), pgT: r1(v.pingT), iv: r1(v.invCd), ivT: r1(v.invisT),
      },
      players: list,
      ev: events,
    });
  }
  events = [];
}

// ---------------- Ağ ----------------
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Doktor's Curse sunucusu çalışıyor (v2). Oyuncu: ${players.size}, durum: ${phase}\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let player = null;

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join' && !player) {
      if (players.size >= CFG.MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
      player = newPlayer(ws, m.name);
      players.set(player.id, player);
      send(ws, {
        t: 'welcome', id: player.id, W: CFG.W, H: CFG.H, walls: WALLS, floors: FLOORS,
        cfg: { min: CFG.MIN_PLAYERS, light: CFG.LIGHT, swing: CFG.SWING_RANGE },
      });
    } else if (m.t === 'in' && player) {
      player.dx = clamp(Number(m.dx) || 0, -1, 1);
      player.dy = clamp(Number(m.dy) || 0, -1, 1);
      const a = Number(m.ang);
      if (Number.isFinite(a)) player.ang = clamp(a, -7, 7);
      if (m.a1) player.pend.swing = true;
      if (m.a2) player.pend.ping = true;
      if (m.a3) player.pend.invis = true;
    }
  });
  ws.on('close', () => { if (player) players.delete(player.id); });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(() => {
  try { tick(); } catch (e) { console.error('tick hatası:', e); }
}, 1000 / CFG.TICK);

server.listen(PORT, () => console.log(`Sunucu ${PORT} portunda`));
