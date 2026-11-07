#!/usr/bin/env node
// Points the Android app at your hosted StreamBeam and writes the URL-specific files.
//   node configure.mjs https://streambeam-xxxx.onrender.com [application.id] [versionName] [iptv.application.id]
// The IPTV-only edition (Rity IPTV, product flavor `iptv`) gets its own application id and shortcuts.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [raw, appId = 'app.streambeam.caster', versionName = '1.0', iptvAppId = 'app.rity.iptv'] = process.argv.slice(2);
let url;
try { url = new URL(raw); } catch { url = null; }
if (!url || url.protocol !== 'https:') {
  console.error('Give the app’s https address, e.g. node configure.mjs https://streambeam-xxxx.onrender.com');
  process.exit(1);
}
for (const id of [appId, iptvAppId]) if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(id)) { console.error('Application id looks wrong: ' + id); process.exit(1); }
if (appId === iptvAppId) { console.error('The two editions need different application ids.'); process.exit(1); }

const start = url.origin + (url.pathname.endsWith('/') ? url.pathname : url.pathname + '/');
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '\\"').replace(/'/g, "\\'");
const attr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const SHORTCUTS = [
  ['news', 'News', 'Today’s news'],
  ['weather', 'Weather', 'Today’s weather'],
  ['today', 'Gemini', 'Ask Gemini'],
  ['mirror', 'Mirror', 'Mirror screen']
];
const IPTV_SHORTCUTS = [
  ['live', 'Live TV', 'Live TV'],
  ['movies', 'Movies', 'Movies'],
  ['series', 'Series', 'Series']
];

writeFileSync(path.join(dir, 'twa.properties'),
  `url=${start}\nhost=${url.host}\npath=${url.pathname.replace(/\/+$/, '') || '/'}\napplicationId=${appId}\niptvApplicationId=${iptvAppId}\nversionName=${versionName}\n`);

mkdirSync(path.join(dir, 'app/src/main/res/values'), { recursive: true });
writeFileSync(path.join(dir, 'app/src/main/res/values/twa.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">StreamBeam</string>
    <string name="start_url" translatable="false">${xml(start)}</string>
${[...SHORTCUTS, ...IPTV_SHORTCUTS].map(([id, short, long]) => `    <string name="shortcut_${id}_short">${xml(short)}</string>\n    <string name="shortcut_${id}_long">${xml(long)}</string>`).join('\n')}
</resources>
`);

const shortcutsXml = (list, pkg) => `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${list.map(([id]) => `    <shortcut
        android:shortcutId="${id}"
        android:enabled="true"
        android:icon="@mipmap/ic_launcher"
        android:shortcutShortLabel="@string/shortcut_${id}_short"
        android:shortcutLongLabel="@string/shortcut_${id}_long">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="${attr(pkg)}"
            android:targetClass="app.streambeam.caster.MainActivity"
            android:data="${attr(start + '?go=' + id)}" />
    </shortcut>`).join('\n')}
</shortcuts>
`;
mkdirSync(path.join(dir, 'app/src/main/res/xml'), { recursive: true });
writeFileSync(path.join(dir, 'app/src/main/res/xml/shortcuts.xml'), shortcutsXml(SHORTCUTS, appId));
mkdirSync(path.join(dir, 'app/src/iptv/res/xml'), { recursive: true });
writeFileSync(path.join(dir, 'app/src/iptv/res/xml/shortcuts.xml'), shortcutsXml(IPTV_SHORTCUTS, iptvAppId));

console.log(`Android app → ${start} (StreamBeam ${appId}, Rity IPTV ${iptvAppId}, ${versionName})`);
