// card-grass.tsl.js — ATS/ETS2-style card grass for THREE.WebGPURenderer (TSL).
//
// One fixed-yaw textured quad per clump (never camera-facing), cut from an N x N cutout atlas, one InstancedMesh
// per terrain tile. CPU side: placeGrass() (jittered grid + density field + optional clump gate) -> placements
// Float64Array [x, y, z, scale, ...] in WORLD space; writeGrassTile() turns them into tile-local matrices and the
// per-instance aCard attribute (atlas cell, card height m). GPU side: createCardGrassMaterial() (flat up normal,
// alpha test, no cast shadow, shadow received once at the root, wind on the top, distance sink, ground tint,
// winter override).
//
// Usage:
//   const geo = createCardGeometry();
//   const mat = createCardGrassMaterial({ atlas });
//   const mesh = writeGrassTile(createGrassTile(geo, mat), placeGrass({ originX, originZ, size: 256, heightAt }),
//     { x: originX, z: originZ }, (x, y, z, s, h) => (h * 16) | 0);
//   // every frame, with the camera you render the eye view with (NOT a shadow camera):
//   updateGrassView(mat, camera);
//
// Written against three r186. Requirements: the tile mesh is translated only (no rotation or scale); the atlas
// is an sRGB texture with alpha, ClampToEdge, mipmapped.

import * as THREE from 'three/webgpu';
import {
  Fn, uniform, attribute, varying, texture, uv, positionLocal, positionWorld, positionGeometry, modelWorldMatrix,
  instanceIndex, time, transformNormalToView, luminance, color, float, vec2, vec3, vec4, floor, fract, sin, dot,
  mix, sub, smoothstep, max,
} from 'three/tsl';

export const CARD_GRASS_DEFAULTS = {
  atlas: null,               // THREE.Texture, required: grid x grid cells, row 0 at the TOP of the image
  grid: 4,                   // atlas cells per row
  inset: 0.005,              // fraction of a cell kept clear at each edge: bilinear/mip taps stay inside the cell
  fade: [214, 306],          // m from the view camera: cards start sinking at x, fully under at y (or a Vector2 uniform)
  sink: 2.4,                 // m a faded card drops underground
  viewXZ: null,              // Vector2 uniform with the VIEW camera xz; created if null (updateGrassView writes it)
  gain: 1.0,                 // brightness multiplier; ~1 when the atlas is normalised (make-atlas.md)
  rootShade: 0.72,           // colour at the card's bottom edge, rising to 1 at 45 % of its height
  clumpJitter: 0.26,         // per-instance brightness spread
  patch: { scale: 0.11, amount: 0.24 },   // ~9 m brightness patches
  macro: { scale: 0.011, amount: 0.16 },  // ~90 m tone drift, applied after the tint
  tintAt: null,              // (positionWorld) => vec3 ground colour; the card keeps its luminance, takes its chroma
  tintAmount: 0.65,          // share of the card's chroma replaced by the ground's
  winter: 0,                 // 0..1 global snow override (uniform at userData.grass.uWinter)
  winterAt: null,            // (positionWorld) => float 0..1, combined with `winter` by max
  palette: { lo: 0xccd5db, tip: 0xf1f6f9 }, // winter colours, root -> tip, times the card luminance
  wind: { amount: 0.035, speed: 1.15, ripple: 0.28, rippleSpeed: 2.33, side: 0.35 }, // m of sway at the top
  maskAt: null,              // (positionWorld) => float 0..1 multiplied into alpha (e.g. 0 inside a vehicle cab)
  alphaTest: 0.5,
  rootLift: 0.06,            // m above the root where the shadow is sampled
};

// Sin hash value noise; fine to a few km from the origin (precision falls off with |p|).
const gHash = /*@__PURE__*/ Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123)));
const gNoise = /*@__PURE__*/ Fn(([pIn]) => {
  const p = vec2(pIn).toVar();
  const i = floor(p), f = fract(p);
  const w = f.mul(f).mul(sub(3.0, f.mul(2.0)));
  return mix(mix(gHash(i), gHash(i.add(vec2(1, 0))), w.x), mix(gHash(i.add(vec2(0, 1))), gHash(i.add(vec2(1, 1))), w.x), w.y);
});

const toUniformV2 = (v) => (v && v.isNode ? v : uniform(Array.isArray(v) ? new THREE.Vector2(v[0], v[1]) : v));

/**
 * The card material (MeshLambertNodeMaterial, DoubleSide). Live uniforms on material.userData.grass:
 * uFade, uView, uGain, uWinter, uSink.
 */
export function createCardGrassMaterial(options = {}) {
  const o = { ...CARD_GRASS_DEFAULTS, ...options };
  o.patch = { ...CARD_GRASS_DEFAULTS.patch, ...options.patch };
  o.macro = { ...CARD_GRASS_DEFAULTS.macro, ...options.macro };
  o.palette = { ...CARD_GRASS_DEFAULTS.palette, ...options.palette };
  o.wind = { ...CARD_GRASS_DEFAULTS.wind, ...options.wind };
  if (!o.atlas) throw new Error('createCardGrassMaterial: options.atlas is required');

  const uFade = toUniformV2(o.fade);
  const uView = o.viewXZ ?? uniform(new THREE.Vector2());
  const uGain = uniform(o.gain), uWinter = uniform(o.winter), uSink = uniform(o.sink);
  const G = o.grid, E = o.inset;

  const material = new THREE.MeshLambertNodeMaterial();
  material.side = THREE.DoubleSide;
  material.alphaTest = o.alphaTest;

  // (atlas cell, card height m), constant over the card.
  const card = varying(attribute('aCard', 'vec2'), 'vGrassCard').setInterpolation('flat');
  const row = floor(card.x.div(G)), col = card.x.sub(row.mul(G));
  const u0 = uv().x.mul(1 - 2 * E).add(E), v0 = uv().y.mul(1 - 2 * E).add(E);
  const tex = texture(o.atlas, vec2(col.add(u0).div(G), float(1.0).sub(row.add(float(1.0).sub(v0)).div(G))));
  const pw = positionWorld;

  const instHash = varying(fract(sin(instanceIndex.toFloat().mul(11.37)).mul(24771.7)));
  const shade = mix(float(o.rootShade), float(1.0), smoothstep(0.0, 0.45, uv().y));
  let col3 = tex.rgb.mul(uGain).mul(shade)
    .mul(instHash.mul(o.clumpJitter).add(1 - o.clumpJitter / 2))
    .mul(gNoise(pw.xz.mul(o.patch.scale)).mul(o.patch.amount).add(1 - o.patch.amount / 2));

  if (o.tintAt) {
    const ground = vec3(o.tintAt(pw));
    const hue = ground.div(luminance(ground).max(1e-3)); // unit-luminance ground hue
    col3 = mix(col3, hue.mul(luminance(col3)), o.tintAmount);
  }
  col3 = col3.mul(gNoise(pw.xz.mul(o.macro.scale)).sub(0.5).mul(o.macro.amount).add(1.0));

  const winter = o.winterAt ? max(uWinter, o.winterAt(pw)) : uWinter;
  const snow = mix(color(o.palette.lo), color(o.palette.tip), uv().y).mul(luminance(tex.rgb).mul(2.6).add(0.15).min(1.0));
  col3 = mix(col3, snow, winter.clamp(0, 1));

  const alpha = o.maskAt ? tex.a.mul(o.maskAt(pw)) : tex.a;
  material.colorNode = vec4(col3, alpha);
  material.normalNode = transformNormalToView(vec3(0.0, 1.0, 0.0)); // lit as flat ground

  // Wind on the top only (uv.y^2); positionLocal here is already instanced (tile-local).
  const phase = instanceIndex.toFloat().mul(1.73);
  const top = uv().y.mul(uv().y);
  const w = o.wind;
  const sway = sin(time.mul(w.speed).add(phase)).add(sin(time.mul(w.rippleSpeed).add(phase.mul(1.37))).mul(w.ripple))
    .mul(w.amount).mul(top);
  // Distance from the VIEW camera, never cameraPosition: in a shadow pass that is the light camera.
  const ring = smoothstep(uFade.x, uFade.y, modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xz.sub(uView).length());
  material.positionNode = positionLocal.add(vec3(sway, ring.mul(uSink).negate(), sway.mul(w.side)));

  // One shadow sample per card, at its root: a card is lit or shaded whole (no self-shadow stripes).
  material.receivedShadowPositionNode = varying(
    pw.sub(vec3(0.0, positionGeometry.y.mul(card.y), 0.0)).add(vec3(0.0, o.rootLift, 0.0)), 'vGrassRoot',
  ).setInterpolation('flat');

  material.userData.grass = { uFade, uView, uGain, uWinter, uSink };
  return material;
}

/** Write the view camera's world xz into the material's view uniform. Call once per frame before rendering. */
const _camPos = new THREE.Vector3();
export function updateGrassView(material, camera) {
  camera.getWorldPosition(_camPos);
  material.userData.grass.uView.value.set(_camPos.x, _camPos.z);
}

/** Unit quad, base at y = 0, 1 m wide and tall; instances scale it. */
export function createCardGeometry() {
  const g = new THREE.PlaneGeometry(1, 1);
  g.translate(0, 0.5, 0);
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// CPU side

/** Integer hash -> [0, 1], exact at any integer coordinate. */
export const hash2 = (x, z, seed) => {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(seed | 0, 1597334677);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const smooth = (t) => t * t * (3 - 2 * t);
const sstep = (a, b, v) => smooth(Math.max(0, Math.min(1, (v - a) / (b - a))));
/** Value noise in [-1, 1], wavelength `scale` m. */
export const noise2 = (x, z, scale, seed) => {
  const gx = x / scale, gz = z / scale, ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = smooth(gx - ix), fz = smooth(gz - iz);
  const h00 = hash2(ix, iz, seed), h10 = hash2(ix + 1, iz, seed);
  const h01 = hash2(ix, iz + 1, seed), h11 = hash2(ix + 1, iz + 1, seed);
  const a = h00 + (h10 - h00) * fx, b = h01 + (h11 - h01) * fx;
  return (a + (b - a) * fz) * 2 - 1;
};

export const DENSITY_DEFAULTS = { base: 0.6, a: 0.55, scaleA: 38, b: 0.35, scaleB: 9, min: 0.2, max: 1 };
export const CLUMP_DEFAULTS = { where: null, scale: 8, lo: 0.5, hi: 0.65, keep: 1, extra: 3 };

/**
 * Jittered grid over the square [originX, originX + size) x [originZ, originZ + size). Cells are GLOBAL
 * (index = floor(world / spacing)), so tiles of any size tile seamlessly and give the same cards.
 *   heightAt(x, z) -> y (required)
 *   accept(x, y, z) -> bool: slope, water, roads, buildings, bare rock... (default: everything)
 *   density: (x, z) -> 0..1 keep share, or an object merged over DENSITY_DEFAULTS, or false for every cell
 *   clump: null, or an object over CLUMP_DEFAULTS; where(x, y, z) says which ground uses it (e.g. snow):
 *          there cells survive only inside noise blobs, and each survivor gets `extra` more cards
 *   scale: [min, max] placement scale, or (x, y, z, r) -> scale with r a 0..1 hash
 * Returns Float64Array [x, y, z, scale, ...].
 */
export function placeGrass({
  originX, originZ, size, spacing = 1.03, seed = 0, heightAt, accept = null, density = {}, clump = null,
  scale = [0.22, 0.6],
}) {
  const out = [];
  const d = typeof density === 'object' && density ? { ...DENSITY_DEFAULTS, ...density } : null;
  const densityAt = typeof density === 'function' ? density
    : d ? (x, z) => Math.max(d.min, Math.min(d.max,
      d.base + d.a * noise2(x, z, d.scaleA, seed + 41) + d.b * noise2(x, z, d.scaleB, seed + 42)))
      : () => 1;
  const c = clump ? { ...CLUMP_DEFAULTS, ...clump } : null;
  const scaleOf = typeof scale === 'function' ? scale : (x, y, z, r) => scale[0] + r * (scale[1] - scale[0]);
  const g0x = Math.ceil(originX / spacing), g1x = Math.ceil((originX + size) / spacing);
  const g0z = Math.ceil(originZ / spacing), g1z = Math.ceil((originZ + size) / spacing);
  for (let gz = g0z; gz < g1z; gz++) for (let gx = g0x; gx < g1x; gx++) {
    // Jitter over the WHOLE cell: a 0.1-0.9 jitter leaves the lattice visible from some angles.
    const x = (gx + hash2(gx, gz, seed + 30)) * spacing, z = (gz + hash2(gx, gz, seed + 31)) * spacing;
    if (hash2(gx * 13, gz * 17, seed + 43) > densityAt(x, z)) continue;
    const y = heightAt(x, z);
    if (accept && !accept(x, y, z)) continue;
    let extra = 0;
    if (c && (!c.where || c.where(x, y, z))) {
      const w = sstep(c.lo, c.hi, noise2(x, z, c.scale, seed + 36));
      if (hash2(gx * 3, gz * 5, seed + 37) >= w * c.keep) continue;
      extra = c.extra;
    }
    out.push(x, y, z, scaleOf(x, y, z, hash2(gx, gz, seed + 32)));
    for (let k = 1; k <= extra; k++) {
      const x2 = x + (hash2(gx + k * 977, gz * 9, seed + 38) - 0.5) * spacing;
      const z2 = z + (hash2(gx * 9, gz + k * 977, seed + 39) - 0.5) * spacing;
      const y2 = heightAt(x2, z2);
      out.push(x2, y2, z2, scaleOf(x2, y2, z2, hash2(gx + k, gz - k, seed + 40)));
    }
  }
  return Float64Array.from(out);
}

export const TILE_DEFAULTS = {
  height: { base: 0.35, perScale: 1.5, min: 0.45, max: 1.4 }, // card height m = base + perScale * scale, clamped
  width: [0.85, 1.15],     // width = height x a hashed factor in this range
  lean: 0.24,              // rad, full range of the random tilt about x (+-7 deg)
  rootDepth: 0.05,         // m the root sits under the ground (slopes)
  boundsPad: 2.5,          // m added to the hand-made bounding sphere
  seed: 7000,
};

const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4(), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0), X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * An empty tile mesh (count 1, zero matrix). The geometry is CLONED: the aCard instance attribute cannot live on
 * a geometry shared between meshes. Pool these; never dispose one that may still be in flight.
 */
export function createGrassTile(geometry, material, capacity = 32000) {
  const geo = geometry.clone();
  geo.setAttribute('aCard', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2));
  const mesh = new THREE.InstancedMesh(geo, material, capacity);
  mesh.name = 'card-grass-tile';
  mesh.castShadow = false;   // cards never cast: keeps the grass out of the shadow depth pass
  mesh.receiveShadow = true; // sampled once at the root (receivedShadowPositionNode)
  mesh.count = 1;
  mesh.setMatrixAt(0, ZERO);
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  return mesh;
}

/**
 * Fill a tile mesh from world-space placements. origin = { x, z } of the tile; the mesh moves there and instance
 * matrices are tile-local (float32 world positions jitter far from the origin).
 * pickCard(x, y, z, scale, h) -> atlas cell; h is a 0..1 hash of the position (use it for set choices).
 * options: TILE_DEFAULTS.
 */
export function writeGrassTile(mesh, placements, origin, pickCard, options = {}) {
  const o = { ...TILE_DEFAULTS, ...options, height: { ...TILE_DEFAULTS.height, ...options.height } };
  const ox = origin.x, oz = origin.z, S = o.seed;
  mesh.position.set(ox, 0, oz);
  const want = placements.length / 4, cap = mesh.instanceMatrix.count;
  if (want > cap) console.warn(`card-grass: ${want - cap} cards dropped (tile holds ${want}, cap ${cap})`);
  const count = Math.min(want, cap);
  const aCard = mesh.geometry.getAttribute('aCard');
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const wx = placements[i * 4], y = placements[i * 4 + 1], wz = placements[i * 4 + 2], s = placements[i * 4 + 3];
    const x = wx - ox, z = wz - oz;
    const h = Math.min(o.height.max, Math.max(o.height.min, o.height.base + s * o.height.perScale));
    const w = h * (o.width[0] + hash2(Math.round(wx * 2.3), Math.round(wz * 2.3), S + 2) * (o.width[1] - o.width[0]));
    _p.set(x, y - o.rootDepth, z);
    // Yaw from a HASH of the position. A linear yaw (a x + b z) is constant along diagonals, and edge-on cards
    // vanish along those lines together: a visible grid.
    _q.setFromAxisAngle(Y_AXIS, hash2(Math.round(wx * 3.7), Math.round(wz * 2.9), S + 4) * Math.PI * 2);
    _q.multiply(_q2.setFromAxisAngle(X_AXIS, (hash2(Math.round(wx * 1.7), Math.round(wz * 1.9), S + 3) - 0.5) * o.lean));
    _s.set(w, h, 1);
    mesh.setMatrixAt(i, _m.compose(_p, _q, _s));
    aCard.setXY(i, pickCard(wx, y, wz, s, hash2(Math.round(wz * 2.3), Math.round(wx * 2.3), S + 5)), h);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  mesh.count = Math.max(1, count);
  if (!count) mesh.setMatrixAt(0, ZERO);
  // Upload only the written prefix.
  const im = mesh.instanceMatrix;
  im.clearUpdateRanges(); im.addUpdateRange(0, mesh.count * 16); im.needsUpdate = true;
  aCard.clearUpdateRanges(); aCard.addUpdateRange(0, mesh.count * 2); aCard.needsUpdate = true;
  // Bounds by hand: computeBoundingSphere() would include the unused slots at the origin.
  if (count) {
    const r = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + o.boundsPad;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2), r);
  } else {
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  }
  return mesh;
}

/** Park a tile: count 1, zero matrix, a one-matrix upload. Detach it from the scene yourself. */
export function parkGrassTile(mesh) {
  mesh.count = 1;
  mesh.setMatrixAt(0, ZERO);
  const im = mesh.instanceMatrix;
  im.clearUpdateRanges(); im.addUpdateRange(0, 16); im.needsUpdate = true;
  return mesh;
}

/**
 * Tile pool: acquire() reuses a parked mesh or mints one; release() detaches and parks it. Meshes are never
 * disposed: freeing an instance buffer a queued command buffer still uses is a WebGPU error. prewarm(n) at load
 * mints the peak count so no new mesh (and its pipeline setup) appears mid-session.
 */
export function createGrassPool(geometry, material, capacity = 32000) {
  const parked = [];
  return {
    parked,
    prewarm(n) { while (parked.length < n) parked.push(createGrassTile(geometry, material, capacity)); },
    acquire(placements, origin, pickCard, options) {
      const mesh = parked.pop() ?? createGrassTile(geometry, material, capacity);
      return writeGrassTile(mesh, placements, origin, pickCard, options);
    },
    release(mesh) { mesh.removeFromParent(); parked.push(parkGrassTile(mesh)); },
  };
}
