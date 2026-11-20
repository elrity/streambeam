// RouterPilot: control your home router from your phone.
import { makeDriver, hasNative, NeedsSetup, OPENWRT_SETUP, cleanDomain, isDomain } from './drivers.js';

const APK_URL = 'https://github.com/elrity/streambeam/releases?q=routerpilot&expanded=true';
const CFG_KEY = 'routerpilot.cfg';
const NAMES_KEY = 'routerpilot.names';
const TAB_KEY = 'routerpilot.tab';

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const I = {
  router: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 13V9M17 13V9M9.5 7.5a4 4 0 0 1 5 0M7.5 5a7 7 0 0 1 9 0"/><circle cx="7" cy="16.5" r=".6" fill="currentColor"/><circle cx="10" cy="16.5" r=".6" fill="currentColor"/></svg>',
  devices: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2" y="4" width="14" height="10" rx="2"/><path d="M6 18h6"/><rect x="17" y="8" width="5" height="12" rx="1.5"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  tv: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  game: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 15h-4l-1 .6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4z"/><path d="M7 11v3M5.5 12.5h3"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2" width="12" height="20" rx="3"/><circle cx="12" cy="14" r="3"/><circle cx="12" cy="6.5" r=".8" fill="currentColor"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M15 5l-7 7 7 7"/></svg>',
  power: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>',
  wifi: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10.5 10.5 0 0 1 14 0M8.5 15.5a5.5 5.5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};

function deviceIcon(name) {
  const n = (name || '').toLowerCase();
  if (/tv|roku|chromecast|firestick|fire-tv|shield|bravia|android-tv/.test(n)) return I.tv;
  if (/playstation|ps4|ps5|xbox|switch|nintendo|steam/.test(n)) return I.game;
  if (/echo|alexa|google-home|nest|sonos|homepod|speaker/.test(n)) return I.speaker;
  if (/laptop|macbook|desktop|pc|windows|thinkpad|dell|hp-|lenovo|surface|imac/.test(n)) return I.laptop;
  return I.phone;
}

function uptime(s) {
  if (!s && s !== 0) return '';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const mbps = (v) => (v >= 1 ? `${+v.toFixed(1)} Mbps` : `${Math.round(v * 1000)} kbps`);

// ---------------------------------------------------------------- state
const S = {
  cfg: store.get(CFG_KEY, null),
  names: store.get(NAMES_KEY, {}),
  tab: store.get(TAB_KEY, 'devices'),
  driver: null,
  status: null,
  devices: [],
  sites: [],
  loading: false,
  error: '',
  filter: 'all',
  sheet: null, // mac of the open device
};

// ---------------------------------------------------------------- small UI helpers
let toastTimer;
function toast(msg, bad = false) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 2800);
}

function confirmBox({ title, body, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'sheet-bg center';
    bg.innerHTML = `<div class="dialog" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><div class="muted">${body}</div>
      <div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(ok)}</button></div></div>`;
    const done = (v) => { bg.remove(); popBack = null; resolve(v); };
    bg.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) done(a === 'yes'); else if (e.target === bg) done(false); });
    popBack = () => done(false);
    document.body.appendChild(bg);
  });
}

let popBack = null;
window.onNativeBack = () => {
  if (popBack) { popBack(); return true; }
  if (S.sheet) { closeSheet(); return true; }
  if (S.cfg && S.tab !== 'devices') { setTab('devices'); return true; }
  return false;
};

async function busy(btn, fn) {
  const html = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

function errMsg(e) {
  const m = e && e.message ? e.message : String(e);
  if (/failed to connect|unable to resolve|timeout|timed out|unreachable|ECONNREFUSED|connection refused/i.test(m)) {
    return `Can't reach the router at ${S.cfg?.host}. Is this phone on the router's network?`;
  }
  return m;
}

// ---------------------------------------------------------------- connect screen
function renderConnect(prefill) {
  const c = prefill || S.cfg || { type: hasNative() ? 'openwrt' : 'demo', host: '', user: '', pass: '', https: false, remember: true };
  const gw = hasNative() ? window.Native.gateway() : '';
  if (!c.host) c.host = gw || '192.168.1.1';
  const users = { openwrt: 'root', mikrotik: 'admin' };
  $app.innerHTML = `<div class="wrap">
    <div class="hero" style="color:var(--accent)">${I.router.replace('width="22" height="22"', '')}
      <h1 style="margin-top:8px">RouterPilot</h1><p class="muted">Control your home router from your phone</p></div>
    ${hasNative() ? '' : `<div class="info">In a web browser you can try the <b>demo</b>. To control a real router, install the
      <a href="${APK_URL}" target="_blank" rel="noopener">RouterPilot Android app</a>: browsers don't let web pages talk to routers.</div>`}
    <div class="card">
      <div class="types" id="types">
        <button data-t="openwrt"><b>OpenWrt</b><small>LuCI routers</small></button>
        <button data-t="mikrotik"><b>MikroTik</b><small>RouterOS 7</small></button>
        <button data-t="demo"><b>Demo</b><small>Try it out</small></button>
      </div>
      <form id="f" autocomplete="off">
        <div id="real">
          <label class="field"><span>Router address</span><input id="host" type="text" inputmode="url" value="${esc(c.host)}" placeholder="192.168.1.1"></label>
          <div class="two">
            <label class="field"><span>User name</span><input id="user" type="text" autocapitalize="off" value="${esc(c.user || users[c.type] || '')}"></label>
            <label class="field"><span>Password</span><input id="pass" type="password" value="${esc(c.pass || '')}"></label>
          </div>
          <label class="check"><input id="https" type="checkbox" ${c.https ? 'checked' : ''}> Use HTTPS (self-signed certificates are accepted)</label>
          <label class="check"><input id="remember" type="checkbox" ${c.remember !== false ? 'checked' : ''}> Remember the password on this phone</label>
        </div>
        <div id="err"></div>
        <button class="btn primary block" id="go" type="submit">Connect</button>
      </form>
    </div>
    <p class="small muted" id="hint" style="padding:0 4px"></p>
  </div>`;
  let type = c.type;
  const hints = {
    openwrt: 'Use your LuCI login (normally root). The first time, the Router tab shows a one-time setup that lets the app change settings.',
    mikrotik: 'Needs RouterOS 7 with the www (or www-ssl) service on: IP → Services. Use an account in the full group.',
    demo: 'A pretend router with a few devices, so you can see how everything works. Nothing real changes.',
  };
  const setType = (t) => {
    type = t;
    document.querySelectorAll('#types button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    document.getElementById('real').classList.toggle('hidden', t === 'demo');
    document.getElementById('hint').textContent = hints[t];
    const u = document.getElementById('user');
    if (!u.value || Object.values(users).includes(u.value)) u.value = users[t] || '';
  };
  document.getElementById('types').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { e.preventDefault(); setType(b.dataset.t); } });
  setType(type);
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = {
      type,
      host: document.getElementById('host').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
      user: document.getElementById('user').value.trim(),
      pass: document.getElementById('pass').value,
      https: document.getElementById('https').checked,
      remember: document.getElementById('remember').checked,
    };
    const errBox = document.getElementById('err');
    errBox.innerHTML = '';
    if (type !== 'demo' && !hasNative()) {
      errBox.innerHTML = `<div class="err">A browser can't control a real router. Install the <a href="${APK_URL}" target="_blank" rel="noopener">Android app</a>, or pick Demo.</div>`;
      return;
    }
    if (type !== 'demo' && !cfg.host) { errBox.innerHTML = '<div class="err">Enter the router address.</div>'; return; }
    await busy(document.getElementById('go'), async () => {
      try {
        const d = makeDriver(cfg);
        await d.login();
        S.cfg = cfg;
        store.set(CFG_KEY, cfg.remember ? cfg : { ...cfg, pass: '' });
        S.driver = d;
        S.status = null; S.devices = []; S.sites = [];
        renderMain();
        refresh();
      } catch (err) {
        S.cfg = S.cfg || null;
        errBox.innerHTML = `<div class="err">${esc(errMsg(err))}</div>`;
      }
    });
  });
}

// ---------------------------------------------------------------- main screen
function setTab(t) {
  S.tab = t;
  store.set(TAB_KEY, t);
  renderMain();
  if (t === 'sites' && S.driver) loadSites();
}

async function refresh() {
  if (!S.driver) return;
  S.loading = true; S.error = '';
  renderMain();
  try {
    S.status = await S.driver.status();
    S.devices = await S.driver.devices();
  } catch (e) {
    S.error = e instanceof NeedsSetup ? e.message : errMsg(e);
    if (e instanceof NeedsSetup) S.status = { ...(S.status || {}), needsSetup: true };
  }
  S.loading = false;
  renderMain();
  if (S.tab === 'sites') loadSites();
}

async function loadSites() {
  try { S.sites = await S.driver.sites(); } catch (e) { S.error = errMsg(e); }
  if (S.tab === 'sites') renderMain();
}

const label = (d) => S.names[d.mac] || d.name || d.mac.toUpperCase();

function devChips(d) {
  const c = [];
  if (d.blocked) c.push('<span class="chip bad">Internet stopped</span>');
  if (d.limit && (d.limit.down > 0 || d.limit.up > 0)) {
    c.push(`<span class="chip warn">Limit ${d.limit.down > 0 ? '↓' + mbps(d.limit.down) : ''}${d.limit.down > 0 && d.limit.up > 0 ? ' ' : ''}${d.limit.up > 0 ? '↑' + mbps(d.limit.up) : ''}</span>`);
  }
  if (d.priority === 'high') c.push('<span class="chip ok">High priority</span>');
  if (d.priority === 'low') c.push('<span class="chip grey">Low priority</span>');
  return c.length ? `<div class="chips">${c.join('')}</div>` : '';
}

function viewDevices() {
  const all = S.devices.slice().sort((a, b) => (b.online - a.online) || label(a).localeCompare(label(b)));
  const list = S.filter === 'online' ? all.filter((d) => d.online) : S.filter === 'managed' ? all.filter((d) => d.blocked || d.priority !== 'normal' || d.limit.down || d.limit.up) : all;
  const online = all.filter((d) => d.online).length;
  const stopped = all.filter((d) => d.blocked).length;
  return `
    <div class="row" style="margin:16px 4px 8px">
      <div class="grow small muted">${all.length} devices · ${online} online${stopped ? ` · ${stopped} stopped` : ''}</div>
    </div>
    <div class="seg" style="margin-bottom:12px" id="filter">
      ${[['all', 'All'], ['online', 'Online'], ['managed', 'With rules']].map(([k, t]) => `<button data-f="${k}" class="${S.filter === k ? 'on' : ''}">${t}</button>`).join('')}
    </div>
    <div class="card list">
      ${list.length ? list.map((d) => `
        <div class="dev" data-mac="${esc(d.mac)}">
          <div class="ico ${d.blocked ? 'blocked' : ''}">${deviceIcon(label(d) + ' ' + d.name)}<i class="${d.online ? 'on' : ''}"></i></div>
          <div class="grow">
            <div class="name">${esc(label(d))}</div>
            <div class="sub">${esc(d.ip || 'No IP')} · ${d.online ? (d.wifi ? `Wi-Fi${d.signal != null ? ` ${d.signal} dBm` : ''}` : 'Online') : 'Offline'}</div>
            ${devChips(d)}
          </div>
        </div>`).join('') : `<div class="empty">${S.loading ? 'Loading devices…' : 'No devices here.'}</div>`}
    </div>`;
}

function viewSites() {
  return `
    <h2>Blocked websites</h2>
    <div class="card">
      <form id="addsite" class="row" autocomplete="off">
        <input class="grow" id="site" type="text" inputmode="url" autocapitalize="off" placeholder="example.com">
        <button class="btn primary" id="addbtn" type="submit">Block</button>
      </form>
      <div class="presets" style="margin:10px 0 0">
        ${['facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'roblox.com', 'x.com'].filter((d) => !S.sites.includes(d))
          .map((d) => `<button data-add="${d}">+ ${d}</button>`).join('')}
      </div>
    </div>
    <div class="card list">
      ${S.sites.length ? S.sites.map((d) => `<div class="site"><span class="grow">${I.globe.replace('width="22" height="22"', 'width="18" height="18" style="vertical-align:-3px;color:var(--muted);margin-right:8px"')}${esc(d)}</span>
        <button class="btn icon" data-del="${esc(d)}" aria-label="Unblock ${esc(d)}">${I.trash}</button></div>`).join('')
        : '<div class="empty">No websites blocked.</div>'}
    </div>
    <p class="small muted" style="padding:0 4px">Blocks the site and all its subdomains for every device that uses the router for DNS (the normal setup).
      A device using a VPN or its own "Private DNS" can get around it.</p>`;
}

function viewRouter() {
  const st = S.status || {};
  const t = S.cfg.type;
  const wifiOff = st.wifiOn === false;
  return `
    <h2>Router</h2>
    <div class="card">
      <dl class="kv">
        <dt>Name</dt><dd>${esc(st.name || '—')}</dd>
        <dt>Model</dt><dd>${esc(st.model || '—')}</dd>
        <dt>Software</dt><dd>${esc(st.firmware || '—')}</dd>
        <dt>Address</dt><dd>${esc(t === 'demo' ? 'demo' : S.cfg.host)}</dd>
        <dt>Running for</dt><dd>${esc(uptime(st.uptime) || '—')}</dd>
      </dl>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:12px"><div style="color:var(--accent)">${I.power}</div>
        <div class="grow"><b>Restart router</b><div class="small muted">Everyone is offline for 1–2 minutes. Turns Wi-Fi back on if it was off.</div></div></div>
      <button class="btn danger block" id="reboot">Restart now</button>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:12px"><div style="color:var(--accent)">${I.wifi}</div>
        <div class="grow"><b>Wi-Fi is ${st.wifiOn == null ? 'unknown' : wifiOff ? 'off' : 'on'}</b>
          <div class="small muted">${wifiOff ? 'Devices with a cable still work. Restarting the router also turns Wi-Fi back on.'
            : 'Turning it off disconnects every Wi-Fi device (this phone too, if it’s on Wi-Fi). It comes back on the next time the router restarts.'}</div></div></div>
      <button class="btn ${wifiOff ? 'primary' : 'danger'} block" id="wifi">${wifiOff ? 'Turn Wi-Fi on' : 'Turn Wi-Fi off'}</button>
    </div>
    ${t === 'openwrt' ? `
    <div class="card">
      <b>One-time OpenWrt setup</b> ${st.needsSetup ? '<span class="chip bad">needed</span>' : '<span class="chip ok">done</span>'}
      <p class="small muted" style="margin-top:6px">Lets the app read the device list and change the firewall, DNS and Wi-Fi. Run this once on the router
        (System → Custom Commands, or SSH), then tap Refresh.</p>
      <pre class="code" id="setup">${esc(OPENWRT_SETUP)}</pre>
      <button class="btn block" id="copysetup">Copy setup commands</button>
    </div>` : ''}
    ${t === 'mikrotik' ? `<div class="info small">Speed limits and priority use simple queues. FastTrack skips queues, so the app turns FastTrack off the first time you set one.</div>` : ''}
    ${t === 'openwrt' ? `<div class="info small">Priority marks the device's traffic (DSCP). It takes effect when SQM (cake) with diffserv is set up on the router.</div>` : ''}
    <h2>Connection</h2>
    <div class="card">
      ${t !== 'demo' ? `<button class="btn block" id="admin" style="margin-bottom:8px">Open the router's own page</button>` : '<button class="btn block" id="resetdemo" style="margin-bottom:8px">Reset the demo</button>'}
      <button class="btn block" id="logout">Change router / sign out</button>
    </div>
    <p class="small muted" style="text-align:center">RouterPilot ${hasNative() && window.Native.version ? esc(window.Native.version()) : 'web'}</p>`;
}

function renderMain() {
  if (!S.cfg) return renderConnect();
  const st = S.status;
  const wifi = st && st.wifiOn != null ? (st.wifiOn ? '<span class="chip ok">Wi-Fi on</span>' : '<span class="chip bad">Wi-Fi off</span>') : '';
  const body = S.tab === 'sites' ? viewSites() : S.tab === 'router' ? viewRouter() : viewDevices();
  const scroll = window.scrollY;
  $app.innerHTML = `<div class="wrap">
    <div class="top">
      <div class="grow">
        <h1>${esc(st?.name || (S.cfg.type === 'demo' ? 'Demo router' : S.cfg.host))}</h1>
        <div class="small muted">${esc([st?.model, st?.firmware].filter(Boolean).join(' · ') || (S.loading ? 'Connecting…' : ''))}</div>
        <div class="chips">${wifi}${st?.uptime != null ? `<span class="chip grey">Up ${uptime(st.uptime)}</span>` : ''}${S.cfg.type === 'demo' ? '<span class="chip warn">Demo</span>' : ''}</div>
      </div>
      <button class="btn icon" id="refresh" aria-label="Refresh">${S.loading ? '<span class="spinner"></span>' : I.refresh}</button>
    </div>
    ${S.error ? `<div class="err" style="margin-top:12px">${esc(S.error)}</div>` : ''}
    ${(st?.notes || []).map((n) => `<div class="note" style="margin-top:12px">${esc(n)}</div>`).join('')}
    ${st?.needsSetup && S.tab !== 'router' ? `<div class="note" style="margin-top:12px">One-time setup needed so the app can make changes. <a href="#" id="gosetup">Show me</a></div>` : ''}
    ${body}
  </div>
  <nav class="tabs">
    <button data-tab="devices" class="${S.tab === 'devices' ? 'on' : ''}">${I.devices}Devices</button>
    <button data-tab="sites" class="${S.tab === 'sites' ? 'on' : ''}">${I.globe}Websites</button>
    <button data-tab="router" class="${S.tab === 'router' ? 'on' : ''}">${I.router}Router</button>
  </nav>`;
  window.scrollTo(0, scroll);
  if (S.sheet) renderSheet();
}

// ---------------------------------------------------------------- device sheet
function closeSheet() {
  S.sheet = null;
  document.querySelector('.sheet-bg.dev-sheet')?.remove();
}

function renderSheet() {
  const d = S.devices.find((x) => x.mac === S.sheet);
  document.querySelector('.sheet-bg.dev-sheet')?.remove();
  if (!d) { S.sheet = null; return; }
  const bg = document.createElement('div');
  bg.className = 'sheet-bg dev-sheet';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">
    <div class="grab"></div>
    <div class="row" style="margin-bottom:8px">
      <div class="dev" style="padding:0;border:0;cursor:default"><div class="ico ${d.blocked ? 'blocked' : ''}">${deviceIcon(label(d) + ' ' + d.name)}<i class="${d.online ? 'on' : ''}"></i></div></div>
      <input class="grow" id="nick" type="text" value="${esc(label(d))}" aria-label="Device name" style="font-weight:600">
    </div>
    <dl class="kv">
      <dt>IP address</dt><dd>${esc(d.ip || '—')}</dd>
      <dt>MAC</dt><dd>${esc(d.mac.toUpperCase())}</dd>
      <dt>Connection</dt><dd>${d.online ? (d.wifi ? `Wi-Fi${d.signal != null ? `, ${d.signal} dBm` : ''}` : 'Online') : 'Offline'}</dd>
      ${d.name && S.names[d.mac] ? `<dt>Calls itself</dt><dd>${esc(d.name)}</dd>` : ''}
    </dl>

    <h2>Internet</h2>
    <div class="card big-toggle">
      <div class="grow"><b>${d.blocked ? 'Stopped' : 'Allowed'}</b><div class="small muted">${d.blocked ? 'This device stays on the network but can’t reach the internet.' : 'Switch off to cut this device’s internet.'}</div></div>
      <label class="switch"><input type="checkbox" id="inet" ${d.blocked ? '' : 'checked'} aria-label="Internet allowed"><span></span></label>
    </div>

    <h2>Speed limit</h2>
    <div class="card">
      <div class="two">
        <label class="field"><span>Download (Mbps)</span><input id="down" type="number" min="0" step="0.5" inputmode="decimal" value="${d.limit.down || ''}" placeholder="No limit"></label>
        <label class="field"><span>Upload (Mbps)</span><input id="up" type="number" min="0" step="0.5" inputmode="decimal" value="${d.limit.up || ''}" placeholder="No limit"></label>
      </div>
      <div class="presets" id="presets">
        <button data-p="0,0">No limit</button><button data-p="1,0.5">1 Mbps</button><button data-p="5,1">5 Mbps</button>
        <button data-p="10,2">10 Mbps</button><button data-p="25,5">25 Mbps</button><button data-p="50,10">50 Mbps</button>
      </div>
      <button class="btn primary block" id="savelimit">Save speed limit</button>
    </div>

    <h2>Priority</h2>
    <div class="card">
      <div class="seg" id="prio">
        ${['low', 'normal', 'high'].map((p) => `<button data-p="${p}" class="${d.priority === p ? 'on' : ''}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}
      </div>
      <p class="small muted" style="margin:10px 0 0">High priority keeps calls, games and work smooth when the connection is busy; low lets downloads wait.</p>
    </div>
  </div>`;
  document.body.appendChild(bg);

  bg.addEventListener('click', (e) => { if (e.target === bg) closeSheet(); });
  const nick = bg.querySelector('#nick');
  nick.addEventListener('change', () => {
    const v = nick.value.trim();
    if (v && v !== d.name) S.names[d.mac] = v; else delete S.names[d.mac];
    store.set(NAMES_KEY, S.names);
    renderList();
  });
  bg.querySelector('#inet').addEventListener('change', async (e) => {
    const allow = e.target.checked;
    e.target.disabled = true;
    try {
      await S.driver.setBlocked(d, !allow);
      d.blocked = !allow;
      toast(allow ? `${label(d)} is back online` : `${label(d)}'s internet is stopped`);
    } catch (err) {
      e.target.checked = !allow;
      toast(errMsg(err), true);
    }
    e.target.disabled = false;
    renderSheet(); renderList();
  });
  bg.querySelector('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const [dn, up] = b.dataset.p.split(',');
    bg.querySelector('#down').value = +dn || '';
    bg.querySelector('#up').value = +up || '';
  });
  bg.querySelector('#savelimit').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    const l = { down: Math.max(0, +bg.querySelector('#down').value || 0), up: Math.max(0, +bg.querySelector('#up').value || 0) };
    try {
      await S.driver.setLimit(d, l);
      d.limit = l;
      toast(l.down || l.up ? 'Speed limit saved' : 'Speed limit removed');
      renderList();
    } catch (err) { toast(errMsg(err), true); }
  }));
  bg.querySelector('#prio').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.p === d.priority) return;
    const p = b.dataset.p;
    try {
      await busy(b, () => S.driver.setPriority(d, p));
      d.priority = p;
      toast(`Priority: ${p}`);
      renderSheet(); renderList();
    } catch (err) { toast(errMsg(err), true); }
  });
}

// Re-draw the device list under the sheet without closing it.
function renderList() {
  if (S.tab !== 'devices') return;
  const keep = S.sheet;
  S.sheet = null;
  renderMain();
  S.sheet = keep;
}

// ---------------------------------------------------------------- router actions
async function waitForRouter(title, lines) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div><span class="spinner"></span><h1>${esc(title)}</h1><p class="muted" id="ovmsg" style="max-width:340px;margin:8px auto 0">${lines}</p></div>`;
  document.body.appendChild(ov);
  const start = Date.now();
  await new Promise((r) => setTimeout(r, S.cfg.type === 'demo' ? 3000 : 20000));
  while (Date.now() - start < 5 * 60e3) {
    try {
      if (S.cfg.type !== 'demo') S.driver = makeDriver(S.cfg);
      await S.driver.login();
      const st = await S.driver.status();
      if (st) break;
    } catch { /* still restarting */ }
    await new Promise((r) => setTimeout(r, 4000));
  }
  ov.remove();
  refresh();
}

async function doReboot() {
  const ok = await confirmBox({ title: 'Restart the router?', body: 'Everyone loses internet for 1–2 minutes. Wi-Fi comes back on if it was off.', ok: 'Restart', danger: true });
  if (!ok) return;
  try {
    await S.driver.reboot();
  } catch (e) { toast(errMsg(e), true); return; }
  waitForRouter('Restarting the router…', 'This usually takes 1–2 minutes. The app reconnects by itself when the router is back.');
}

async function doWifi(btn) {
  const on = S.status && S.status.wifiOn === false;
  if (!on) {
    const ok = await confirmBox({
      title: 'Turn Wi-Fi off?',
      body: 'Every Wi-Fi device disconnects, <b>this phone too if it’s on this Wi-Fi</b>. Devices with a cable keep working.<br><br>To bring Wi-Fi back: restart the router (unplug it for 10 seconds), or turn it on here from a device with a cable.',
      ok: 'Turn off', danger: true,
    });
    if (!ok) return;
  }
  await busy(btn, async () => {
    try {
      await S.driver.wifi(on);
      S.status = { ...S.status, wifiOn: on };
      toast(on ? 'Wi-Fi is on' : 'Wi-Fi is off');
      renderMain();
      if (on) setTimeout(refresh, 4000);
    } catch (e) {
      if (!on && /reach|connect|timeout|reset|closed/i.test(e.message)) {
        S.status = { ...S.status, wifiOn: false };
        renderMain();
        toast('Wi-Fi is off, and this phone lost its connection to the router.');
      } else toast(errMsg(e), true);
    }
  });
}

async function addSites(list, btn) {
  const add = list.map(cleanDomain).filter(Boolean);
  const bad = add.find((d) => !isDomain(d));
  if (bad) { toast(`"${bad}" isn’t a website address like example.com`, true); return; }
  const next = [...new Set([...S.sites, ...add])];
  await busy(btn, async () => {
    try { await S.driver.setSites(next); S.sites = next; toast(`Blocked ${add.join(', ')}`); renderMain(); } catch (e) { toast(errMsg(e), true); }
  });
}

// ---------------------------------------------------------------- events
$app.addEventListener('click', async (e) => {
  const t = e.target;
  const tab = t.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  if (t.closest('#refresh')) return refresh();
  if (t.closest('#gosetup')) { e.preventDefault(); return setTab('router'); }
  const f = t.closest('#filter button');
  if (f) { S.filter = f.dataset.f; return renderMain(); }
  const dev = t.closest('.dev[data-mac]');
  if (dev) { S.sheet = dev.dataset.mac; return renderSheet(); }
  const add = t.closest('[data-add]');
  if (add) return addSites([add.dataset.add], add);
  const del = t.closest('[data-del]');
  if (del) {
    const next = S.sites.filter((d) => d !== del.dataset.del);
    return busy(del, async () => {
      try { await S.driver.setSites(next); S.sites = next; toast(`Unblocked ${del.dataset.del}`); renderMain(); } catch (err) { toast(errMsg(err), true); }
    });
  }
  if (t.closest('#reboot')) return doReboot();
  if (t.closest('#wifi')) return doWifi(t.closest('#wifi'));
  if (t.closest('#admin')) {
    const url = `${S.cfg.https ? 'https' : 'http'}://${S.cfg.host}/`;
    return hasNative() ? window.Native.openUrl(url) : window.open(url, '_blank', 'noopener');
  }
  if (t.closest('#copysetup')) {
    try { await navigator.clipboard.writeText(OPENWRT_SETUP); toast('Copied'); } catch {
      const r = document.createRange(); r.selectNodeContents(document.getElementById('setup'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Selected: long-press to copy');
    }
    return;
  }
  if (t.closest('#resetdemo')) { S.driver.reset(); toast('Demo reset'); return refresh(); }
  if (t.closest('#logout')) {
    const ok = await confirmBox({ title: 'Change router?', body: 'The saved password is removed from this phone. Rules already on the router stay as they are.', ok: 'Sign out' });
    if (!ok) return;
    const prev = S.cfg;
    store.del(CFG_KEY);
    S.cfg = null; S.driver = null; S.status = null; S.devices = []; S.error = '';
    renderConnect({ ...prev, pass: '' });
  }
});

$app.addEventListener('submit', (e) => {
  if (e.target.id !== 'addsite') return;
  e.preventDefault();
  const inp = document.getElementById('site');
  const v = inp.value.trim();
  if (!v) return;
  addSites(v.split(/[\s,]+/), document.getElementById('addbtn'));
});

// ---------------------------------------------------------------- start
if (S.cfg && (S.cfg.type === 'demo' || (hasNative() && S.cfg.pass))) {
  S.driver = makeDriver(S.cfg);
  renderMain();
  refresh();
} else {
  renderConnect(S.cfg);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.driver && !S.loading) refresh(); });
