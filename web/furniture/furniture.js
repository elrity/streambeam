// RoomFit furniture: real-size 3D models built from code, with PBR wood and fabric.
// Units are meters. Each model stands on y = 0, is centered on its footprint and faces +Z.
import * as THREE from 'three';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';

// ---------- Procedural textures (made once, shared by every piece) ----------

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Value noise that tiles every px by py lattice cells.
function noise(x, y, px, py) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const m = (v, p) => ((v % p) + p) % p;
  const a = hash(m(xi, px), m(yi, py)), b = hash(m(xi + 1, px), m(yi, py));
  const c = hash(m(xi, px), m(yi + 1, py)), d = hash(m(xi + 1, px), m(yi + 1, py));
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x, y, px, py, oct = 4) {
  let s = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += amp * noise(x * f, y * f, px * f, py * f); amp *= 0.5; f *= 2; }
  return s;
}

function canvasTexture(w, h, paint, srgb) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  paint(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Wood grain runs along u. One texture covers 2 m x 0.5 m of wood.
function makeWood() {
  const W = 1024, H = 256;
  const lum = new Float32Array(W * H), ring = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const warp = fbm(x / 128, y / 32, 8, 8) * 7;
      const v = y / 9 + warp;
      let r = 0.5 + 0.5 * Math.sin(v * Math.PI);
      r = Math.pow(r, 4);
      const pores = fbm(x / 6, y / 1.5, W / 6, H / 1.5, 2);
      const blotch = fbm(x / 256, y / 64, 4, 4, 3);
      const i = y * W + x;
      ring[i] = r;
      lum[i] = 0.9 - 0.2 * r - 0.08 * pores + 0.12 * (blotch - 0.5);
    }
  }
  const paint = (fn) => (g) => {
    const img = g.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = Math.max(0, Math.min(255, fn(i) * 255));
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  };
  const map = canvasTexture(W, H, paint(i => lum[i]), true);
  const rough = canvasTexture(W, H, paint(i => 0.5 + 0.3 * ring[i]), false);
  return { map, rough };
}

// Woven upholstery: a normal map of a fine basket weave with slub noise.
function makeWeave() {
  const N = 256, cell = 8;
  const hgt = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      const fx = (x % cell) / cell, fy = (y % cell) / cell;
      const warp = (cx + cy) % 2 === 0;
      const h = warp ? Math.sin(Math.PI * fx) * (0.6 + 0.4 * Math.sin(Math.PI * fy))
                     : Math.sin(Math.PI * fy) * (0.6 + 0.4 * Math.sin(Math.PI * fx));
      hgt[y * N + x] = h + 0.35 * fbm(x / 4, y / 4, N / 4, N / 4, 2);
    }
  }
  const at = (x, y) => hgt[((y + N) % N) * N + ((x + N) % N)];
  const normal = canvasTexture(N, N, (g) => {
    const img = g.createImageData(N, N);
    const k = 2.2;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let nx = -(at(x + 1, y) - at(x - 1, y)) * k, ny = (at(x, y + 1) - at(x, y - 1)) * k, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const i = (y * N + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255; img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, false);
  const tone = canvasTexture(N, N, (g) => {
    const img = g.createImageData(N, N);
    for (let i = 0; i < N * N; i++) {
      const v = (0.86 + 0.14 * hgt[i] / 1.35) * 255;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, true);
  return { normal, tone };
}

// Soft contact shadow: a blurred rounded rectangle.
function makeBlob() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.shadowColor = 'rgba(0,0,0,1)';
    g.shadowBlur = 34;
    g.shadowOffsetX = 1000;
    g.fillStyle = '#000';
    g.beginPath();
    g.roundRect(48 - 1000, 48, w - 96, h - 96, 30);
    g.fill();
  }, false);
}

// Selection outline on the floor.
function makeOutline() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.strokeStyle = '#fff';
    g.lineWidth = 7;
    g.setLineDash([22, 14]);
    g.beginPath();
    g.roundRect(10, 10, w - 20, h - 20, 34);
    g.stroke();
  }, false);
}

let TEX = null;
export function textures() {
  if (!TEX) TEX = { wood: makeWood(), weave: makeWeave(), blob: makeBlob(), outline: makeOutline() };
  return TEX;
}

// ---------- Materials ----------

const WOODS = {
  oak:    { color: 0xd2ab7c, rough: 1.0, clear: 0.15 },
  walnut: { color: 0x7a5236, rough: 0.9, clear: 0.25 },
  black:  { color: 0x2b2826, rough: 0.8, clear: 0.2 },
  white:  { color: 0xf1ede6, rough: 0.7, clear: 0.35 },
};
const FABRICS = {
  grey:  { color: 0x9c9c98, sheen: 0xd9d9d6 },
  beige: { color: 0xcdbca2, sheen: 0xf2e6d2 },
  blue:  { color: 0x3c4b60, sheen: 0x8ea3c4 },
  green: { color: 0x506d55, sheen: 0x9fc7a6, velvet: true },
  rust:  { color: 0xa65a3a, sheen: 0xf0a882 },
  cream: { color: 0xe7e0d3, sheen: 0xffffff },
};

function woodMat(name) {
  const w = WOODS[name], t = textures().wood;
  return new THREE.MeshPhysicalMaterial({
    color: w.color, map: t.map, roughnessMap: t.rough, roughness: w.rough,
    bumpMap: t.rough, bumpScale: 0.6, clearcoat: w.clear, clearcoatRoughness: 0.45,
  });
}

function fabricMat(name) {
  const f = FABRICS[name], t = textures().weave;
  return new THREE.MeshPhysicalMaterial({
    color: f.color, map: t.tone, normalMap: t.normal, normalScale: new THREE.Vector2(0.55, 0.55),
    roughness: f.velvet ? 0.75 : 0.92, sheen: 1, sheenColor: new THREE.Color(f.sheen),
    sheenRoughness: f.velvet ? 0.35 : 0.7,
  });
}

// ---------- Geometry helpers ----------

// Real-world UVs: textures keep the same scale on every piece. `grain` is the axis the wood grain follows.
function worldUV(geo, { su = 1, sv = 1, grain = 'x' } = {}) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  const ax = ['x', 'y', 'z'];
  for (let i = 0; i < p.count; i++) {
    const v = { x: p.getX(i), y: p.getY(i), z: p.getZ(i) };
    const a = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
    const dom = ax[a.indexOf(Math.max(...a))];
    const rest = ax.filter(k => k !== dom);
    let u, w;
    if (rest.includes(grain)) { u = grain; w = rest.find(k => k !== grain); } else { [u, w] = rest; }
    uv.setXY(i, v[u] * su, v[w] * sv);
  }
  uv.needsUpdate = true;
  return geo;
}

// Puffs a cushion: pushes the face along `axis` outward, most in the middle.
function bulge(geo, axis, amount, hx, hy) {
  const p = geo.attributes.position;
  const [a, b] = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] }[axis];
  for (let i = 0; i < p.count; i++) {
    const v = { x: p.getX(i), y: p.getY(i), z: p.getZ(i) };
    const fa = Math.max(0, 1 - (v[a] / hx) ** 2), fb = Math.max(0, 1 - (v[b] / hy) ** 2);
    v[axis] += Math.sign(v[axis]) * amount * fa * fb;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// Bends a panel around a vertical axis so its edges come forward (+Z).
function bend(geo, radius) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), th = x / radius;
    p.setXYZ(i, (radius - z) * Math.sin(th), p.getY(i), radius - (radius - z) * Math.cos(th));
  }
  geo.computeVertexNormals();
  return geo;
}

// Narrows the bottom of a leg.
function taper(geo, bottomScale) {
  const p = geo.attributes.position;
  geo.computeBoundingBox();
  const { min, max } = geo.boundingBox;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - min.y) / (max.y - min.y);
    const s = bottomScale + (1 - bottomScale) * t;
    p.setXYZ(i, p.getX(i) * s, p.getY(i), p.getZ(i) * s);
  }
  geo.computeVertexNormals();
  return geo;
}

function rbox(w, h, d, r, seg = 4) { return new RoundedBoxGeometry(w, h, d, seg, r); }

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

const WOOD_UV = { su: 0.5, sv: 2 };  // texture spans 2 m along the grain
const FABRIC_UV = { su: 9, sv: 9 };  // one weave tile every 11 cm

// ---------- Models ----------

function chair(v) {
  const g = new THREE.Group();
  const wood = woodMat(v.wood), fab = fabricMat(v.fabric);
  const lean = 0.14;
  // Front legs
  for (const sx of [-1, 1]) {
    const leg = worldUV(taper(new THREE.CylinderGeometry(0.018, 0.018, 0.43, 20), 0.72), { ...WOOD_UV, grain: 'y' });
    g.add(mesh(leg, wood, sx * 0.195, 0.215, 0.195));
  }
  // Back legs that become the back posts
  for (const sx of [-1, 1]) {
    const low = worldUV(taper(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 20), 0.75), { ...WOOD_UV, grain: 'y' });
    g.add(mesh(low, wood, sx * 0.19, 0.22, -0.195));
    const L = 0.40;
    const up = worldUV(new THREE.CylinderGeometry(0.014, 0.018, L, 20), { ...WOOD_UV, grain: 'y' });
    const m = mesh(up, wood, sx * 0.19, 0.43 + (L / 2) * Math.cos(lean), -0.195 - (L / 2) * Math.sin(lean));
    m.rotation.x = -lean;
    g.add(m);
  }
  // Seat frame and cushion
  g.add(mesh(worldUV(rbox(0.43, 0.055, 0.43, 0.008, 2), WOOD_UV), wood, 0, 0.405, 0));
  const cushion = rbox(0.455, 0.055, 0.445, 0.024, 5);
  bulge(cushion, 'y', 0.009, 0.22, 0.21);
  g.add(mesh(worldUV(cushion, FABRIC_UV), fab, 0, 0.46, 0.012));
  // Curved backrest and mid rail
  const yBack = 0.72, zPost = -0.195 - (yBack - 0.43) * Math.tan(lean);
  const back = worldUV(bend(new THREE.BoxGeometry(0.40, 0.13, 0.018, 24, 2, 1), 0.6), WOOD_UV);
  const bm = mesh(back, wood, 0, yBack, zPost + 0.006); bm.rotation.x = -lean; g.add(bm);
  const yRail = 0.56, zRail = -0.195 - (yRail - 0.43) * Math.tan(lean);
  const rail = worldUV(bend(new THREE.BoxGeometry(0.38, 0.028, 0.016, 24, 1, 1), 0.6), WOOD_UV);
  const rm = mesh(rail, wood, 0, yRail, zRail + 0.006); rm.rotation.x = -lean; g.add(rm);
  // Stretchers
  for (const sx of [-1, 1]) {
    const s = mesh(worldUV(new THREE.CylinderGeometry(0.008, 0.008, 0.39, 10), { ...WOOD_UV, grain: 'y' }), wood, sx * 0.19, 0.16, 0);
    s.rotation.x = Math.PI / 2; g.add(s);
  }
  const fs = mesh(worldUV(new THREE.CylinderGeometry(0.008, 0.008, 0.38, 10), { ...WOOD_UV, grain: 'y' }), wood, 0, 0.13, 0.195);
  fs.rotation.z = Math.PI / 2; g.add(fs);
  return g;
}

function sofa(v) {
  const g = new THREE.Group();
  const fab = fabricMat(v.fabric), wood = woodMat(v.wood), accent = fabricMat(v.accent);
  const legH = 0.12;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = worldUV(taper(new THREE.CylinderGeometry(0.024, 0.024, legH, 18), 0.7), { ...WOOD_UV, grain: 'y' });
    g.add(mesh(leg, wood, sx * 0.93, legH / 2, sz * 0.36));
  }
  // Plinth, arms and back frame
  g.add(mesh(worldUV(rbox(2.0, 0.2, 0.86, 0.04), FABRIC_UV), fab, 0, legH + 0.1, 0));
  for (const sx of [-1, 1]) {
    const arm = rbox(0.2, 0.5, 0.9, 0.075, 5);
    bulge(arm, 'x', 0.008, 0.2, 0.4);
    g.add(mesh(worldUV(arm, FABRIC_UV), fab, sx * 0.92, legH + 0.25, 0));
  }
  g.add(mesh(worldUV(rbox(1.66, 0.42, 0.18, 0.06), FABRIC_UV), fab, 0, legH + 0.2 + 0.21, -0.35));
  // Seat cushions
  for (const x of [-0.55, 0, 0.55]) {
    const c = rbox(0.545, 0.15, 0.66, 0.055, 6);
    bulge(c, 'y', 0.018, 0.26, 0.31);
    g.add(mesh(worldUV(c, FABRIC_UV), fab, x, legH + 0.2 + 0.075, 0.1));
  }
  // Back cushions, leaning back
  for (const x of [-0.55, 0, 0.55]) {
    const c = rbox(0.54, 0.44, 0.19, 0.075, 6);
    bulge(c, 'z', 0.03, 0.26, 0.2);
    const m = mesh(worldUV(c, FABRIC_UV), fab, x, legH + 0.37 + 0.22, -0.2);
    m.rotation.x = -0.17;
    g.add(m);
  }
  // Two throw pillows in a contrasting fabric
  for (const sx of [-1, 1]) {
    const p = rbox(0.42, 0.42, 0.12, 0.06, 6);
    const pos = p.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const fx = Math.abs(pos.getX(i)) / 0.21, fy = Math.abs(pos.getY(i)) / 0.21;
      pos.setZ(i, pos.getZ(i) * (1 - 0.65 * Math.max(fx, fy) ** 3) + Math.sign(pos.getZ(i)) * 0.03 * (1 - fx * fx) * (1 - fy * fy));
    }
    p.computeVertexNormals();
    const m = mesh(worldUV(p, FABRIC_UV), accent, sx * 0.62, 0.66, -0.06);
    m.rotation.set(-0.32, -sx * 0.22, sx * 0.08);
    g.add(m);
  }
  return g;
}

function table(v) {
  const g = new THREE.Group();
  const wood = woodMat(v.wood);
  const W = 1.4, D = 0.8, H = 0.75, T = 0.032;
  g.add(mesh(worldUV(rbox(W, T, D, 0.009, 3), WOOD_UV), wood, 0, H - T / 2, 0));
  const ay = H - T - 0.04;
  for (const sz of [-1, 1]) g.add(mesh(worldUV(new THREE.BoxGeometry(W - 0.2, 0.08, 0.022), WOOD_UV), wood, 0, ay, sz * (D / 2 - 0.08)));
  for (const sx of [-1, 1]) g.add(mesh(worldUV(new THREE.BoxGeometry(0.022, 0.08, D - 0.2), { ...WOOD_UV, grain: 'z' }), wood, sx * (W / 2 - 0.08), ay, 0));
  const legH = H - T;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = worldUV(taper(rbox(0.052, legH, 0.052, 0.006, 2), 0.68), { ...WOOD_UV, grain: 'y' });
    g.add(mesh(leg, wood, sx * (W / 2 - 0.08), legH / 2, sz * (D / 2 - 0.08)));
  }
  return g;
}

// ---------- Catalog ----------
// Real 3D models (photo-based textures; see models/CREDITS.md). Each is placed so its lowest point
// is exactly on the floor (y = 0), centered on its footprint, front toward +Z.
// If a model can't be loaded, a piece modeled in code above stands in for it.

export const CATALOG = {
  chair: {
    name: 'Velvet armchair', url: 'models/armchair.glb', hasBack: true,
    variants: [
      { name: 'Mango velvet', gltf: 'Mango Velvet', swatch: '#e2733f' },
      { name: 'Peacock velvet', gltf: 'Peacock Velvet', swatch: '#1e6e77' },
    ],
    fallback: { build: chair, dims: [0.46, 0.5, 0.82], variant: { wood: 'oak', fabric: 'grey' } },
  },
  sofa: {
    name: 'Velvet sofa', url: 'models/sofa.glb', hasBack: true,
    variants: [
      { name: 'Champagne', gltf: 'Champagne', swatch: '#d9c4a1' },
      { name: 'Navy', gltf: 'Navy', swatch: '#22396a' },
      { name: 'Gray', gltf: 'Gray', swatch: '#8b8b8b' },
      { name: 'Black', gltf: 'Black', swatch: '#232323' },
      { name: 'Pale pink', gltf: 'Pale Pink', swatch: '#e8bab5' },
    ],
    fallback: { build: sofa, dims: [2.04, 0.9, 0.84], variant: { fabric: 'grey', accent: 'rust', wood: 'oak' } },
  },
  table: {
    name: 'Round dining table', url: 'models/dining-table.glb', height: 0.76, hasBack: false,
    variants: [{ name: 'Dark wood', swatch: '#5b3426' }],
    fallback: { build: table, dims: [1.4, 0.8, 0.75], variant: { wood: 'walnut' } },
  },
  coffee: {
    name: 'Coffee table', url: 'models/coffee-table.glb', hasBack: false,
    variants: [{ name: 'Oak', swatch: '#a27b4b' }],
    fallback: { build: table, dims: [1.4, 0.8, 0.75], variant: { wood: 'oak' } },
  },
};

const MODELS = {}; // type -> { scene, variantMaterials: Map<mesh name path, Material[]> } or { procedural: true }

// Loads every model once; pieces placed later are light copies that share geometry and textures.
export async function loadModels(onProgress) {
  const { GLTFLoader } = await import('./vendor/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const types = Object.keys(CATALOG);
  let done = 0;
  await Promise.all(types.map(async (type) => {
    const def = CATALOG[type];
    try {
      const gltf = await loader.loadAsync(def.url);
      MODELS[type] = await prepare(gltf, def);
    } catch (e) {
      console.warn('Model failed, using the built-in one:', type, e);
      MODELS[type] = { procedural: true };
      def.dims = def.fallback.dims;
      def.variants = [{ name: 'Standard', swatch: '#999' }];
    }
    onProgress?.(++done / types.length);
  }));
}

async function prepare(gltf, def) {
  const root = gltf.scene;
  // Drop lights that came with the file and the product label (logos aren't covered by the license)
  const drop = [];
  root.traverse((o) => { if (o.isLight || /label/i.test(o.name)) drop.push(o); });
  drop.forEach((o) => o.parent.remove(o));

  // Material per variant, for each mesh (KHR_materials_variants)
  const names = (gltf.parser.json.extensions?.KHR_materials_variants?.variants || []).map((v) => v.name);
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  // Kept outside userData: three.js copies userData as JSON when a model is cloned
  const looks = [];
  for (const m of meshes) {
    m.castShadow = m.receiveShadow = true;
    m.userData.shared = true;
    const look = { base: m.material, byVariant: {} };
    const ext = m.userData.gltfExtensions?.KHR_materials_variants;
    delete m.userData.gltfExtensions;
    for (const map of ext?.mappings || []) {
      const mat = await gltf.parser.getDependency('material', map.material);
      for (const v of map.variants) look.byVariant[names[v]] = mat;
    }
    looks.push(look);
  }

  // Real size, standing on the floor, centered
  if (def.height) {
    const b = new THREE.Box3().setFromObject(root);
    root.scale.multiplyScalar(def.height / (b.max.y - b.min.y));
  }
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  root.position.x -= c.x;
  root.position.z -= c.z;
  root.position.y -= box.min.y;
  const size = box.getSize(new THREE.Vector3());
  def.dims = [size.x, size.z, size.y].map((v) => Math.round(v * 100) / 100);
  return { scene: root, looks };
}

function modelCopy(type, variant) {
  const def = CATALOG[type], src = MODELS[type];
  if (!src || src.procedural) {
    const f = def.fallback;
    return f.build(f.variant);
  }
  const g = new THREE.Group();
  const copy = src.scene.clone(true);
  const want = def.variants[variant]?.gltf;
  let i = 0;
  copy.traverse((o) => {
    if (!o.isMesh) return;
    const look = src.looks[i++];
    o.material = (want && look.byVariant[want]) || look.base;
  });
  g.add(copy);
  return g;
}

// Builds one piece: the model plus its own soft contact shadow, which grounds it on the floor.
export function buildFurniture(type, variant = 0) {
  const def = CATALOG[type];
  const model = modelCopy(type, variant);
  const [w, d] = def.dims;
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.35, d * 1.35),
    new THREE.MeshBasicMaterial({ map: textures().blob, transparent: true, opacity: 0.78, depthWrite: false, color: 0x000000 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.002;
  blob.renderOrder = 1;
  blob.raycast = () => {};
  blob.userData.blob = true;
  model.add(blob);
  return model;
}

// Frees what belongs to one piece only (models share geometry and textures with the loaded file).
export function disposePiece(o) {
  o.traverse((c) => {
    if (!c.isMesh || c.userData.shared) return;
    c.geometry.dispose();
    c.material.dispose();
  });
}

export function makeOutlineMesh(type) {
  const [w, d] = CATALOG[type].dims;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w + 0.24, d + 0.24),
    new THREE.MeshBasicMaterial({ map: textures().outline, transparent: true, depthWrite: false, color: 0x5fe0c8 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.004;
  m.renderOrder = 2;
  m.raycast = () => {};
  return m;
}
