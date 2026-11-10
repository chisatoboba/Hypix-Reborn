#!/usr/bin/env node
'use strict';
/*
  Worker pengiriman otomatis Hypix Reborn
  ----------------------------------------
  Tugas: cek pesanan berstatus "dibayar" di Supabase, lalu jalankan perintah ke
  server Minecraft (Java) lewat RCON, dan tandai pesanan sebagai terkirim.

  Butuh Node.js 18+ (tanpa library tambahan). Jalankan dengan:
    node --env-file=.env delivery-worker.js     (Node 20.6+; atau set env var manual)
  Konfigurasi lewat environment variable (lihat .env.example).

  PENTING: SUPABASE_SERVICE_KEY itu rahasia. Jangan masuk ke GitHub / website.
*/
const net = require('net');
const E = process.env;
const need = k => { if (!E[k]) { console.error('Environment variable ' + k + ' belum diisi.'); process.exit(1); } return E[k]; };

const DRY = E.DRY_RUN === '1';             // 1 = hanya tampilkan, tidak kirim & tidak ubah data
const SB = need('SUPABASE_URL').replace(/\/+$/, '');
const KEY = need('SUPABASE_SERVICE_KEY');
const RCON = { host: E.RCON_HOST || '127.0.0.1', port: +(E.RCON_PORT || 25575), password: E.RCON_PASSWORD || '' };
if (!DRY && !RCON.password) { console.error('RCON_PASSWORD belum diisi.'); process.exit(1); }
const POLL = Math.max(5, +(E.POLL_SECONDS || 15)) * 1000;
const NAME_RE = new RegExp(E.PLAYER_REGEX || '^\\.?[A-Za-z0-9_]{3,16}$');
const FAIL_RE = new RegExp(E.FAIL_PATTERNS || 'unknown (or incomplete )?command|no player was found|unable to find|could not find|cannot find|does not exist|not online|player not found', 'i');

const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);

/* ---------- Supabase REST ---------- */
async function sb(path, opt = {}) {
  const r = await fetch(SB + '/rest/v1/' + path, {
    ...opt,
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...(opt.headers || {}) }
  });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* bukan JSON */ }
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + String((j && j.message) || t).slice(0, 200));
  return j;
}

/* ---------- RCON (protokol Source/Minecraft) ---------- */
function connectRcon() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: RCON.host, port: RCON.port });
    let buf = Buffer.alloc(0), waiters = [], id = 0, closed = false, authing = true;
    const fail = e => { if (closed) return; closed = true; s.destroy(); waiters.splice(0).forEach(w => w.rej(e)); reject(e); };
    s.setTimeout(10000, () => fail(new Error('RCON timeout')));
    s.on('error', fail);
    s.on('close', () => fail(new Error('RCON terputus')));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const pkt = { id: buf.readInt32LE(4), type: buf.readInt32LE(8), body: buf.toString('utf8', 12, 4 + len - 2) };
        buf = buf.subarray(4 + len);
        if (authing && pkt.type !== 2) continue;   // lewati paket kosong sebelum auth response
        const w = waiters.shift(); if (w) w.res(pkt);
      }
    });
    const send = (type, body) => new Promise((res, rej) => {
      const b = Buffer.from(body, 'utf8');
      const p = Buffer.alloc(14 + b.length);
      p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(++id, 4); p.writeInt32LE(type, 8); b.copy(p, 12);
      waiters.push({ res, rej }); s.write(p);
    });
    s.once('connect', async () => {
      try {
        const a = await send(3, RCON.password);
        if (a.id === -1) throw new Error('Password RCON salah');
        authing = false;
        resolve({ cmd: async c => (await send(2, c)).body, close: () => { closed = true; s.end(); } });
      } catch (e) { fail(e); }
    });
  });
}

/* ---------- Katalog & perintah ---------- */
const lines = t => String(t || '').split('\n').map(x => x.trim()).filter(Boolean);
function parsePrice(t) {
  const m = String(t || '').match(/(\d[\d.,]*)\s*(k|rb|ribu|jt|juta)?/i); if (!m) return null;
  const u = (m[2] || '').toLowerCase();
  let n = u ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) : parseFloat(m[1].replace(/[.,]/g, ''));
  if (!isFinite(n)) return null;
  if (u === 'k' || u === 'rb' || u === 'ribu') n *= 1000; else if (u === 'jt' || u === 'juta') n *= 1e6;
  return n;
}
function catalog(site) {
  const m = new Map();
  const add = (kind, t, ni, pi) => lines(t).forEach(l => {
    const p = l.split('|').map(x => x.trim());
    if (p[ni]) m.set(kind + '|' + p[ni].toLowerCase(), { price: parsePrice(p[pi]) });
  });
  add('Rank', site.ranks, 0, 1); add('Key', site.keys, 0, 1); add('Layanan', site.services, 1, 2);
  return m;
}
function parseCmds(t) {
  const m = new Map();
  lines(t).forEach(l => {
    const i = l.indexOf('|'); if (i < 1) return;
    const n = l.slice(0, i).trim().toLowerCase(), c = l.slice(i + 1).trim();
    if (n && c) { if (!m.has(n)) m.set(n, []); m.get(n).push(c); }
  });
  return m;
}

/* ---------- Rencana pengiriman satu pesanan ---------- */
function plan(o, ctx) {
  if (!NAME_RE.test(o.mc_name || '')) return { error: 'Username Minecraft tidak valid: ' + o.mc_name };
  const items = Array.isArray(o.items) ? o.items : [];
  if (!items.length || items.length > 20) return { error: 'Daftar item tidak valid' };
  let manual = false, sum = 0; const auto = [];
  for (const it of items) {
    const q = Number(it.jumlah);
    if (!Number.isInteger(q) || q < 1 || q > 20) return { error: 'Jumlah tidak valid untuk ' + it.nama };
    const kind = String(it.kategori || ''), name = String(it.nama || '');
    const cat = ctx.cat.get(kind + '|' + name.toLowerCase());
    if (!cat) return { error: 'Item tidak ada di katalog: ' + name };
    const ip = parsePrice(it.harga);
    if (cat.price == null || ip == null || Math.round(ip) !== Math.round(cat.price)) return { error: 'Harga ' + name + ' tidak sesuai katalog' };
    sum += cat.price * q;
    if (kind === 'Layanan') { manual = true; continue; }
    const cm = ctx.cmds.get(name.toLowerCase());
    if (!cm || !cm.length) return { error: 'Belum ada perintah pengiriman untuk: ' + name };
    auto.push({ q, cm });
  }
  if (o.total != null && Math.round(Number(o.total)) !== Math.round(sum)) return { error: 'Total pesanan tidak sesuai katalog' };
  const cmds = []; let online = false;
  for (const a of auto) for (const raw of a.cm) {
    let c = raw;
    if (/^@online\s+/i.test(c)) { online = true; c = c.replace(/^@online\s+/i, ''); }
    c = c.replace(/^\//, '');
    const fill = x => x.split('{player}').join(o.mc_name).split('{qty}').join(String(a.q));
    if (c.includes('{qty}')) cmds.push(fill(c)); else for (let i = 0; i < a.q; i++) cmds.push(fill(c));
  }
  return { cmds, manual, online };
}

/* ---------- Update status ---------- */
async function finish(o, state, msg, selesai) {
  log('Pesanan ' + String(o.id).slice(0, 8).toUpperCase() + ' (' + o.mc_name + ') -> ' + state + ': ' + msg);
  if (DRY) return;
  const body = { delivery: state, delivery_note: String(msg).slice(0, 500), delivered_at: state === 'done' ? new Date().toISOString() : null };
  if (state === 'done' && selesai) body.status = 'selesai';
  await sb('orders?id=eq.' + o.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
}
async function note(o, msg) {
  if (DRY || o.delivery_note === msg) return;
  await sb('orders?id=eq.' + o.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ delivery_note: msg }) });
}
async function listOnline() {
  const c = await connectRcon();
  try {
    const r = String(await c.cmd('list')).replace(/§./g, '');
    const i = r.indexOf(':');
    return new Set((i < 0 ? '' : r.slice(i + 1)).split(/[,\s:]+/).map(x => x.trim().toLowerCase()).filter(Boolean));
  } finally { c.close(); }
}

/* ---------- Satu putaran ---------- */
async function tick() {
  const rows = await sb('orders?status=eq.dibayar&delivery=eq.pending&select=*&order=created_at.asc&limit=10');
  if (!rows || !rows.length) return;
  const site = ((await sb('site?id=eq.main&select=data'))[0] || {}).data || {};
  const priv = ((await sb('site_private?id=eq.main&select=data'))[0] || {}).data || {};
  const ctx = { cat: catalog(site), cmds: parseCmds(priv.cmds) };
  let online = null;
  for (const o of rows) {
    const p = plan(o, ctx);
    if (p.error) { await finish(o, 'failed', p.error); continue; }
    if (!p.cmds.length) { await finish(o, 'done', 'Tidak ada item otomatis (layanan manual). Tandai Selesai setelah dikerjakan.', false); continue; }
    if (p.online && !DRY) {
      try { online = online || await listOnline(); } catch (e) { log('Tidak bisa cek pemain online: ' + e.message); continue; }
      if (!online.has(o.mc_name.toLowerCase())) { log(o.mc_name + ' belum online, ditunda.'); await note(o, 'Menunggu ' + o.mc_name + ' online di server'); continue; }
    }
    if (DRY) { log('[DRY_RUN] ' + o.mc_name + ' akan menjalankan: ' + p.cmds.join(' ; ')); continue; }
    const claimed = await sb('orders?id=eq.' + o.id + '&delivery=eq.pending', { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ delivery: 'processing' }) });
    if (!claimed || !claimed.length) continue;
    let done = 0, c = null;
    try {
      c = await connectRcon();
      for (const cmd of p.cmds) {
        const resp = await c.cmd(cmd);
        if (FAIL_RE.test(resp)) throw new Error('perintah "' + cmd + '" dijawab server: ' + String(resp).replace(/§./g, '').slice(0, 150));
        done++;
      }
      await finish(o, 'done', 'Terkirim ke ' + o.mc_name + ' (' + done + ' perintah)' + (p.manual ? '. Ada layanan manual, tandai Selesai setelah dikerjakan.' : ''), !p.manual);
    } catch (e) {
      await finish(o, 'failed', 'Gagal di perintah ke-' + (done + 1) + '/' + p.cmds.length + ' (' + done + ' sebelumnya sudah jalan): ' + e.message);
    } finally { if (c) c.close(); }
  }
}

let busy = false;
async function loop() {
  if (busy) return; busy = true;
  try { await tick(); } catch (e) { log('Error: ' + e.message); } finally { busy = false; }
}

(async () => {
  log('Worker pengiriman jalan' + (DRY ? ' (DRY_RUN: tidak mengirim apa pun)' : '') + '. Cek tiap ' + POLL / 1000 + ' detik.');
  if (!DRY) {
    try {
      const stuck = await sb('orders?delivery=eq.processing&select=id,mc_name');
      for (const o of stuck || []) await finish(o, 'failed', 'Worker berhenti saat memproses. Periksa di server apakah sudah terkirim sebelum kirim ulang.');
    } catch (e) { log('Cek awal gagal: ' + e.message); }
  }
  await loop();
  if (E.ONCE === '1') process.exit(0);
  setInterval(loop, POLL);
})();
