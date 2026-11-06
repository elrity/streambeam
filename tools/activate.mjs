#!/usr/bin/env node
// Makes the activation link for one phone. Only the app's owner can run it: it needs the private key.
//
//   LICENSE_PRIVATE_KEY="$(cat streambeam-license-private-key.pem)" node tools/activate.mjs K7QX2-MRH4D
//   node tools/activate.mjs K7QX2-MRH4D path/to/streambeam-license-private-key.pem
//
// The phone shows its device code on the activation screen. Send the printed link back to that person:
// tapping it on their phone opens StreamBeam and activates it (they can also paste the code). The code fits
// that one phone only, so it can't be passed on with the APK.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const APP_URL = process.env.APP_URL || 'https://elrity.github.io/streambeam/';
const device = (process.argv[2] || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
if (!/^[A-Z2-9]{10}$/.test(device)) {
  console.error('Give the 10-character device code shown on the phone, like K7QX2-MRH4D.');
  process.exit(1);
}
const code = device.slice(0, 5) + '-' + device.slice(5);
const pem = process.argv[3] ? readFileSync(process.argv[3], 'utf8') : process.env.LICENSE_PRIVATE_KEY;
if (!pem) {
  console.error('No private key: set LICENSE_PRIVATE_KEY or give the key file after the device code.');
  process.exit(1);
}
const sig = sign('sha256', Buffer.from('StreamBeam activation ' + code), { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
const act = sig.toString('base64url');
console.log(`Device: ${code}`);
console.log(`Activation code: ${act}`);
console.log(`Activation link: ${APP_URL}?act=${act}`);
