# RoomFit

Point your phone at your room and place real-size 3D furniture in it: a dining
chair, a 3-seat sofa and a dining table, each in several finishes.

**Open it:** https://elrity.github.io/streambeam/furniture/

## What you need

- **Camera AR:** an Android phone with Chrome and *Google Play Services for AR*
  (most phones from the last few years; Chrome installs it when asked).
- **iPhone and computers:** Safari can't run web AR yet, so these get the
  **3D room** instead: the same furniture and controls in a virtual room.

Add it to the home screen (Chrome menu → *Install app*) to open it like an app.
After the first visit it also works offline.

## How to use it

1. Tap **Open camera in my room** and allow the camera.
2. Point at the floor and move the phone slowly from side to side. A dotted
   floor appears and the top shows **Floor found**. Walls light up yellow as
   they are found, and the top counts them.
3. **Add furniture:** drag a card from the bottom up into the room, or tap a
   card to drop it on the white circle. Tap a card again to add another one;
   it lands next to the first.
4. **Move:** drag a piece along the floor. It can't go through a wall. A sofa
   or chair pushed against a wall turns to stand with its back to it, and the
   phone gives a short buzz.
5. **Turn:** twist two fingers on the screen, use the turn buttons (15° at a
   time), or drag along the strip in the panel.
6. **Finish, copy, delete:** with a piece selected, tap a color dot to change
   its finish, the copy button to add another of the same piece, or the bin to
   delete it. The round arrow at the top right removes everything (tap twice).

Walk around: each piece is pinned to the room, so it stays where you put it.

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

The furniture is modeled in code at real sizes (`furniture.js`), with
physically based materials: oak, walnut, white and black wood with generated
grain, and woven upholstery with fabric sheen (one velvet). Each piece has a
soft contact shadow so it sits on the floor.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page: start screen, overlay controls, styles. |
| `app.js` | AR session, floor and wall finding, anchors, lighting, gestures, 3D room. |
| `furniture.js` | The chair, sofa and table models, their finishes and textures. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Install and offline support. |
| `vendor/` | three.js 0.170.0 and two of its add-ons. |

To try it locally, serve `web/` (for example `python3 -m http.server` in
`web/`) and open `http://localhost:8000/furniture/`. Add `?preview` to the
address to go straight to the 3D room. The camera needs https, so to test AR on
a phone use the GitHub Pages address, or Chrome's port forwarding to localhost.
