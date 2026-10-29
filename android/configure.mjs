#!/usr/bin/env node
// Points the Android app at your hosted StreamBeam and writes the URL-specific files.
//   node configure.mjs https://streambeam-xxxx.onrender.com [application.id] [versionName]
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const [raw, appId = 'app.streambeam.caster', versionName = '1.0'] = process.argv.slice(2);
let url;
try { url = new URL(raw); } catch { url = null; }
if (!url || url.protocol !== 'https:') {
  console.error('Give the app’s https address, e.g. node configure.mjs https://streambeam-xxxx.onrender.com');
  process.exit(1);
}
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(appId)) { console.error('Application id looks wrong: ' + appId); process.exit(1); }

const start = url.origin + (url.pathname.endsWith('/') ? url.pathname : url.pathname + '/');
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '\\"').replace(/'/g, "\\'");
const attr = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const SHORTCUTS = [
  ['news', 'News', 'Today’s news'],
  ['weather', 'Weather', 'Today’s weather'],
  ['today', 'Gemini', 'Ask Gemini'],
  ['mirror', 'Mirror', 'Mirror screen']
];

writeFileSync(path.join(dir, 'twa.properties'),
  `url=${start}\nhost=${url.host}\npath=${url.pathname.replace(/\/+$/, '') || '/'}\napplicationId=${appId}\nversionName=${versionName}\n`);

mkdirSync(path.join(dir, 'app/src/main/res/values'), { recursive: true });
writeFileSync(path.join(dir, 'app/src/main/res/values/twa.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">StreamBeam</string>
    <string name="start_url" translatable="false">${xml(start)}</string>
${SHORTCUTS.map(([id, short, long]) => `    <string name="shortcut_${id}_short">${xml(short)}</string>\n    <string name="shortcut_${id}_long">${xml(long)}</string>`).join('\n')}
</resources>
`);

mkdirSync(path.join(dir, 'app/src/main/res/xml'), { recursive: true });
writeFileSync(path.join(dir, 'app/src/main/res/xml/shortcuts.xml'), `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${SHORTCUTS.map(([id]) => `    <shortcut
        android:shortcutId="${id}"
        android:enabled="true"
        android:icon="@mipmap/ic_launcher"
        android:shortcutShortLabel="@string/shortcut_${id}_short"
        android:shortcutLongLabel="@string/shortcut_${id}_long">
        <intent
            android:action="android.intent.action.VIEW"
            android:targetPackage="${attr(appId)}"
            android:targetClass="app.streambeam.caster.MainActivity"
            android:data="${attr(start + '?go=' + id)}" />
    </shortcut>`).join('\n')}
</shortcuts>
`);

console.log(`Android app → ${start} (${appId} ${versionName})`);
