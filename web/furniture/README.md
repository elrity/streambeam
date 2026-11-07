# RoomFit

Point your phone at your room and place real-size 3D furniture in it: a velvet
armchair, a curved velvet sofa, a round dining table and a coffee table. These
are real product-style models with photo-based textures, several in more than
one color (credits in [`models/CREDITS.md`](models/CREDITS.md)).

**Open it:** https://elrity.github.io/streambeam/furniture/

## What you need

- **Camera AR:** an Android phone with Chrome and *Google Play Services for AR*
  (most phones from the last few years; Chrome installs it when asked).
- **Any other phone:** basic camera mode. Stand in one spot and turn the phone;
  furniture stays fixed while you turn, and the light is matched from the
  camera picture. It can't find walls or follow you as you walk, and it
  needs the phone's height above the floor, which you set in the room setup.
  The start screen says why
  full AR isn't available and how to fix it (open in Chrome, or install Google
  Play Services for AR).
- **Computers:** the **3D room**: the same furniture and controls in a virtual room.

Add it to the home screen (Chrome menu → *Install app*) to open it like an app.
After the first visit it also works offline.

## How to use it

1. Tap **Open camera in my room** and allow the camera.
2. **Set the floor.** Full AR: move the phone slowly until dots appear on the
   floor, aim the circle at the floor (not a table or a rug edge) and tap
   **Set floor**. Basic camera: aim at the floor and move the **Phone height**
   slider until the green square looks like 1 × 1 m on your floor, then tap
   **Set floor**.
3. **Mark the walls.** Aim the circle where a wall meets the floor and tap
   **Add point** (or tap that spot on the screen), then do the same further
   along the same wall. Mark as many walls as you like; **Undo** takes back the
   last point or wall. Tap **Done**. In full AR, walls the phone finds by
   itself are used too and light up yellow. The house button at the top opens
   the setup again.
4. **Add furniture:** drag a card from the bottom up into the room, or tap a
   card to drop it on the white circle. Tap a card again to add another one;
   it lands next to the first.
5. **Move:** drag a piece along the floor. It can't go through a wall. A sofa
   or chair pushed against a wall turns to stand with its back to it, and the
   phone gives a short buzz.
6. **Turn:** twist two fingers on the screen, use the turn buttons (15° at a
   time), or drag along the strip in the panel.
7. **Color, copy, delete:** with a piece selected, tap a color dot to change
   its finish, the copy button to add another of the same piece, or the bin to
   delete it. The round arrow at the top right removes everything (tap twice).

Walk around: each piece is pinned to the room, so it stays where you put it.
Pieces always stand on the floor you set: they drop onto it when you let go,
stay upright, and follow the floor height if you set it again.

## How it works

It's one web page using [WebXR](https://immersive-web.github.io/webxr/) and
three.js (in `vendor/`, MIT license):

| WebXR feature | What it does here |
| --- | --- |
| `hit-test` | Nine rays from the camera find real surfaces every frame. Flat hits vote on the floor height (the lowest well-supported level wins, so a table top isn't taken for the floor); upright hits are grouped into walls. |
| `plane-detection` | Used when the phone offers it: whole floor and wall planes. |
| `anchors` | Each piece is pinned to the room once you let go, so it stays put while you walk around. |
| `light-estimation` | The room's main light direction, color and brightness, its ambient light, and a reflection map light the furniture. Shadows fall the same way as the room's, and are crisp or soft to match. Before an estimate arrives (or on phones without it), a neutral studio light is used. |
| `dom-overlay` | The buttons and the catalog are drawn over the camera view. |

The furniture comes from glTF models (`models/`) at real size, with velvet
sheen and the colors stored in the files. Each is placed so its lowest point
sits exactly on the floor, with a soft contact shadow under it. If a model
can't load, a simpler piece modeled in code (`furniture.js`) stands in.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: start screen, overlay controls, styles. |
| `app.js` | AR session, floor and wall finding, anchors, lighting, gestures, 3D room. |
| `furniture.js` | The catalog: loads the models, their colors and sizes; backup pieces modeled in code. |
| `models/` | The 3D models and their credits. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install and offline support. |
| `vendor/` | three.js 0.170.0 and some of its add-ons (glTF loader, rounded box, studio light). |

To try it locally, serve `web/` (for example `python3 -m http.server` in
`web/`) and open `http://localhost:8000/furniture/`. Add `?preview` to the
address to go straight to the 3D room. The camera needs https, so to test AR on
a phone use the GitHub Pages address, or Chrome's port forwarding to localhost.
