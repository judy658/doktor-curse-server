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

// ---------------- Eşyalar ----------------
// [solid (çarpışma), tall (ışığı ve görüşü keser)]
const TYPES = {
  rug_red: [0, 0], rug_blue: [0, 0], rug_green: [0, 0],
  table: [1, 0], dining: [1, 0], coffee: [1, 0], desk: [1, 0], counter: [1, 0], altar: [1, 0],
  bed: [1, 0], sofa: [1, 0], armchair: [1, 0], piano: [1, 0], nightstand: [1, 0],
  bench: [1, 0], sarcophagus: [1, 0], cabinet: [1, 0], plant: [1, 0], barrel: [1, 0], crate: [1, 0],
  bookshelf: [1, 1], wardrobe: [1, 1], fireplace: [1, 1], statue: [1, 1],
  pillar: [1, 1], clock: [1, 1], winerack: [1, 1],
};
const PROPS = [];
function prop(type, x, y, w, h) {
  const f = TYPES[type];
  if (!f) throw new Error('bilinmeyen eşya: ' + type);
  PROPS.push([type, x, y, w, h, f[0], f[1]]);
}

// Giriş holü
prop('rug_red', 70, 40, 80, 1120);
prop('plant', 14, 14, 40, 40); prop('plant', 14, 1146, 40, 40);
prop('clock', 150, 14, 44, 60); prop('clock', 150, 1126, 44, 60);
prop('bench', 166, 250, 36, 160); prop('bench', 166, 790, 36, 160);

// Orta salon
prop('rug_red', 700, 480, 300, 240);
prop('rug_blue', 500, 500, 190, 220);
prop('rug_green', 1240, 500, 250, 200);
prop('sofa', 520, 430, 140, 48); prop('sofa', 520, 722, 140, 48);
prop('coffee', 540, 570, 100, 60);
prop('dining', 760, 560, 200, 90);
prop('piano', 1020, 540, 110, 90);
prop('pillar', 1150, 470, 44, 44); prop('pillar', 1150, 690, 44, 44);
prop('fireplace', 1390, 414, 100, 44);
prop('statue', 1660, 490, 48, 48); prop('statue', 1660, 664, 48, 48);
prop('plant', 250, 430, 36, 36); prop('plant', 250, 732, 36, 36);
prop('plant', 1740, 430, 36, 36); prop('plant', 1740, 732, 36, 36);

// Üst sıra: kütüphane
prop('rug_green', 320, 120, 260, 220);
prop('bookshelf', 300, 10, 230, 40); prop('bookshelf', 236, 230, 40, 150); prop('bookshelf', 590, 280, 36, 100);
prop('desk', 360, 170, 110, 56); prop('armchair', 500, 230, 56, 56);
prop('plant', 300, 330, 34, 34);
// Üst sıra: yatak odası
prop('rug_blue', 720, 190, 260, 160);
prop('bed', 760, 16, 100, 140); prop('nightstand', 708, 16, 40, 40); prop('nightstand', 868, 16, 40, 40);
prop('wardrobe', 940, 10, 100, 50); prop('cabinet', 930, 310, 100, 50); prop('armchair', 700, 300, 56, 56);
// Üst sıra: mutfak
prop('rug_red', 1170, 150, 190, 120);
prop('counter', 1076, 10, 380, 44); prop('table', 1190, 170, 150, 80);
prop('barrel', 1100, 330, 36, 36); prop('barrel', 1146, 330, 36, 36);
prop('crate', 1410, 300, 50, 50); prop('crate', 1360, 310, 40, 40);
// Üst sıra: galeri
prop('rug_red', 1560, 110, 200, 240);
prop('statue', 1530, 30, 44, 44); prop('statue', 1710, 30, 44, 44);
prop('altar', 1620, 60, 80, 50); prop('bench', 1560, 250, 150, 36);
prop('plant', 1504, 330, 34, 34); prop('plant', 1748, 330, 34, 34);

// Alt sıra: kiler
prop('rug_blue', 360, 920, 200, 130);
prop('barrel', 250, 830, 36, 36); prop('barrel', 292, 830, 36, 36);
prop('table', 400, 950, 120, 70);
prop('crate', 310, 1040, 46, 46); prop('crate', 360, 1040, 46, 46);
prop('winerack', 300, 1160, 200, 36);
// Alt sıra: hizmetçi odası
prop('rug_blue', 720, 900, 260, 120);
prop('bed', 700, 1050, 90, 140); prop('bed', 810, 1050, 90, 140); prop('nightstand', 908, 1150, 40, 40);
prop('wardrobe', 960, 818, 88, 46); prop('cabinet', 660, 830, 60, 40);
// Alt sıra: mahzen
prop('crate', 1112, 1100, 50, 50); prop('crate', 1162, 1100, 50, 50); prop('crate', 1137, 1050, 50, 50);
prop('barrel', 1390, 830, 36, 36); prop('barrel', 1430, 830, 36, 36);
prop('winerack', 1200, 1160, 200, 36); prop('table', 1250, 960, 110, 70);
// Alt sıra: kripta
prop('rug_green', 1580, 900, 200, 260);
prop('sarcophagus', 1640, 1000, 60, 140);
prop('statue', 1530, 1130, 44, 44); prop('statue', 1720, 1130, 44, 44); prop('statue', 1730, 880, 44, 44);

// Işık kaynakları: [x, y, yarıçap, tip]
const LAMPS = [
  [110, 140, 190, 'sconce'], [110, 600, 260, 'chandelier'], [110, 1060, 190, 'sconce'],
  [300, 600, 170, 'lamp'], [700, 600, 280, 'chandelier'], [1250, 600, 280, 'chandelier'], [1440, 490, 240, 'fire'],
  [420, 110, 190, 'lamp'], [888, 36, 130, 'candle'], [1230, 110, 200, 'lamp'],
  [1640, 230, 230, 'chandelier'], [1640, 70, 120, 'candle'],
  [400, 880, 190, 'lamp'], [800, 960, 190, 'lamp'], [928, 1170, 120, 'candle'],
  [1300, 1100, 200, 'lamp'], [1670, 975, 150, 'candle'],
];

// Zemin bölgeleri (görsel): [x, y, w, h, stil]
const FLOORS = [
  [0, 0, 220, CFG.H, 0],
  [220, 400, CFG.W - 220, 400, 1],
  [220, 0, 420, 400, 2], [640, 0, 420, 400, 3], [1060, 0, 420, 400, 4], [1480, 0, 320, 400, 5],
  [220, 800, 420, 400, 4], [640, 800, 420, 400, 3], [1060, 800, 420, 400, 6], [1480, 800, 320, 400, 5],
];

// Çarpışan her şey: duvarlar + katı eşyalar
const COLLIDERS = [...WALLS, ...PROPS.filter((p) => p[5]).map((p) => [p[1], p[2], p[3], p[4]])];

// ---------------- Yardımcılar ----------------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function blocked(x, y, r) {
  if (x < r || x > CFG.W - r || y < r || y > CFG.H - r) return true;
  for (const [wx, wy, ww, wh] of COLLIDERS) {
    if (x >= wx - r && x <= wx + ww + r && y >= wy - r && y <= wy + wh + r) return true;
  }
  return false;
}

function moveWithWalls(p, sx, sy, r) {
  if (!blocked(p.x + sx, p.y, r)) p.x += sx;
  if (!blocked(p.x, p.y + sy, r)) p.y += sy;
}

// Giriş holünden ulaşılabilen hücreler: Monster'ın ulaşılamayan bir cebe doğmasını engeller
const REACH = (() => {
  const S = 10, R = 14, gw = Math.floor(CFG.W / S), gh = Math.floor(CFG.H / S);
  const free = (gx, gy) => !blocked(gx * S + S / 2, gy * S + S / 2, R);
  let sy = Math.floor(gh / 2);
  while (!free(5, sy)) sy++;
  const seen = new Uint8Array(gw * gh);
  const stack = [[5, sy]];
  seen[sy * gw + 5] = 1;
  const cells = [];
  while (stack.length) {
    const [x, y] = stack.pop();
    cells.push([x * S + S / 2, y * S + S / 2]);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || seen[ny * gw + nx] || !free(nx, ny)) continue;
      seen[ny * gw + nx] = 1;
      stack.push([nx, ny]);
    }
  }
  return cells;
})();

function randomFreePos(r) {
  for (let i = 0; i < 300; i++) {
    const c = REACH[Math.floor(Math.random() * REACH.length)];
    if (c[0] < 300) continue;
    const x = c[0] + (Math.random() - 0.5) * 8;
    const y = c[1] + (Math.random() - 0.5) * 8;
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

// ---------------- Yayın ----------------
// Görüş kararı (el feneri, ışık, duvar arkası) client'ta verilir; sunucu yalnızca
// canlı herkesin konumunu gönderir (iv = görünmezlik bayrağı).
function broadcast() {
  const all = [...players.values()];
  const { h, m } = counts();
  const list = [];
  for (const p of all) {
    if (p.team === 'S' || !p.alive) continue;
    list.push({ id: p.id, n: p.name, tm: p.team, x: r1(p.x), y: r1(p.y), a: r2(p.ang), iv: p.invisT > 0 ? 1 : 0 });
  }
  for (const v of all) {
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
  res.end(`Doktor's Curse sunucusu çalışıyor (v3). Oyuncu: ${players.size}, durum: ${phase}\n`);
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
        t: 'welcome', id: player.id, W: CFG.W, H: CFG.H, walls: WALLS, props: PROPS, lamps: LAMPS, floors: FLOORS,
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
