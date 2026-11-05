'use strict';
// Doktor's Curse tarzı saklambaç - otoriter WebSocket sunucusu
// Hunter'lar (avcı) çekiçle Monster'ları (canavar) avlar, Monster'lar görünmez olabilir.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

// ---------------- Ayarlar (denge için buradan oyna) ----------------
const CFG = {
  W: 1152, H: 648, TICK: 20,
  MIN_PLAYERS: num('MIN_PLAYERS', 2), MAX_PLAYERS: 10,
  COUNTDOWN: num('COUNTDOWN', 5),      // takımlar belli olur, herkes kilitli
  HIDE_TIME: num('HIDE_TIME', 10),     // Monster'lar saklanır, Hunter'lar kilitli
  ROUND_TIME: num('ROUND_TIME', 90),
  RESULT_TIME: num('RESULT_TIME', 6),
  HUNTER_SPEED: 200, MONSTER_SPEED: 175, INVIS_SPEED: 235,
  HUNTER_R: 14, MONSTER_R: 12,
  SWING_RANGE: 55, SWING_CD: 0.6,
  PING_CD: 8, PING_TIME: 1.0,           // tracker: Monster'ları duvar/görünmezlik dinlemeden gösterir
  INVIS_TIME: 1.5, INVIS_CD: 6,
  VIEW_HUNTER: 250, VIEW_MONSTER: 380,  // görüş mesafesi (duvar arkası görünmez)
};
const DT = 1 / CFG.TICK;

const WALLS = [
  [200, 120, 160, 40], [500, 80, 40, 200], [800, 150, 200, 40],
  [150, 350, 40, 200], [400, 420, 220, 40], [750, 380, 40, 200],
  [950, 480, 140, 40], [580, 300, 100, 40],
];

// ---------------- Yardımcılar ----------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v) => Math.round(v * 10) / 10;

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

function randomFreePos(r) {
  for (let i = 0; i < 200; i++) {
    const x = 250 + Math.random() * (CFG.W - 280);
    const y = 30 + Math.random() * (CFG.H - 60);
    if (!blocked(x, y, r + 2)) return { x, y };
  }
  return { x: CFG.W - 60, y: CFG.H / 2 };
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
    team: 'S', alive: false,            // S = izleyici (sonraki round'u bekler)
    x: 0, y: 0, dx: 0, dy: 0,
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
  hs.forEach((p, i) => { p.x = 50; p.y = (CFG.H * (i + 1)) / (hs.length + 1); });
  list.filter((p) => p.team === 'M').forEach((p) => {
    const s = randomFreePos(CFG.MONSTER_R);
    p.x = s.x; p.y = s.y;
  });
  phase = 'countdown';
  timer = CFG.COUNTDOWN;
  winner = null;
}

function endRound(w) {
  phase = 'result';
  winner = w;
  timer = CFG.RESULT_TIME;
}

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
      if (p.pend.ping && p.pingCd <= 0) {
        p.pingCd = CFG.PING_CD;
        p.pingT = CFG.PING_TIME;
      }
    }
    if (p.team === 'M' && p.pend.invis && p.invCd <= 0) {
      p.invCd = CFG.INVIS_CD;
      p.invisT = CFG.INVIS_TIME;
    }
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
      simulate();
      timer -= DT;
      checkWin();
      if (phase === 'hide' && timer <= 0) { phase = 'playing'; timer = CFG.ROUND_TIME; }
      break;
    case 'playing':
      simulate();
      timer -= DT;
      checkWin();
      if (phase === 'playing' && timer <= 0) endRound('M');
      break;
    case 'result':
      timer -= DT;
      if (timer <= 0) toLobby();
      break;
  }
  broadcast();
}

// ---------------- Görüş + yayın ----------------
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
      else {
        const d = Math.hypot(p.x - v.x, p.y - v.y);
        if (v.team === 'H') { // p = Monster
          if (v.pingT > 0) visible = true;
          else if (p.invisT <= 0 && d <= CFG.VIEW_HUNTER && hasLOS(v.x, v.y, p.x, p.y)) visible = true;
        } else if (d <= CFG.VIEW_MONSTER && hasLOS(v.x, v.y, p.x, p.y)) visible = true; // p = Hunter
      }
      if (visible) list.push({ id: p.id, n: p.name, tm: p.team, x: r1(p.x), y: r1(p.y), iv: p.invisT > 0 ? 1 : 0 });
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
  res.end(`Doktor's Curse sunucusu çalışıyor. Oyuncu: ${players.size}, durum: ${phase}\n`);
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
        t: 'welcome', id: player.id, W: CFG.W, H: CFG.H, walls: WALLS,
        cfg: { min: CFG.MIN_PLAYERS, view_h: CFG.VIEW_HUNTER, view_m: CFG.VIEW_MONSTER, swing: CFG.SWING_RANGE },
      });
    } else if (m.t === 'in' && player) {
      player.dx = clamp(Number(m.dx) || 0, -1, 1);
      player.dy = clamp(Number(m.dy) || 0, -1, 1);
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
