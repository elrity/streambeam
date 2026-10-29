#!/usr/bin/env node
// StreamBeam production server (Node 18+, no dependencies).
//  - serves the installable app (index.html, manifest, service worker, icons)
//  - /gemini        answers Today tiles with the server's Gemini key (never sent to browsers)
//  - /vlc/status    relays the remote to VLC's web interface, adding VLC's password
//
//   GEMINI_API_KEY=... node server.mjs                        # this computer only
//   GEMINI_API_KEY=... BIND=0.0.0.0 APP_PASSWORD=... node server.mjs   # reachable from other devices
//
// Env: PORT (8090), BIND (127.0.0.1), APP_PASSWORD (asks for it in the browser; user name is ignored),
//      GEMINI_API_KEY, GEMINI_MODEL (gemini-2.5-flash), GEMINI_API_BASE (Google's endpoint; for a proxy/gateway), GEMINI_LIMIT (requests per 10 min per address, 40),
//      VLC_PASSWORD (turns the VLC relay on), VLC_HOST (127.0.0.1), VLC_PORT (8080),
//      ALLOW_ORIGIN (another origin allowed to call /vlc, e.g. where you host index.html),
//      TRUST_PROXY (set behind a hosting proxy such as Render, so limits use the visitor's address),
//      ANDROID_CERT_SHA256 (the Android app's signing fingerprint(s), comma-separated) and ANDROID_PACKAGE
//      (app.streambeam.caster): serves /.well-known/assetlinks.json so the APK opens without a browser bar.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = +env.PORT || 8090;
const BIND = env.BIND || '127.0.0.1';
const APP_PASSWORD = env.APP_PASSWORD || '';
const GEMINI_KEY = env.GEMINI_API_KEY || '';
const GEMINI_MODEL = env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_BASE = (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const GEMINI_LIMIT = +env.GEMINI_LIMIT || 40;
const VLC = `http://${env.VLC_HOST || '127.0.0.1'}:${+env.VLC_PORT || 8080}`;
const VLC_ON = 'VLC_PASSWORD' in env;
const VLC_AUTH = 'Basic ' + Buffer.from(':' + (env.VLC_PASSWORD || '')).toString('base64');
const ALLOW_ORIGIN = env.ALLOW_ORIGIN || '';
const TRUST_PROXY = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
const ANDROID_CERTS = (env.ANDROID_CERT_SHA256 || '').split(',').map(s => s.trim().toUpperCase()).filter(s => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
const ASSET_LINKS = ANDROID_CERTS.length ? JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: env.ANDROID_PACKAGE || 'app.streambeam.caster', sha256_cert_fingerprints: ANDROID_CERTS } }]) : '';

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/index.html': ['index.html', 'text/html; charset=utf-8', 'no-cache'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json', 'no-cache'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
  '/icons/icon.svg': ['icons/icon.svg', 'image/svg+xml', 'public, max-age=604800'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png', 'public, max-age=604800'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png', 'public, max-age=604800'],
  '/icons/icon-maskable-512.png': ['icons/icon-maskable-512.png', 'image/png', 'public, max-age=604800']
};
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin', // YouTube's player needs the origin
  'Permissions-Policy': 'display-capture=(self), geolocation=(self), camera=(), microphone=()',
  'X-Frame-Options': 'SAMEORIGIN'
};

// VLC: only the remote-control commands the app uses, network media only, Host must be an IP or localhost.
const VLC_COMMANDS = new Set(['', 'in_play', 'pl_forcepause', 'pl_forceresume', 'pl_stop', 'pl_next', 'pl_previous', 'seek', 'volume', 'rate', 'fullscreen']);
const VLC_INPUT = /^(https?|rtsp|rtmp|rtp|udp|mms|srt):\/\//i;
const IP_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i;

const SYSTEM = 'You are a daily briefing assistant inside a TV casting app. Be concise and factual, use Google Search for anything current, and give dates and numbers. Use "- " bullets and **bold** sparingly. No preamble and no closing offer.';
const hits = new Map(); // address -> request times, for the Gemini rate limit

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !token) return false;
  const pass = Buffer.from(token, 'base64').toString().split(':').slice(1).join(':');
  return same(pass, APP_PASSWORD);
}
async function body(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}

async function gemini(req, res) {
  if (!GEMINI_KEY) return send(res, 404, { error: 'This server has no Gemini key.' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress, now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 6e5);
  if (recent.length >= GEMINI_LIMIT) return send(res, 429, { error: 'Too many questions in the last 10 minutes. Try again shortly.' });
  hits.set(ip, [...recent, now]);
  let prompt;
  try { prompt = String((await body(req)).prompt || '').trim(); } catch { return send(res, 400, { error: 'Bad request.' }); }
  if (!prompt || prompt.length > 2000) return send(res, 400, { error: 'Ask a question of up to 2000 characters.' });
  try {
    const r = await fetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Gemini error', r.status, j.error?.message);
      return send(res, r.status === 429 ? 429 : 502, { error: r.status === 429 ? 'Gemini’s quota for this server is used up. Try again later.' : 'Gemini couldn’t answer right now.' });
    }
    const c = j.candidates?.[0];
    const text = (c?.content?.parts || []).map(p => p.text || '').join('').trim();
    const sources = (c?.groundingMetadata?.groundingChunks || []).map(x => x.web).filter(w => w && w.uri).map(w => ({ title: w.title || new URL(w.uri).hostname, uri: w.uri }));
    if (!text) return send(res, 502, { error: c?.finishReason === 'SAFETY' ? 'Gemini declined to answer that.' : 'Gemini returned no answer. Try again.' });
    send(res, 200, { text, sources, model: GEMINI_MODEL });
  } catch (e) {
    console.error('Gemini unreachable', e.message);
    send(res, 502, { error: 'The server couldn’t reach Gemini.' });
  }
}

async function vlc(req, res, url) {
  if (!VLC_ON) return send(res, 404, { error: 'The VLC relay is off. Start the server with VLC_PASSWORD set.' });
  if (!IP_HOST.test(req.headers.host || '')) return send(res, 403, { error: 'Open the app by IP address or localhost to control VLC.' });
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}` && origin !== ALLOW_ORIGIN) return send(res, 403, { error: 'This page isn’t allowed to control VLC. Set ALLOW_ORIGIN to its address.' });
  const cmd = url.searchParams.get('command') || '';
  if (!VLC_COMMANDS.has(cmd)) return send(res, 400, { error: `Command “${cmd}” isn’t allowed.` });
  if (cmd === 'in_play' && !VLC_INPUT.test(url.searchParams.get('input') || '')) return send(res, 400, { error: 'VLC can only open web and stream links from here.' });
  const opt = url.searchParams.get('option');
  if (opt && !/^start-time=\d+$/.test(opt)) return send(res, 400, { error: 'Option not allowed.' });
  try {
    const r = await fetch(`${VLC}/requests/status.json${url.search}`, { headers: { Authorization: VLC_AUTH } });
    if (r.status === 401) return send(res, 401, { error: 'VLC rejected the password. Set VLC_PASSWORD to the password in VLC’s Lua settings.' });
    send(res, r.status, await r.text());
  } catch {
    send(res, 502, { error: `VLC isn’t answering at ${VLC}. Make sure VLC is open with its web interface turned on.` });
  }
}

http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://app');
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGIN && origin === ALLOW_ORIGIN) res.setHeader('Access-Control-Allow-Origin', origin);
  // The manifest, icons and health check stay public (install prompt, container health checks).
  const open = url.pathname === '/manifest.webmanifest' || url.pathname === '/healthz' || url.pathname === '/.well-known/assetlinks.json' || url.pathname.startsWith('/icons/');
  if (!open && !authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="StreamBeam", charset="UTF-8"', 'Content-Type': 'text/plain' });
    return res.end('Enter the StreamBeam password.');
  }
  try {
    if (url.pathname === '/gemini/status') return send(res, 200, { enabled: !!GEMINI_KEY, model: GEMINI_KEY ? GEMINI_MODEL : '' });
    if (url.pathname === '/gemini') return await gemini(req, res);
    if (url.pathname === '/vlc/status') return await vlc(req, res, url);
    const f = FILES[url.pathname];
    if (f && (req.method === 'GET' || req.method === 'HEAD')) {
      const data = await readFile(path.join(dir, f[0]));
      res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': f[2], 'Content-Length': data.length });
      return res.end(req.method === 'HEAD' ? undefined : data);
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (url.pathname === '/.well-known/assetlinks.json' && ASSET_LINKS) return send(res, 200, ASSET_LINKS);
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, 'Something went wrong', 'text/plain');
  }
}).listen(PORT, BIND, () => {
  console.log(`StreamBeam is running at http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}`);
  console.log(`  Today answers: ${GEMINI_KEY ? 'Gemini (' + GEMINI_MODEL + ')' : 'off (set GEMINI_API_KEY)'} · VLC relay: ${VLC_ON ? VLC : 'off (set VLC_PASSWORD)'}`);
  if (BIND !== '127.0.0.1' && BIND !== 'localhost' && !APP_PASSWORD) console.warn('  Warning: reachable from other devices without APP_PASSWORD. Anyone on the network can use your Gemini key and VLC.');
});
