// RoomFit: place real-size 3D furniture in the camera view (WebXR AR) or in a 3D preview room.
//
// AR features used (Android Chrome with Google Play Services for AR):
//   hit-test         finds real surfaces; several rays sample the floor and the walls every frame
//   plane-detection  (when the phone offers it) whole floor and wall planes
//   anchors          each piece is pinned to the room, so it stays put while you walk around
//   light-estimation the room's light direction, color and reflections light the furniture
//   dom-overlay      this page's buttons and catalog drawn over the camera
import * as THREE from 'three';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { CATALOG, buildFurniture, makeOutlineMesh, textures } from './furniture.js';

const $ = (id) => document.getElementById(id);
const hud = $('hud');
const TAU = Math.PI * 2;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- Renderer, scene, lights ----------

const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = roomEnv;

const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7f70, 0.6);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -3.5, right: 3.5, top: 3.5, bottom: -3.5, near: 0.5, far: 14 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
const sunTarget = new THREE.Object3D();
sun.target = sunTarget;
const sunDir = new THREE.Vector3(0.35, 1, 0.25).normalize();
const lightProbe = new THREE.LightProbe();
lightProbe.intensity = 0;
scene.add(hemi, sun, sunTarget, lightProbe);

// Receives the furniture's shadows on the real floor (invisible except for the shadow).
const catcher = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.ShadowMaterial({ opacity: 0.3 }));
catcher.rotation.x = -Math.PI / 2;
catcher.receiveShadow = true;
catcher.visible = false;
catcher.raycast = () => {};
scene.add(catcher);

// Camera used for the 3D preview, and a camera that mirrors the phone's view for touch rays.
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 60);
const pickCam = new THREE.PerspectiveCamera();
pickCam.matrixAutoUpdate = false;
const camPos = new THREE.Vector3();

// ---------- What the phone knows about the room: floor height and walls ----------

class Surfaces {
  constructor() { this.reset(); }

  reset() {
    this.buckets = new Map();     // floor-height votes from hit tests, 4 cm bins
    this.planeFloors = new Map(); // XRPlane -> { y, area }
    this.hitWalls = [];           // walls pieced together from vertical hit points
    this.planeWalls = new Map();  // XRPlane -> wall
    this.floorY = null;
    this.fixed = null;            // the 3D preview room
  }

  addHorizontal(y, camY) {
    if (y > camY - 0.25) return; // ceilings and anything at eye height
    const k = Math.round(y / 0.04);
    const b = this.buckets.get(k) || { n: 0, sum: 0 };
    b.n++; b.sum += y;
    this.buckets.set(k, b);
  }

  addVertical(p, nIn) {
    const n = new THREE.Vector3(nIn.x, 0, nIn.z);
    if (n.length() < 0.9) return;
    n.normalize();
    for (const w of this.hitWalls) {
      if (n.dot(w.n) > 0.97 && Math.abs(n.dot(p) - w.d) < 0.08) { this.grow(w, p, n); return; }
    }
    const w = { n, d: n.dot(p), sum: new THREE.Vector3(), count: 0, pts: [], tmin: 0, tmax: 0 };
    this.hitWalls.push(w);
    this.grow(w, p, n);
  }

  grow(w, p, n) {
    w.count++;
    w.sum.add(p);
    w.pts.push(p.clone());
    if (w.pts.length > 300) w.pts.splice(0, 1);
    w.n.multiplyScalar(Math.min(w.count, 60)).add(n).setY(0).normalize();
    w.d = w.n.dot(w.sum.clone().divideScalar(w.count));
    extent(w, w.pts);
  }

  addPlane(plane, pose) {
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const normal = new THREE.Vector3().setFromMatrixColumn(m, 1).normalize();
    const pts = plane.polygon.map((q) => new THREE.Vector3(q.x, 0, q.z).applyMatrix4(m));
    if (plane.orientation === 'horizontal' || normal.y > 0.9) {
      if (normal.y < 0.9) return;
      let area = 0;
      for (let i = 0; i < plane.polygon.length; i++) {
        const a = plane.polygon[i], b = plane.polygon[(i + 1) % plane.polygon.length];
        area += a.x * b.z - b.x * a.z;
      }
      this.planeFloors.set(plane, { y: origin.y, area: Math.abs(area) / 2 });
    } else if (Math.abs(normal.y) < 0.3) {
      const n = normal.setY(0).normalize();
      const w = this.planeWalls.get(plane) || { fromPlane: true };
      w.n = n; w.d = n.dot(origin); w.count = 99;
      extent(w, pts);
      this.planeWalls.set(plane, w);
    }
  }

  forgetPlanes(current) {
    for (const p of this.planeFloors.keys()) if (!current.has(p)) this.planeFloors.delete(p);
    for (const p of this.planeWalls.keys()) if (!current.has(p)) this.planeWalls.delete(p);
  }

  computeFloor(camY) {
    if (this.fixed) { this.floorY = this.fixed.floorY; return; }
    const cands = [];
    let best = null;
    for (const [k, b] of this.buckets) {
      const n = b.n + (this.buckets.get(k - 1)?.n || 0) + (this.buckets.get(k + 1)?.n || 0);
      if (n >= 12 && (best === null || k < best)) best = k;
    }
    if (best !== null) {
      let n = 0, s = 0;
      for (const k of [best - 1, best, best + 1]) { const b = this.buckets.get(k); if (b) { n += b.n; s += b.sum; } }
      cands.push(s / n);
    }
    for (const f of this.planeFloors.values()) if (f.area > 0.2 && f.y < camY - 0.25) cands.push(f.y);
    if (!cands.length) return;
    const y = Math.min(...cands);
    if (this.floorY === null || Math.abs(y - this.floorY) > 0.06) this.floorY = y;
    else this.floorY += (y - this.floorY) * 0.1;
  }

  walls() {
    if (this.fixed) return this.fixed.walls;
    const out = [...this.planeWalls.values()].filter((w) => w.tmax - w.tmin > 0.3);
    for (const w of this.hitWalls) {
      if (w.count < 8 || w.tmax - w.tmin < 0.25) continue;
      if (out.some((o) => o.fromPlane && o.n.dot(w.n) > 0.95 && Math.abs(o.d - w.d) < 0.12)) continue;
      out.push(w);
    }
    return out;
  }
}

function extent(w, pts) {
  const t = new THREE.Vector3(-w.n.z, 0, w.n.x);
  w.t = t;
  w.tmin = Infinity; w.tmax = -Infinity;
  for (const p of pts) { const v = t.dot(p); w.tmin = Math.min(w.tmin, v); w.tmax = Math.max(w.tmax, v); }
}

// The wall's normal and offset, flipped so the normal points into the room (toward the phone).
function roomSide(w) {
  return w.n.dot(camPos) - w.d >= 0 ? { n: w.n, d: w.d } : { n: w.n.clone().negate(), d: -w.d };
}

const surfaces = new Surfaces();

// ---------- Floor and wall highlights ----------

const dotsShader = (wall) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  uniforms: {
    opacity: { value: 0 }, color: { value: new THREE.Color(wall ? 0xffd166 : 0xffffff) },
    center: { value: new THREE.Vector3() }, radius: { value: 2.2 }, size: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `varying vec3 vW; varying vec2 vUv;
    void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform float opacity; uniform vec3 color; uniform vec3 center; uniform float radius; uniform vec2 size;
    varying vec3 vW; varying vec2 vUv;
    void main() {
      ${wall ? `vec2 p = vUv * size; vec2 g = fract(p / 0.12) - 0.5;
        float edge = smoothstep(0.0, 0.35, min(min(p.x, size.x - p.x), min(p.y, size.y - p.y)));
        float near = 1.0 - smoothstep(0.3, 2.0, distance(vW, center));
        float a = edge * (0.3 + 0.7 * near);`
      : `vec2 g = fract(vW.xz / 0.1) - 0.5;
        float a = 1.0 - smoothstep(radius * 0.35, radius, distance(vW.xz, center.xz));`}
      float d = smoothstep(0.14, 0.07, length(g));
      gl_FragColor = vec4(color, d * a * opacity);
    }`,
});

const floorGrid = new THREE.Mesh(new THREE.CircleGeometry(2.4, 48), dotsShader(false));
floorGrid.rotation.x = -Math.PI / 2;
floorGrid.renderOrder = 3;
floorGrid.raycast = () => {};
scene.add(floorGrid);

const wallViz = new Map(); // wall -> mesh

function syncWallViz(opacity) {
  const walls = surfaces.walls();
  for (const [w, m] of wallViz) if (!walls.includes(w)) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); wallViz.delete(w); }
  if (surfaces.floorY === null) return;
  for (const w of walls) {
    let m = wallViz.get(w);
    if (!m) {
      m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dotsShader(true));
      m.renderOrder = 3;
      m.raycast = () => {};
      m.userData.born = performance.now();
      scene.add(m);
      wallViz.set(w, m);
    }
    const { n, d } = roomSide(w);
    const width = w.tmax - w.tmin + 0.4, height = 2.5;
    const mid = (w.tmin + w.tmax) / 2;
    m.position.copy(w.n).multiplyScalar(w.d).addScaledVector(w.t, mid).addScaledVector(n, 0.01);
    m.position.y = surfaces.floorY + height / 2;
    m.scale.set(width, height, 1);
    m.lookAt(m.position.clone().add(n));
    m.material.uniforms.size.value.set(width, height);
    m.material.uniforms.center.value.copy(focusPoint);
    const fresh = 1 - clamp((performance.now() - m.userData.born) / 2500, 0, 1);
    const u = m.material.uniforms.opacity;
    u.value += (Math.max(opacity, fresh * 0.6) - u.value) * 0.15;
  }
}

// The circle in the middle of the screen shows where a tapped piece will land.
const reticle = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.11, 48), mat);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.018, 24), mat);
  for (const m of [ring, dot]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 4; reticle.add(m); }
  reticle.userData.mat = mat;
}
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// ---------- Furniture pieces ----------

const items = [];
const lastVariant = { chair: 0, sofa: 0, table: 0 };
let selected = null;
const focusPoint = new THREE.Vector3();

class Item {
  constructor(type, variant = lastVariant[type]) {
    this.type = type;
    this.def = CATALOG[type];
    this.root = new THREE.Group();
    this.yaw = 0;
    this.anchor = null;
    this.token = 0;
    this.outline = makeOutlineMesh(type);
    this.outline.visible = false;
    this.setVariant(variant);
    scene.add(this.root);
    items.push(this);
  }

  setVariant(v) {
    if (this.model) { this.model.remove(this.outline); this.root.remove(this.model); disposeTree(this.model); }
    this.variant = v;
    this.model = buildFurniture(this.type, v);
    this.model.userData.item = this;
    this.model.add(this.outline);
    this.model.rotation.y = this.yaw;
    this.root.add(this.model);
  }

  setYaw(y) { this.yaw = wrapAngle(y); this.model.rotation.y = this.yaw; }
  setPos(p) { this.root.position.copy(p); this.root.quaternion.identity(); }
}

function disposeTree(o) {
  o.traverse((c) => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
}

// Pins a piece to the real room. Needs an XRFrame, so it waits for the next one.
const anchorQueue = [];
function pin(item) {
  unpin(item);
  if (mode === 'ar') anchorQueue.push(item);
}
function unpin(item) {
  item.token++;
  if (item.anchor) { try { item.anchor.delete(); } catch {} item.anchor = null; }
}
function createAnchors(frame, ref) {
  if (!frame.createAnchor) { anchorQueue.length = 0; return; }
  while (anchorQueue.length) {
    const item = anchorQueue.shift();
    if (item.removed) continue;
    const token = item.token, p = item.root.position;
    frame.createAnchor(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }), ref).then((a) => {
      if (item.removed || item.token !== token) a.delete(); else item.anchor = a;
    }).catch(() => {});
  }
}

// Keeps a piece out of the walls; with `snap`, turns a sofa or chair to stand with its back to a wall it is pushed against.
function fitToWalls(item, p, yaw, snap) {
  const [w, d] = item.def.dims, hw = w / 2, hd = d / 2;
  let wall = null;
  for (const wl of surfaces.walls()) {
    const { n, d: off } = roomSide(wl);
    const along = wl.t.dot(p);
    if (along < wl.tmin - 0.3 || along > wl.tmax + 0.3) continue;
    const s = n.dot(p) - off; // the phone is on the room side, so anything past the wall is pushed back in
    let ext = hw * Math.abs(n.x * Math.cos(yaw) - n.z * Math.sin(yaw)) + hd * Math.abs(n.x * Math.sin(yaw) + n.z * Math.cos(yaw));
    if (snap && item.def.hasBack && s - ext < 0.15) {
      const want = Math.atan2(n.x, n.z);
      if (Math.abs(wrapAngle(yaw - want)) < 0.6) {
        yaw = want;
        ext = hw * Math.abs(n.x * Math.cos(yaw) - n.z * Math.sin(yaw)) + hd * Math.abs(n.x * Math.sin(yaw) + n.z * Math.cos(yaw));
      }
    }
    if (s < ext + 0.005) { p.addScaledVector(n, ext + 0.005 - s); wall = wl; }
    else if (s - ext < 0.05) wall = wl;
  }
  return { p, yaw, wall };
}

function place(item, p, yaw, snap = true) {
  const r = fitToWalls(item, p.clone(), yaw, snap);
  item.setPos(r.p);
  item.setYaw(r.yaw);
  return r;
}

function removeItem(item) {
  unpin(item);
  item.removed = true;
  scene.remove(item.root);
  disposeTree(item.model);
  items.splice(items.indexOf(item), 1);
  if (selected === item) select(null);
  updateHint();
}

// A free spot near p: steps sideways when another piece is already there.
function freeSpot(item, p) {
  const right = new THREE.Vector3().setFromMatrixColumn(pickCam.matrixWorld, 0).setY(0).normalize();
  const fwd = new THREE.Vector3(-right.z, 0, right.x);
  const step = item.def.dims[0] * 0.5 + 0.1;
  for (let ring = 0; ring < 5; ring++) {
    for (let k = 0; k <= ring * 2 + 1; k++) {
      const side = (k % 2 ? -1 : 1) * Math.ceil(k / 2);
      const q = p.clone().addScaledVector(right, side * step).addScaledVector(fwd, -ring * 0.6);
      const busy = items.some((o) => o !== item && !o.removed &&
        Math.abs(o.root.position.x - q.x) * 2 < (o.def.dims[0] + item.def.dims[0]) * 0.8 &&
        Math.abs(o.root.position.z - q.z) * 2 < (Math.max(...o.def.dims.slice(0, 2)) + item.def.dims[1]) * 0.8);
      if (!busy) return q;
    }
  }
  return p;
}

const faceCamera = (p) => Math.atan2(camPos.x - p.x, camPos.z - p.z);

// ---------- Touch rays ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function rayFrom(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, pickCam);
  return raycaster.ray;
}

function floorPoint(x, y) {
  if (surfaces.floorY === null) return null;
  const ray = rayFrom(x, y);
  if (ray.direction.y > -0.02) return null;
  let t = (surfaces.floorY - ray.origin.y) / ray.direction.y;
  const flat = Math.hypot(ray.direction.x, ray.direction.z) * t;
  if (flat > 8) t *= 8 / flat;
  return ray.origin.clone().addScaledVector(ray.direction, t).setY(surfaces.floorY);
}

function pickItem(x, y) {
  rayFrom(x, y);
  const hits = raycaster.intersectObjects(items.map((i) => i.model), true);
  for (const h of hits) {
    let o = h.object;
    while (o && !o.userData.item) o = o.parent;
    if (o) return o.userData.item;
  }
  return null;
}

// ---------- AR session ----------

let mode = null;        // 'ar' | 'preview' | null
let hitSources = [];
let centerHit = null;
let xrProbe = null, glBinding = null, cubeRT = null, reflectionDirty = false, estimating = false;
const tmpM = new THREE.Matrix4();

// Nine rays fanned out from the camera sample more of the room each frame; the first one drives the circle.
const RAYS = [[0, 0], [0.18, 0], [-0.18, 0], [0, 0.14], [0, -0.14], [0.32, 0.22], [-0.32, 0.22], [0.32, -0.22], [-0.32, -0.22]];

async function startAR() {
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'anchors', 'plane-detection', 'light-estimation'],
      domOverlay: { root: hud },
    });
  } catch (e) {
    toast('Could not open the AR camera');
    console.warn(e);
    return;
  }
  enterMode('ar');
  session.addEventListener('end', () => leaveMode());
  await renderer.xr.setSession(session);

  const viewer = await session.requestReferenceSpace('viewer');
  hitSources = (await Promise.all(RAYS.map(([x, y]) => {
    const l = Math.hypot(x, y, 1);
    return session.requestHitTestSource({ space: viewer, offsetRay: new XRRay({ x: 0, y: 0, z: 0 }, { x: x / l, y: y / l, z: -1 / l }) }).catch(() => null);
  }))).filter(Boolean);

  startLightEstimation(session);
}

async function startLightEstimation(session) {
  if (!session.requestLightProbe) return;
  try {
    xrProbe = await session.requestLightProbe({ reflectionFormat: session.preferredReflectionFormat });
  } catch { xrProbe = null; return; }
  if ('XRWebGLBinding' in window) {
    try {
      const gl = renderer.getContext();
      if (session.preferredReflectionFormat === 'srgba8') gl.getExtension('EXT_sRGB');
      if (session.preferredReflectionFormat === 'rgba16f') gl.getExtension('OES_texture_half_float');
      glBinding = new XRWebGLBinding(session, gl);
      cubeRT = new THREE.WebGLCubeRenderTarget(16);
      xrProbe.addEventListener('reflectionchange', () => { reflectionDirty = true; });
    } catch { glBinding = null; }
  }
}

function updateLight(frame) {
  if (!xrProbe) return;
  const est = frame.getLightEstimate(xrProbe);
  if (!est) return;
  lightProbe.sh.fromArray(est.sphericalHarmonicsCoefficients);
  lightProbe.intensity = 1;
  const I = est.primaryLightIntensity;
  const s = Math.max(1, I.x, I.y, I.z);
  sun.color.setRGB(I.x / s, I.y / s, I.z / s);
  sun.intensity = s;
  const D = est.primaryLightDirection;
  sunDir.set(D.x, Math.max(D.y, 0.35), D.z).normalize();
  // A strong single light casts crisp, dark shadows; flat light only soft ones.
  const amb = Math.max(0.05, est.sphericalHarmonicsCoefficients[0] + est.sphericalHarmonicsCoefficients[1] + est.sphericalHarmonicsCoefficients[2]);
  catcher.material.opacity = clamp(0.12 + 0.4 * (s / (s + amb * 2.5)), 0.12, 0.5);
  if (!estimating) {
    estimating = true;
    hemi.intensity = 0;
    scene.environmentIntensity = 0.35;
  }
  if (reflectionDirty && glBinding && cubeRT) {
    reflectionDirty = false;
    const cube = glBinding.getReflectionCubeMap(xrProbe);
    if (cube) {
      renderer.properties.get(cubeRT.texture).__webglTexture = cube;
      cubeRT.texture.needsPMREMUpdate = true;
      scene.environment = cubeRT.texture;
      scene.environmentIntensity = 1;
    }
  }
}

function xrFrame(frame) {
  const ref = renderer.xr.getReferenceSpace();
  const pose = frame.getViewerPose(ref);
  if (!pose) return;
  const view = pose.views[0];
  pickCam.projectionMatrix.fromArray(view.projectionMatrix);
  pickCam.projectionMatrixInverse.copy(pickCam.projectionMatrix).invert();
  pickCam.matrixWorld.fromArray(view.transform.matrix);
  pickCam.matrixWorldInverse.copy(pickCam.matrixWorld).invert();
  camPos.setFromMatrixPosition(pickCam.matrixWorld);

  // Sample surfaces
  centerHit = null;
  hitSources.forEach((src, i) => {
    const res = frame.getHitTestResults(src);
    if (!res.length) return;
    const hp = res[0].getPose(ref);
    if (!hp) return;
    tmpM.fromArray(hp.transform.matrix);
    const p = new THREE.Vector3().setFromMatrixPosition(tmpM);
    const n = new THREE.Vector3().setFromMatrixColumn(tmpM, 1).normalize();
    let kind = 'other';
    if (n.y > 0.85) { kind = 'floor'; surfaces.addHorizontal(p.y, camPos.y); }
    else if (Math.abs(n.y) < 0.3) { kind = 'wall'; surfaces.addVertical(p, n); }
    if (i === 0) centerHit = { matrix: tmpM.clone(), p, n, kind };
  });
  if (frame.detectedPlanes) {
    for (const plane of frame.detectedPlanes) {
      const pp = frame.getPose(plane.planeSpace, ref);
      if (pp) surfaces.addPlane(plane, pp);
    }
    surfaces.forgetPlanes(frame.detectedPlanes);
  }
  surfaces.computeFloor(camPos.y);

  // Pinned pieces follow their anchors as tracking improves
  for (const item of items) {
    if (!item.anchor || !frame.trackedAnchors?.has(item.anchor)) continue;
    const ap = frame.getPose(item.anchor.anchorSpace, ref);
    if (ap) { item.root.position.copy(ap.transform.position); item.root.quaternion.copy(ap.transform.orientation); }
  }
  createAnchors(frame, ref);
  updateLight(frame);
}

// ---------- 3D preview room (for phones and computers without AR) ----------

const room = new THREE.Group();
const orbit = { theta: 0.55, phi: 1.08, r: 5.6, target: new THREE.Vector3(0, 0.45, 0.2) };
{
  const t = textures().wood;
  const floorMap = t.map.clone(); floorMap.repeat.set(5, 22); floorMap.needsUpdate = true;
  const floorRough = t.rough.clone(); floorRough.repeat.set(5, 22); floorRough.needsUpdate = true;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(9, 9),
    new THREE.MeshStandardMaterial({ color: 0xd9bf9b, map: floorMap, roughnessMap: floorRough, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xece6dc, roughness: 0.95 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(9, 3), wallMat);
  back.position.set(0, 1.5, -2.4); back.receiveShadow = true;
  const left = new THREE.Mesh(new THREE.PlaneGeometry(9, 3), wallMat);
  left.rotation.y = Math.PI / 2; left.position.set(-2.9, 1.5, 0); left.receiveShadow = true;
  const skirting = new THREE.MeshStandardMaterial({ color: 0xf7f4ee, roughness: 0.6 });
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(9, 0.08, 0.015), skirting); s1.position.set(0, 0.04, -2.392);
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.08, 9), skirting); s2.position.set(-2.892, 0.04, 0);
  room.add(floor, back, left, s1, s2);
  for (const m of room.children) m.raycast = () => {};
}
room.visible = false;
scene.add(room);

const PREVIEW_WALLS = [
  { n: new THREE.Vector3(0, 0, 1), d: -2.4, t: new THREE.Vector3(-1, 0, 0), tmin: -4.5, tmax: 4.5 },
  { n: new THREE.Vector3(1, 0, 0), d: -2.9, t: new THREE.Vector3(0, 0, 1), tmin: -4.5, tmax: 4.5 },
];

function updateOrbit() {
  const { theta, phi, r, target } = orbit;
  camera.position.set(target.x + r * Math.sin(phi) * Math.sin(theta), target.y + r * Math.cos(phi), target.z + r * Math.sin(phi) * Math.cos(theta));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  pickCam.projectionMatrix.copy(camera.projectionMatrix);
  pickCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  pickCam.matrixWorld.copy(camera.matrixWorld);
  pickCam.matrixWorldInverse.copy(camera.matrixWorldInverse);
  camPos.copy(camera.position);
}

// ---------- Modes ----------

function enterMode(m) {
  mode = m;
  surfaces.reset();
  estimating = false;
  xrProbe = glBinding = null;
  hemi.intensity = 0.6;
  sun.intensity = m === 'preview' ? 2.2 : 1.6;
  sun.color.set(0xffffff);
  sunDir.set(0.35, 1, 0.25).normalize();
  lightProbe.intensity = 0;
  scene.environment = roomEnv;
  scene.environmentIntensity = m === 'preview' ? 0.8 : 0.7;
  catcher.visible = false;
  catcher.material.opacity = 0.3;
  room.visible = m === 'preview';
  scene.background = m === 'preview' ? new THREE.Color(0xd8d1c6) : null;
  if (m === 'preview') {
    surfaces.fixed = { floorY: 0, walls: PREVIEW_WALLS };
    surfaces.floorY = 0;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    updateOrbit();
  }
  $('start').style.display = 'none';
  hud.classList.add('on');
  layoutTools();
  document.body.classList.toggle('preview', m === 'preview');
  updateHint();
  renderer.setAnimationLoop(loop);
}

function leaveMode() {
  for (const it of [...items]) removeItem(it);
  for (const src of hitSources) { try { src.cancel(); } catch {} }
  hitSources = [];
  anchorQueue.length = 0;
  centerHit = null;
  mode = null;
  renderer.setAnimationLoop(null);
  hud.classList.remove('on');
  $('start').style.display = '';
  syncWallViz(0);
}

// ---------- Frame loop ----------

let lastT = 0, lastUi = 0, prevWallCount = 0;

function loop(t, frame) {
  const dt = Math.min(0.1, (t - lastT) / 1000 || 0.016);
  lastT = t;
  if (mode === 'ar' && frame) xrFrame(frame);
  if (mode === 'preview') updateOrbit();

  const busy = drag?.item?.root.visible || gesture?.type === 'move' || gesture?.type === 'twist' || dialDrag;
  const active = drag?.item || (gesture?.item) || selected;

  // Where the light and the highlights focus
  if (active) focusPoint.copy(active.root.position);
  else if (centerHit && surfaces.floorY !== null) focusPoint.copy(centerHit.p).setY(surfaces.floorY);
  else if (items.length) focusPoint.copy(items[items.length - 1].root.position);

  sunTarget.position.copy(focusPoint);
  sun.position.copy(focusPoint).addScaledVector(sunDir, 6);

  if (surfaces.floorY !== null && mode === 'ar') {
    catcher.visible = true;
    catcher.position.set(focusPoint.x, surfaces.floorY + 0.001, focusPoint.z);
  }

  // Floor dots: while dragging, and briefly when the floor is first found
  const fg = floorGrid.material.uniforms;
  const scanning = mode === 'ar' && !items.length;
  const want = surfaces.floorY === null ? 0 : busy ? 0.85 : scanning ? 0.5 : 0;
  fg.opacity.value += (want - fg.opacity.value) * Math.min(1, dt * 8);
  floorGrid.visible = fg.opacity.value > 0.01;
  if (surfaces.floorY !== null) {
    floorGrid.position.set(focusPoint.x, surfaces.floorY + 0.003, focusPoint.z);
    fg.center.value.copy(floorGrid.position);
  }
  syncWallViz(busy ? 0.6 : 0);

  // The landing circle
  const showReticle = mode === 'ar' && centerHit && !busy && surfaces.floorY !== null;
  reticle.visible = !!showReticle;
  if (showReticle) {
    if (centerHit.kind === 'floor') reticle.matrix.copy(centerHit.matrix);
    else {
      const fp = floorPoint(innerWidth / 2, innerHeight / 2);
      if (fp) reticle.matrix.makeTranslation(fp.x, fp.y, fp.z); else reticle.visible = false;
    }
    reticle.userData.mat.color.set(centerHit.kind === 'wall' ? 0xffd166 : 0xffffff);
  }

  // Selected outline pulse
  for (const it of items) {
    it.outline.visible = it === selected || it === drag?.item;
    if (it.outline.visible) it.outline.material.opacity = 0.65 + 0.35 * Math.sin(t / 220);
  }

  if (t - lastUi > 250) { lastUi = t; updateStatus(); }
  renderer.render(scene, camera);
}

// ---------- HUD ----------

let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 1800);
}

const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch {} };

let arStarted = 0;
function updateStatus() {
  const floor = surfaces.floorY !== null;
  const walls = surfaces.walls().length;
  const cf = $('chipFloor'), cw = $('chipWalls'), cl = $('chipLight');
  if (mode === 'preview') {
    cf.classList.add('ok'); cf.lastElementChild.textContent = '3D room';
    cw.classList.add('off'); cl.classList.add('off');
    $('scan').classList.add('hide');
    return;
  }
  cf.classList.toggle('ok', floor);
  cf.lastElementChild.textContent = floor ? 'Floor found' : 'Finding floor';
  cw.classList.toggle('off', !walls);
  cw.classList.add('ok');
  cw.lastElementChild.textContent = walls === 1 ? '1 wall' : `${walls} walls`;
  if (walls > prevWallCount) buzz(8);
  prevWallCount = walls;
  cl.classList.toggle('off', !estimating);
  cl.classList.add('ok');
  const scan = $('scan');
  scan.classList.toggle('hide', floor);
  if (!floor && performance.now() - arStarted > 9000) {
    scan.querySelector('b').textContent = 'Still looking…';
    scan.lastElementChild.textContent = 'Turn on more light and aim at a floor with some texture';
  }
  updateHint();
}

function updateHint() {
  const h = $('trayHint');
  if (mode === 'ar' && surfaces.floorY === null) h.textContent = 'Find the floor first, then drag a piece in';
  else if (mode === 'ar') h.textContent = 'Drag a piece into your room · tap to drop it at the circle';
  else h.textContent = 'Drag a piece onto the floor · tap to add it';
  $('btnClear').style.visibility = items.length ? 'visible' : 'hidden';
}

function select(item) {
  selected = item;
  const tools = $('tools');
  tools.classList.toggle('on', !!item);
  if (!item) return;
  const v = item.def.variants[item.variant];
  $('selName').innerHTML = `${item.def.name}<small>${v.name} · ${item.def.dims.map((x) => Math.round(x * 100)).join(' × ')} cm</small>`;
  const sw = $('swatches');
  sw.innerHTML = '';
  item.def.variants.forEach((vv, i) => {
    const b = document.createElement('button');
    b.className = 'sw' + (i === item.variant ? ' on' : '');
    b.style.background = vv.swatch;
    b.setAttribute('aria-label', vv.name);
    b.onclick = () => { item.setVariant(i); lastVariant[item.type] = i; select(item); };
    sw.appendChild(b);
  });
  showDeg();
}

function showDeg() {
  if (selected) $('deg').textContent = `${Math.round(((-selected.yaw * 180) / Math.PI + 360) % 360)}°`;
}

function turn(item, yaw) {
  const before = item.root.position.clone();
  const r = fitToWalls(item, before.clone(), yaw, false);
  item.setYaw(r.yaw);
  if (r.p.distanceTo(before) > 0.005) { item.setPos(r.p); pin(item); }
  showDeg();
}

// ---------- Catalog: drag a card into the room, or tap it ----------

let drag = null;

function layoutTools() {
  const tray = $('tray');
  if (tray.offsetHeight) $('tools').style.bottom = `${tray.offsetHeight + 8}px`;
}
addEventListener('resize', layoutTools);

function trayTop() { return $('tray').getBoundingClientRect().top + 10; }

function buildCards(thumbs) {
  const wrap = $('cards');
  for (const type of Object.keys(CATALOG)) {
    const def = CATALOG[type];
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<img alt="" src="${thumbs[type]}"><b>${def.name}</b><small>${def.dims.slice(0, 2).map((x) => Math.round(x * 100)).join(' × ')} cm</small>`;
    card.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.setPointerCapture(e.pointerId);
      card.classList.add('drag');
      drag = { type, id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), item: null, card, wall: null };
    });
    card.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      if (e.clientY < trayTop()) {
        if (surfaces.floorY === null) { toast('Point at the floor first'); return; }
        if (!drag.item) { drag.item = new Item(type); select(drag.item); }
        const fp = floorPoint(e.clientX, e.clientY);
        if (!fp) { drag.item.root.visible = false; return; }
        const r = place(drag.item, fp, faceCamera(fp));
        drag.item.root.visible = true;
        if (r.wall && r.wall !== drag.wall) buzz(12);
        drag.wall = r.wall;
        showDeg();
      } else if (drag.item) drag.item.root.visible = false;
    });
    const end = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag;
      drag = null;
      card.classList.remove('drag');
      if (d.item && d.item.root.visible) { pin(d.item); select(d.item); buzz(15); updateHint(); return; }
      if (d.item) { removeItem(d.item); return; }
      const moved = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
      if (e.type === 'pointerup' && moved < 12) tapPlace(type);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    wrap.appendChild(card);
  }
}

function tapPlace(type) {
  let p = null;
  if (mode === 'ar') {
    if (centerHit && centerHit.kind === 'floor' && surfaces.floorY !== null) p = centerHit.p.clone().setY(surfaces.floorY);
    else p = floorPoint(innerWidth / 2, innerHeight / 2);
  } else p = floorPoint(innerWidth / 2, innerHeight * 0.55) || new THREE.Vector3();
  if (!p) { toast('Point the circle at the floor'); return; }
  const item = new Item(type);
  p = freeSpot(item, p);
  place(item, p, faceCamera(p));
  pin(item);
  select(item);
  buzz(15);
  updateHint();
}

// ---------- Touch on the room: move, turn, select; orbit and zoom in the 3D room ----------

const pointers = new Map();
let gesture = null;
const angleOf = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const distOf = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

hud.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#tools, #tray, .top')) return;
  hud.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
  if (pointers.size === 1) {
    const item = pickItem(e.clientX, e.clientY);
    if (item) {
      select(item);
      const fp = floorPoint(e.clientX, e.clientY);
      gesture = { type: 'move', item, offset: fp ? item.root.position.clone().sub(fp).setY(0) : new THREE.Vector3(), moved: false, wall: null };
    } else {
      gesture = { type: mode === 'preview' ? 'orbit' : 'tap', moved: false, theta0: orbit.theta, phi0: orbit.phi };
    }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const target = gesture?.item || selected;
    if (gesture?.type === 'move' && gesture.moved) pin(gesture.item);
    if (target) gesture = { type: 'twist', item: target, a0: angleOf(a, b), yaw0: target.yaw };
    else if (mode === 'preview') gesture = { type: 'pinch', d0: distOf(a, b), r0: orbit.r, moved: true };
    else gesture = null;
  }
});

hud.addEventListener('pointermove', (e) => {
  const pt = pointers.get(e.pointerId);
  if (!pt || !gesture) return;
  pt.x = e.clientX; pt.y = e.clientY;
  const movedPx = Math.hypot(pt.x - pt.x0, pt.y - pt.y0);
  if (gesture.type === 'move') {
    if (!gesture.moved && movedPx < 6) return;
    if (!gesture.moved) { gesture.moved = true; unpin(gesture.item); }
    const fp = floorPoint(pt.x, pt.y);
    if (!fp) return;
    const r = place(gesture.item, fp.add(gesture.offset), gesture.item.yaw);
    if (r.wall && r.wall !== gesture.wall) buzz(12);
    gesture.wall = r.wall;
    showDeg();
  } else if (gesture.type === 'twist' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    turn(gesture.item, gesture.yaw0 - (angleOf(a, b) - gesture.a0));
  } else if (gesture.type === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    orbit.r = clamp(gesture.r0 * (gesture.d0 / Math.max(20, distOf(a, b))), 2, 10);
  } else if (gesture.type === 'orbit') {
    if (movedPx > 6) gesture.moved = true;
    orbit.theta = gesture.theta0 - ((pt.x - pt.x0) / innerWidth) * TAU * 0.6;
    orbit.phi = clamp(gesture.phi0 - ((pt.y - pt.y0) / innerHeight) * 2, 0.35, 1.42);
  } else if (gesture.type === 'tap' && movedPx > 10) gesture.moved = true;
});

function pointerEnd(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === 'move' && gesture.moved) { pin(gesture.item); buzz(10); }
  if ((gesture.type === 'tap' || gesture.type === 'orbit') && !gesture.moved) select(null);
  if (gesture.type === 'twist' || gesture.type === 'pinch') { gesture = null; return; }
  if (!pointers.size) gesture = null;
}
hud.addEventListener('pointerup', pointerEnd);
hud.addEventListener('pointercancel', pointerEnd);

addEventListener('wheel', (e) => {
  if (mode !== 'preview') return;
  orbit.r = clamp(orbit.r * Math.exp(e.deltaY * 0.001), 2, 10);
}, { passive: true });

// The turning strip and buttons
let dialDrag = null;
const dial = $('dial');
dial.addEventListener('pointerdown', (e) => {
  if (!selected) return;
  dial.setPointerCapture(e.pointerId);
  dialDrag = { x0: e.clientX, yaw0: selected.yaw, item: selected };
});
dial.addEventListener('pointermove', (e) => {
  if (!dialDrag) return;
  let yaw = dialDrag.yaw0 - (e.clientX - dialDrag.x0) * 0.012;
  const step = Math.PI / 12; // settles on 15° steps when close
  if (Math.abs(wrapAngle(yaw - Math.round(yaw / step) * step)) < 0.035) yaw = Math.round(yaw / step) * step;
  turn(dialDrag.item, yaw);
});
const dialEnd = () => { dialDrag = null; };
dial.addEventListener('pointerup', dialEnd);
dial.addEventListener('pointercancel', dialEnd);

$('rotL').onclick = () => selected && turn(selected, selected.yaw + Math.PI / 12);
$('rotR').onclick = () => selected && turn(selected, selected.yaw - Math.PI / 12);
$('btnDel').onclick = () => { if (selected) { removeItem(selected); toast('Removed'); buzz(20); } };
$('btnDup').onclick = () => {
  if (!selected) return;
  const src = selected;
  const item = new Item(src.type, src.variant);
  const p = freeSpot(item, src.root.position.clone().setY(surfaces.floorY ?? src.root.position.y));
  place(item, p, src.yaw, false);
  pin(item);
  select(item);
  buzz(15);
  updateHint();
};
let clearArmed = 0;
$('btnClear').onclick = () => {
  if (performance.now() - clearArmed > 2500) { clearArmed = performance.now(); toast('Tap again to remove everything'); return; }
  for (const it of [...items]) removeItem(it);
  clearArmed = 0;
  toast('Room cleared');
};
$('btnExit').onclick = () => {
  const s = renderer.xr.getSession();
  if (s) s.end(); else leaveMode();
};

// ---------- Start screen ----------

async function makeThumbs() {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 320;
  const r = new THREE.WebGLRenderer({ canvas: c, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.NeutralToneMapping;
  const pm = new THREE.PMREMGenerator(r);
  const s = new THREE.Scene();
  s.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  s.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, 3);
  s.add(key, new THREE.HemisphereLight(0xffffff, 0x8a7f70, 0.4));
  const cam = new THREE.PerspectiveCamera(28, 400 / 320, 0.1, 50);
  const out = {};
  for (const type of Object.keys(CATALOG)) {
    const m = buildFurniture(type, 0);
    s.add(m);
    const [w, d, h] = CATALOG[type].dims;
    const size = Math.max(w, h * 1.25, d);
    const dir = new THREE.Vector3(0.75, 0.55, 1).normalize();
    cam.position.copy(dir.multiplyScalar(size * 2.25)).add(new THREE.Vector3(0, h * 0.45, 0));
    cam.lookAt(0, h * 0.45, 0);
    r.render(s, cam);
    out[type] = c.toDataURL('image/png');
    s.remove(m);
    disposeTree(m);
  }
  pm.dispose();
  r.dispose();
  r.forceContextLoss();
  return out;
}

async function boot() {
  const thumbs = await makeThumbs();
  buildCards(thumbs);
  $('heroSofa').src = thumbs.sofa;
  $('heroChair').src = thumbs.chair;
  $('heroTable').src = thumbs.table;
  $('loading').remove();

  const btn = $('btnAR'), note = $('support');
  let ar = false;
  try { ar = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); } catch {}
  if (ar) {
    btn.disabled = false;
    btn.textContent = 'Open camera in my room';
    note.textContent = 'Uses your camera to find the floor and walls. Nothing leaves your phone.';
  } else {
    btn.textContent = 'Camera AR not available here';
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    note.textContent = !isSecureContext ? 'Open this page over https to use the camera.'
      : ios ? 'On iPhone, Safari can\'t run web AR yet. Open this page on an Android phone with Chrome, or try the 3D room.'
      : 'Camera AR needs an Android phone with Chrome and Google Play Services for AR. You can still try the 3D room.';
  }
  btn.onclick = () => { arStarted = performance.now(); startAR(); };
  $('btnPreview').onclick = () => enterMode('preview');
  if (new URLSearchParams(location.search).has('preview')) enterMode('preview');
}

addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// For automated checks: window.__roomfit exposes a little of the state.
window.__roomfit = { items, surfaces, tapPlace, select: (i) => select(items[i]), get mode() { return mode; } };

boot();
