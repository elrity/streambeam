// RouterPilot drivers. Each driver talks to one kind of router and offers the same methods:
//   login()                          check the address and password
//   status()  -> {name, model, firmware, uptime, wifiOn, notes[]}
//   devices() -> [{mac, ip, name, online, wifi, signal, blocked, limit:{down,up}, priority}]
//   setBlocked(dev, bool)            stop / restore the device's internet
//   setLimit(dev, {down, up})        speed limit in Mbit/s (0 = no limit)
//   setPriority(dev, 'high'|'normal'|'low')
//   sites() / setSites([domains])    blocked websites
//   reboot()  wifi(bool)             restart; turn Wi-Fi off (comes back on the next restart) or on
'use strict';

const TAG = 'routerpilot';

// ---------- transport ----------
// In the Android app every request goes through window.Native (no CORS, self-signed HTTPS allowed).
// In a browser only the demo works: browsers don't let a web page control a router.
const pending = new Map();
let seq = 0;
window.__nativeDone = (id, json) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  const r = JSON.parse(json);
  r.error ? p.reject(new Error(r.error)) : p.resolve(r);
};

export const hasNative = () => !!(window.Native && window.Native.request);

export function http(method, url, { headers = {}, body = null, insecure = false, timeout = 0 } = {}) {
  if (!hasNative()) {
    return Promise.reject(new Error('Controlling a real router needs the RouterPilot Android app. In the browser you can try the demo.'));
  }
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    window.Native.request(id, JSON.stringify({ method, url, headers, body, insecure, timeout }));
  });
}

const normMac = (m) => (m || '').toLowerCase();
const isMac = (m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(m || '');
const isIp = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip || '');
export const cleanDomain = (d) => (d || '').trim().toLowerCase()
  .replace(/^[a-z]+:\/\//, '').replace(/[/?#:].*$/, '').replace(/^www\./, '').replace(/\.$/, '');
export const isDomain = (d) => /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d);

// =====================================================================================
// OpenWrt (LuCI's JSON-RPC at /ubus). Everything is kept in /etc/routerpilot.json on the router
// and turned into one nftables file (block, limits, priority) and dnsmasq entries (websites).
// =====================================================================================
const NFT_FILE = '/etc/nftables.d/90-routerpilot.nft';
const STATE_FILE = '/etc/routerpilot.json';
const NULL_SID = '00000000000000000000000000000000';
const UBUS_ERR = ['', 'Invalid command', 'Invalid argument', 'Method not found', 'Not found', 'No data',
  'Permission denied', 'Timeout', 'Not supported', 'Unknown error', 'Connection failed'];

export class NeedsSetup extends Error {}

export const OPENWRT_SETUP = `cat > /usr/share/rpcd/acl.d/routerpilot.json <<'EOF'
{
  "routerpilot": {
    "description": "RouterPilot app",
    "read": {
      "ubus": {
        "system": ["board", "info"],
        "iwinfo": ["devices", "assoclist"],
        "network.wireless": ["status"],
        "file": ["read", "exec"],
        "uci": ["get"]
      },
      "file": {
        "/tmp/dhcp.leases": ["read"],
        "/proc/net/arp": ["read"],
        "/etc/routerpilot.json": ["read"]
      },
      "uci": ["dhcp"]
    },
    "write": {
      "ubus": {
        "system": ["reboot"],
        "file": ["write", "exec"],
        "uci": ["set", "commit"]
      },
      "file": {
        "/etc/routerpilot.json": ["write"],
        "/etc/nftables.d/90-routerpilot.nft": ["write"],
        "/sbin/wifi": ["exec"], "/sbin/wifi *": ["exec"],
        "/etc/init.d/firewall": ["exec"], "/etc/init.d/firewall *": ["exec"],
        "/etc/init.d/dnsmasq": ["exec"], "/etc/init.d/dnsmasq *": ["exec"]
      },
      "uci": ["dhcp"]
    }
  }
}
EOF
/etc/init.d/rpcd restart`;

export class OpenWrt {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = `${cfg.https ? 'https' : 'http'}://${cfg.host}`;
    this.sid = null;
    this.rid = 0;
  }

  async raw(sid, obj, method, params = {}) {
    const r = await http('POST', `${this.base}/ubus`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rid, method: 'call', params: [sid, obj, method, params] }),
      insecure: this.cfg.https,
    });
    if (r.status === 404) throw new Error('This router has no /ubus address. Is it OpenWrt with LuCI installed?');
    let j;
    try { j = JSON.parse(r.body); } catch { throw new Error(`The router answered with something unexpected (HTTP ${r.status}).`); }
    if (j.error) { const e = new Error(j.error.message || 'Router error'); e.rpc = j.error.code; throw e; }
    const [code, data] = j.result || [];
    if (code) { const e = new Error(`${obj}.${method}: ${UBUS_ERR[code] || 'error ' + code}`); e.ubus = code; throw e; }
    return data || {};
  }

  async call(obj, method, params) {
    if (!this.sid) await this.login();
    try {
      return await this.raw(this.sid, obj, method, params);
    } catch (e) {
      if (e.rpc !== -32002) throw e;
      // Session expired, or the call isn't allowed. Log in again once to tell the two apart.
      await this.login();
      try {
        return await this.raw(this.sid, obj, method, params);
      } catch (e2) {
        if (e2.rpc === -32002) throw new NeedsSetup('The router refused this action. Run the one-time OpenWrt setup (Router tab).');
        throw e2;
      }
    }
  }

  async login() {
    let d;
    try {
      d = await this.raw(NULL_SID, 'session', 'login', { username: this.cfg.user || 'root', password: this.cfg.pass || '' });
    } catch (e) {
      if (e.ubus === 6 || e.rpc === -32002) throw new Error('Wrong user name or password.');
      throw e;
    }
    this.sid = d.ubus_rpc_session;
    if (!this.sid) throw new Error('Wrong user name or password.');
  }

  async exec(command, params = []) {
    const r = await this.call('file', 'exec', { command, params });
    if (r.code) throw new Error(`${command} ${params.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    return r;
  }

  async readFile(path) {
    try { return (await this.call('file', 'read', { path })).data || ''; } catch (e) {
      if (e.ubus === 4 || e.ubus === 5) return '';
      if (e.ubus === 6) throw new NeedsSetup('The app may not read router files yet. Run the one-time OpenWrt setup (Router tab).');
      throw e;
    }
  }

  async state() {
    const txt = await this.readFile(STATE_FILE);
    let s = {};
    try { s = JSON.parse(txt || '{}'); } catch { s = {}; }
    return { blocked: {}, limits: {}, priority: {}, ips: {}, sites: [], ...s };
  }

  async saveState(s) {
    try {
      await this.call('file', 'write', { path: STATE_FILE, data: JSON.stringify(s, null, 1) });
    } catch (e) {
      if (e.ubus === 6) throw new NeedsSetup('The app may not change router files yet. Run the one-time OpenWrt setup (Router tab).');
      throw e;
    }
  }

  nft(s) {
    const L = ['# Written by the RouterPilot app; it replaces this file on every change.'];
    const fwd = [], mangle = [];
    for (const mac of Object.keys(s.blocked)) {
      if (!s.blocked[mac]) continue;
      fwd.push(`ether saddr ${mac} drop`);
      if (isIp(s.ips[mac])) fwd.push(`ip daddr ${s.ips[mac]} drop`);
    }
    for (const [mac, l] of Object.entries(s.limits)) {
      const ip = s.ips[mac];
      // Mbit/s -> kbytes/s. Packets over the limit are dropped (policing), which TCP turns into that speed.
      if (l.up > 0) fwd.push(`ether saddr ${mac} limit rate over ${Math.max(1, Math.round(l.up * 125))} kbytes/second burst ${Math.max(16, Math.round(l.up * 32))} kbytes drop`);
      if (l.down > 0 && isIp(ip)) fwd.push(`ip daddr ${ip} limit rate over ${Math.max(1, Math.round(l.down * 125))} kbytes/second burst ${Math.max(16, Math.round(l.down * 32))} kbytes drop`);
    }
    for (const [mac, p] of Object.entries(s.priority)) {
      const ip = s.ips[mac];
      if (!isIp(ip) || p === 'normal') continue;
      const dscp = p === 'high' ? 'cs5' : 'cs1';
      mangle.push(`ip saddr ${ip} ip dscp set ${dscp}`, `ip daddr ${ip} ip dscp set ${dscp}`);
    }
    L.push('chain routerpilot_forward {', '\ttype filter hook forward priority -5; policy accept;', ...fwd.map((x) => '\t' + x), '}');
    L.push('chain routerpilot_priority {', '\ttype filter hook postrouting priority -145; policy accept;', ...mangle.map((x) => '\t' + x), '}');
    return L.join('\n') + '\n';
  }

  async applyFirewall(s) {
    await this.saveState(s);
    await this.call('file', 'write', { path: NFT_FILE, data: this.nft(s) });
    await this.exec('/etc/init.d/firewall', ['reload']);
  }

  async status() {
    const [board, info, wl] = await Promise.all([
      this.call('system', 'board'),
      this.call('system', 'info'),
      this.call('network.wireless', 'status').catch(() => ({})),
    ]);
    const radios = Object.values(wl);
    // Check the setup now so the app can say so before the user taps anything.
    let setup = true;
    try { await this.readFile('/tmp/dhcp.leases'); } catch (e) { if (e instanceof NeedsSetup) setup = false; else throw e; }
    return {
      name: board.hostname || 'OpenWrt',
      model: board.model || '',
      firmware: board.release ? board.release.description : '',
      uptime: info.uptime || 0,
      wifiOn: radios.length ? radios.some((r) => r.up) : null,
      needsSetup: !setup,
      notes: [],
    };
  }

  async devices() {
    const [leases, arp, s] = await Promise.all([this.readFile('/tmp/dhcp.leases'), this.readFile('/proc/net/arp'), this.state()]);
    const map = new Map();
    const get = (mac) => { mac = normMac(mac); if (!map.has(mac)) map.set(mac, { mac, ip: '', name: '', online: false, wifi: false, signal: null }); return map.get(mac); };
    for (const line of leases.split('\n')) {
      const [, mac, ip, name] = line.trim().split(/\s+/);
      if (!isMac(mac)) continue;
      const d = get(mac); d.ip = ip; if (name && name !== '*') d.name = name;
    }
    for (const line of arp.split('\n').slice(1)) {
      const [ip, , flags, mac, , dev] = line.trim().split(/\s+/);
      if (!isMac(mac) || mac === '00:00:00:00:00:00' || !/^br-|^lan|^eth|^wlan|^phy/.test(dev || 'br-')) continue;
      const d = get(mac); if (!d.ip) d.ip = ip;
      if (flags === '0x2') d.online = true;
    }
    try {
      const { devices = [] } = await this.call('iwinfo', 'devices');
      for (const dev of devices) {
        const { results = [] } = await this.call('iwinfo', 'assoclist', { device: dev }).catch(() => ({}));
        for (const c of results) { const d = get(c.mac); d.online = true; d.wifi = true; d.signal = c.signal; }
      }
    } catch { /* no Wi-Fi info: fine */ }
    for (const mac of Object.keys({ ...s.blocked, ...s.limits, ...s.priority })) get(mac);
    return [...map.values()].map((d) => ({
      ...d,
      ip: d.ip || s.ips[d.mac] || '',
      blocked: !!s.blocked[d.mac],
      limit: s.limits[d.mac] || { down: 0, up: 0 },
      priority: s.priority[d.mac] || 'normal',
    }));
  }

  async update(dev, fn) {
    const s = await this.state();
    if (isIp(dev.ip)) s.ips[dev.mac] = dev.ip;
    fn(s);
    await this.applyFirewall(s);
  }

  setBlocked(dev, on) { return this.update(dev, (s) => { if (on) s.blocked[dev.mac] = true; else delete s.blocked[dev.mac]; }); }
  setLimit(dev, l) {
    if (l.down > 0 && !isIp(dev.ip)) return Promise.reject(new Error('This device has no IP address yet, so its download can’t be limited.'));
    return this.update(dev, (s) => { if (l.down > 0 || l.up > 0) s.limits[dev.mac] = l; else delete s.limits[dev.mac]; });
  }
  setPriority(dev, p) {
    if (p !== 'normal' && !isIp(dev.ip)) return Promise.reject(new Error('This device has no IP address yet.'));
    return this.update(dev, (s) => { if (p !== 'normal') s.priority[dev.mac] = p; else delete s.priority[dev.mac]; });
  }

  async sites() { return (await this.state()).sites; }

  async setSites(list) {
    const s = await this.state();
    const { values = {} } = await this.call('uci', 'get', { config: 'dhcp', type: 'dnsmasq' });
    const section = Object.keys(values)[0];
    if (!section) throw new Error('No dnsmasq (DNS) settings found on this router.');
    const ours = new Set(s.sites.map((d) => `/${d}/`));
    let addr = values[section].address || [];
    if (!Array.isArray(addr)) addr = [addr];
    // "/example.com/" makes dnsmasq answer "no such site" for example.com and every subdomain.
    const next = addr.filter((a) => !ours.has(a)).concat(list.map((d) => `/${d}/`));
    await this.call('uci', 'set', { config: 'dhcp', section, values: { address: next } });
    await this.call('uci', 'commit', { config: 'dhcp' });
    s.sites = list;
    await this.saveState(s);
    await this.exec('/etc/init.d/dnsmasq', ['restart']);
  }

  async reboot() {
    await this.call('system', 'reboot').catch((e) => { if (!/timeout|reset|closed|failed to connect|EOF/i.test(e.message)) throw e; });
  }

  // "wifi down" doesn't change the saved settings, so Wi-Fi is back after the next restart.
  wifi(on) { return this.exec('/sbin/wifi', [on ? 'up' : 'down']); }
}

// =====================================================================================
// MikroTik RouterOS 7 (REST API at /rest, needs the www or www-ssl service).
// Blocks are raw firewall rules, limits and priority are simple queues, websites are DNS entries.
// Everything the app adds has a comment starting with "routerpilot".
// =====================================================================================
const SCHED = 'routerpilot-wifi-back';

export class MikroTik {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = `${cfg.https ? 'https' : 'http'}://${cfg.host}/rest`;
    this.auth = 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg.user || 'admin'}:${cfg.pass || ''}`)));
  }

  async req(method, path, body, opts = {}) {
    const r = await http(method, this.base + path, {
      headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
      insecure: this.cfg.https,
      ...opts,
    });
    if (r.status === 401) throw new Error('Wrong user name or password.');
    let j = null;
    try { j = r.body ? JSON.parse(r.body) : null; } catch { /* not JSON */ }
    if (r.status >= 400) {
      const e = new Error((j && (j.detail || j.message)) || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  }

  login() { return this.req('GET', '/system/identity'); }

  async wifiIfaces() {
    // RouterOS 7.13+ "wifi" package, then the classic "wireless" package.
    const out = [];
    for (const kind of ['wifi', 'wireless']) {
      try {
        const list = await this.req('GET', `/interface/${kind}`);
        if (Array.isArray(list)) for (const i of list) out.push({ ...i, kind });
      } catch { /* package not installed */ }
    }
    return out;
  }

  async status() {
    const [res, id, ifs] = await Promise.all([this.req('GET', '/system/resource'), this.req('GET', '/system/identity'), this.wifiIfaces()]);
    const notes = [];
    try {
      const dns = await this.req('GET', '/ip/dns');
      if (dns && dns['allow-remote-requests'] === 'false') notes.push('Website blocking needs the router to answer DNS: IP → DNS → Allow Remote Requests.');
    } catch { /* ignore */ }
    return {
      name: id.name || 'MikroTik',
      model: res['board-name'] || '',
      firmware: res.version ? `RouterOS ${res.version}` : '',
      uptime: parseRosDuration(res.uptime),
      wifiOn: ifs.length ? ifs.some((i) => i.disabled !== 'true') : null,
      notes,
    };
  }

  async devices() {
    const [leases, arp, raw, queues] = await Promise.all([
      this.req('GET', '/ip/dhcp-server/lease').catch(() => []),
      this.req('GET', '/ip/arp').catch(() => []),
      this.req('GET', '/ip/firewall/raw'),
      this.req('GET', '/queue/simple'),
    ]);
    const regs = [];
    for (const kind of ['wifi', 'wireless']) {
      try { regs.push(...await this.req('GET', `/interface/${kind}/registration-table`)); } catch { /* none */ }
    }
    const map = new Map();
    const get = (mac) => { mac = normMac(mac); if (!map.has(mac)) map.set(mac, { mac, ip: '', name: '', online: false, wifi: false, signal: null, blocked: false, limit: { down: 0, up: 0 }, priority: 'normal' }); return map.get(mac); };
    for (const l of leases) {
      if (!isMac(l['mac-address'])) continue;
      const d = get(l['mac-address']);
      d.ip = l['active-address'] || l.address || d.ip;
      d.name = l.comment || l['host-name'] || d.name;
      if (l.status === 'bound') d.online = true;
    }
    for (const a of arp) {
      if (!isMac(a['mac-address'])) continue;
      const d = get(a['mac-address']);
      if (!d.ip) d.ip = a.address;
      if (a.complete === 'true' || a.status === 'reachable' || a.status === 'stale') d.online = true;
    }
    for (const r of regs) {
      const d = get(r['mac-address']);
      d.online = true; d.wifi = true;
      const sig = parseInt(r.signal || r['signal-strength'], 10);
      if (!isNaN(sig)) d.signal = sig;
    }
    for (const r of raw) {
      const m = /^routerpilot:block:(.+)$/.exec(r.comment || '');
      if (m) get(m[1]).blocked = true;
    }
    for (const q of queues) {
      const m = /^routerpilot:(.+)$/.exec(q.comment || '');
      if (!m) continue;
      const d = get(m[1]);
      const [up, down] = (q['max-limit'] || '0/0').split('/').map(parseRate);
      d.limit = { down, up };
      const pr = (q.priority || '8/8').split('/')[0];
      d.priority = pr === '1' ? 'high' : pr === '8' ? 'low' : 'normal';
    }
    return [...map.values()];
  }

  async setBlocked(dev, on) {
    const raw = await this.req('GET', '/ip/firewall/raw');
    const mine = raw.filter((r) => r.comment === `routerpilot:block:${dev.mac}`);
    for (const r of mine) await this.req('DELETE', `/ip/firewall/raw/${encodeURIComponent(r['.id'])}`);
    if (!on) return;
    // Raw rules act before connection tracking and FastTrack, so open connections stop too.
    // The device can still reach the router itself (DHCP, DNS, this app).
    await this.req('PUT', '/ip/firewall/raw', {
      chain: 'prerouting', 'src-mac-address': dev.mac.toUpperCase(), 'dst-address-type': '!local',
      action: 'drop', comment: `routerpilot:block:${dev.mac}`,
    });
    if (isIp(dev.ip)) {
      await this.req('PUT', '/ip/firewall/raw', {
        chain: 'prerouting', 'dst-address': dev.ip, 'src-address-type': '!local',
        action: 'drop', comment: `routerpilot:block:${dev.mac}`,
      });
    }
  }

  async queueFor(dev) {
    const qs = await this.req('GET', '/queue/simple');
    return qs.find((q) => q.comment === `routerpilot:${dev.mac}`);
  }

  async writeQueue(dev, limit, priority) {
    const q = await this.queueFor(dev);
    const none = !(limit.down > 0 || limit.up > 0) && priority === 'normal';
    if (none) { if (q) await this.req('DELETE', `/queue/simple/${encodeURIComponent(q['.id'])}`); return; }
    if (!isIp(dev.ip)) throw new Error('This device has no IP address yet.');
    const pr = priority === 'high' ? '1/1' : priority === 'low' ? '8/8' : '4/4';
    const body = {
      name: `routerpilot-${dev.mac.replace(/:/g, '')}`,
      target: `${dev.ip}/32`,
      'max-limit': `${rate(limit.up)}/${rate(limit.down)}`,
      priority: pr,
      comment: `routerpilot:${dev.mac}`,
    };
    if (q) await this.req('PATCH', `/queue/simple/${encodeURIComponent(q['.id'])}`, body);
    else await this.req('PUT', '/queue/simple', body);
    await this.disableFasttrack();
  }

  // FastTrack skips queues, so limits and priority only work with it off.
  async disableFasttrack() {
    const rules = await this.req('GET', '/ip/firewall/filter');
    for (const r of rules) {
      if (r.action === 'fasttrack-connection' && r.disabled !== 'true') {
        await this.req('PATCH', `/ip/firewall/filter/${encodeURIComponent(r['.id'])}`, { disabled: 'true' });
      }
    }
  }

  async setLimit(dev, limit) {
    const cur = (await this.devices()).find((d) => d.mac === dev.mac);
    await this.writeQueue(dev, limit, cur ? cur.priority : 'normal');
  }

  async setPriority(dev, p) {
    const cur = (await this.devices()).find((d) => d.mac === dev.mac);
    await this.writeQueue(dev, cur ? cur.limit : { down: 0, up: 0 }, p);
  }

  async sites() {
    const st = await this.req('GET', '/ip/dns/static');
    return [...new Set(st.filter((e) => e.comment === `${TAG}:site`).map((e) => e.name))];
  }

  async setSites(list) {
    const st = await this.req('GET', '/ip/dns/static');
    const want = new Set(list);
    const have = new Set();
    for (const e of st) {
      if (e.comment !== `${TAG}:site`) continue;
      if (want.has(e.name)) { have.add(`${e.name}|${e.type || 'A'}`); continue; }
      await this.req('DELETE', `/ip/dns/static/${encodeURIComponent(e['.id'])}`);
    }
    for (const d of list) {
      // Answer 0.0.0.0 / :: for the site and all its subdomains, for IPv4 and IPv6.
      if (!have.has(`${d}|A`)) await this.req('PUT', '/ip/dns/static', { name: d, 'match-subdomain': 'true', type: 'A', address: '0.0.0.0', comment: `${TAG}:site` });
      if (!have.has(`${d}|AAAA`)) await this.req('PUT', '/ip/dns/static', { name: d, 'match-subdomain': 'true', type: 'AAAA', address: '::', comment: `${TAG}:site` });
    }
    await this.req('POST', '/ip/dns/cache/flush', {}).catch(() => {});
  }

  async reboot() {
    await this.req('POST', '/system/reboot', {}, { timeout: 8000 }).catch((e) => {
      if (e.status) throw e; // a real error from the router; otherwise the connection just dropped
    });
  }

  async wifi(on) {
    const ifs = await this.wifiIfaces();
    const old = (await this.req('GET', '/system/scheduler')).filter((s) => s.name === SCHED);
    if (!on) {
      const targets = ifs.filter((i) => i.disabled !== 'true');
      if (!targets.length) return;
      for (const s of old) await this.req('DELETE', `/system/scheduler/${encodeURIComponent(s['.id'])}`);
      // Turning an interface off is saved on a MikroTik, so a startup task turns these back on when
      // the router restarts, then removes itself.
      const lines = targets.map((i) => `:do { /interface ${i.kind} enable [find name="${i.name}"] } on-error={}`);
      await this.req('PUT', '/system/scheduler', {
        name: SCHED, 'start-time': 'startup', interval: '0s',
        'on-event': `:delay 3s; ${lines.join('; ')}; /system scheduler remove [find name="${SCHED}"]`,
        comment: 'RouterPilot: Wi-Fi back on after restart',
      });
      for (const i of targets) await this.req('PATCH', `/interface/${i.kind}/${encodeURIComponent(i['.id'])}`, { disabled: 'true' });
    } else {
      const names = new Set();
      for (const s of old) {
        for (const m of (s['on-event'] || '').matchAll(/name="([^"]+)"/g)) names.add(m[1]);
      }
      for (const i of ifs) {
        if (i.disabled === 'true' && (names.size === 0 || names.has(i.name))) {
          await this.req('PATCH', `/interface/${i.kind}/${encodeURIComponent(i['.id'])}`, { disabled: 'false' });
        }
      }
      for (const s of old) await this.req('DELETE', `/system/scheduler/${encodeURIComponent(s['.id'])}`);
    }
  }
}

function rate(mbit) { return mbit > 0 ? `${Math.round(mbit * 1000)}k` : '0'; }
function parseRate(s) {
  const m = /^([\d.]+)\s*([kMG]?)/.exec(s || '0');
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Math.round((m[2] === 'G' ? n * 1000 : m[2] === 'M' ? n : m[2] === 'k' ? n / 1000 : n / 1e6) * 100) / 100;
}
function parseRosDuration(s) {
  let t = 0;
  for (const [, n, u] of (s || '').matchAll(/(\d+)([wdhms])/g)) t += n * { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }[u];
  return t;
}

// =====================================================================================
// Demo: a pretend router so the app can be tried anywhere (and in a browser).
// =====================================================================================
const DEMO_KEY = 'routerpilot.demo';
const demoDefaults = () => ({
  booted: Date.now() - 3 * 86400e3 - 4 * 3600e3,
  wifiOn: true,
  sites: ['tiktok.com'],
  devices: [
    { mac: 'a4:83:e7:12:9c:01', ip: '192.168.1.20', name: 'Living-Room-TV', online: true, wifi: true, signal: -48 },
    { mac: '3c:22:fb:5a:10:7e', ip: '192.168.1.21', name: 'Sara-iPhone', online: true, wifi: true, signal: -57 },
    { mac: 'f0:18:98:44:ab:c3', ip: '192.168.1.22', name: 'Work-Laptop', online: true, wifi: true, signal: -62, priority: 'high' },
    { mac: 'b8:27:eb:00:3d:9a', ip: '192.168.1.30', name: 'PlayStation', online: true, wifi: false, signal: null, limit: { down: 20, up: 5 } },
    { mac: '6c:56:97:e1:22:40', ip: '192.168.1.31', name: 'Kids-Tablet', online: true, wifi: true, signal: -71, blocked: true },
    { mac: '44:65:0d:9b:7f:15', ip: '192.168.1.40', name: 'echo-kitchen', online: false, wifi: true, signal: null },
  ],
});

export class Demo {
  constructor() { this.load(); }
  load() { try { this.s = JSON.parse(localStorage.getItem(DEMO_KEY)) || demoDefaults(); } catch { this.s = demoDefaults(); } }
  save() { try { localStorage.setItem(DEMO_KEY, JSON.stringify(this.s)); } catch { /* private mode */ } }
  wait(ms = 350) { return new Promise((r) => setTimeout(r, ms)); }
  async login() { await this.wait(); }
  async status() {
    await this.wait(200);
    if (Date.now() < this.s.booted) throw new Error('The router is restarting');
    return { name: 'Demo router', model: 'Pretend AX3000', firmware: 'Demo 1.0', uptime: Math.floor((Date.now() - this.s.booted) / 1000), wifiOn: this.s.wifiOn, notes: [] };
  }
  async devices() {
    await this.wait(250);
    if (Date.now() < this.s.booted) throw new Error('The router is restarting');
    return this.s.devices.map((d) => ({
      blocked: false, limit: { down: 0, up: 0 }, priority: 'normal', ...d,
      online: d.online && (!d.wifi || this.s.wifiOn),
      signal: d.wifi && this.s.wifiOn && d.online ? d.signal + Math.round(Math.random() * 4 - 2) : null,
    }));
  }
  dev(mac) { return this.s.devices.find((d) => d.mac === mac); }
  async setBlocked(dev, on) { await this.wait(); this.dev(dev.mac).blocked = on; this.save(); }
  async setLimit(dev, l) { await this.wait(); this.dev(dev.mac).limit = l; this.save(); }
  async setPriority(dev, p) { await this.wait(); this.dev(dev.mac).priority = p; this.save(); }
  async sites() { await this.wait(150); return [...this.s.sites]; }
  async setSites(list) { await this.wait(); this.s.sites = list; this.save(); }
  async reboot() { await this.wait(600); this.s.booted = Date.now() + 15e3; this.s.wifiOn = true; this.save(); }
  async wifi(on) { await this.wait(); this.s.wifiOn = on; this.save(); }
  reset() { this.s = demoDefaults(); this.save(); }
}

export function makeDriver(cfg) {
  if (cfg.type === 'openwrt') return new OpenWrt(cfg);
  if (cfg.type === 'mikrotik') return new MikroTik(cfg);
  return new Demo();
}
