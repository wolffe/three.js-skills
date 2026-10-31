// photo-sky.tsl.js — a photographic sky for THREE.WebGPURenderer (TSL), ATS/ETS2 style.
//
// Equirectangular sky photos (top half only, 4096x1024, sun pre-rotated to column 0.5; see convert-sky.mjs) on a
// camera-following back-faced dome. Per frame, update() turns the sun direction and the weather into one weight per
// texture slot (sun-elevation bands, a night slot, an aurora slot, three weather slots, a moonlit-overcast night
// slot); the shader crossfades the weighted photos in DISPLAY space with a cloud-aware blend, inverts three's ACES
// tone map so the renderer's own ACES gives the photo back, then runs a grade (horizon haze, wash, storm fold).
// The dome turns so each photo's sun column follows the clock's azimuth, and a per-slot elevation warp pulls each
// photo's sun row toward the clock's elevation.
//
// HARD REQUIREMENT: renderer.toneMapping = THREE.ACESFilmicToneMapping (the inverse below is exact for that curve only).
//
// Usage:
//   import { createPhotoSky } from './photo-sky.tsl.js';
//   const sky = createPhotoSky({ basePath: 'assets/sky/' });
//   scene.add(sky.mesh); await sky.load(dayIndex);
//   // per frame: sky.update({ dt, sunDir, overcast, rain, bright, day, camera });
//
// Written against three r187; TSL names move between releases, so if an import fails, check `three/tsl` in the
// installed version before rewriting anything.

import * as THREE from 'three/webgpu';
import {
  Fn, uniform, texture, positionWorld, cameraPosition, float, vec2, vec3, vec4, mat3, fract, atan, asin, clamp,
  dFdx, dFdy, If, select, max, min, mix, exp, sqrt, sub, luminance, smoothstep,
} from 'three/tsl';

// Example slot table: ambientCG / Poly Haven CC0 photos converted with convert-sky.mjs. sunElev = the photo's sun
// elevation in degrees from the conversion log (null = no sun); sunClear = how visible the disc is (0..1, gates a
// lens flare); exp = exposure trim. Replace the values with your own conversion log.
export const EXAMPLE_SLOTS = [
  { file: 'dawn.webp', sunElev: 5.6, sunClear: 0.5, exp: 1.0 },        // 0  low sun, 2.5-12 deg band
  { file: 'day.webp', sunElev: 52.8, sunClear: 0.85, exp: 1.0 },       // 1  high sun, above 37 deg
  { file: 'dusk.webp', sunElev: 1.0, sunClear: 0.7, exp: 1.0 },        // 2  sun on the horizon, -6..2.5 deg
  { file: 'night.webp', sunElev: null, sunClear: 0, exp: 1.0 },        // 3  stars + Milky Way
  { file: 'night-aurora.webp', sunElev: null, sunClear: 0, exp: 1.0 }, // 4  aurora night
  { file: 'overcast.webp', sunElev: null, sunClear: 0, exp: 1.0 },     // 5  textured grey deck
  { file: 'whiteout.webp', sunElev: null, sunClear: 0, exp: 1.0 },     // 6  high-key bright overcast
  { file: 'storm.webp', sunElev: null, sunClear: 0, exp: 1.0 },        // 7  dark deck (rain)
  { file: 'mid.webp', sunElev: 25.8, sunClear: 0.8, exp: 1.0 },        // 8  mid-morning / afternoon, 12-37 deg
  { file: 'night-overcast.webp', sunElev: null, sunClear: 0, exp: 0.55 }, // 9 moonlit overcast night
];

export const PHOTO_SKY_DEFAULTS = {
  slots: EXAMPLE_SLOTS,
  slotCount: 0,              // texture slots; 0 = slots.length rounded up to 4. Spare slots hold 1x1 placeholders
  // [elevationDeg, slot]: the slot shows while the sun is above that elevation (and below the next). Below
  // bands[0] = the night slot. Symmetric about noon (sunrise shows the band-0 photo too).
  bands: [[-6, 2], [2.5, 0], [12, 8], [37, 1]],
  // slot index per role; omit or -1 for none (weather falls back to whichever weather slot exists)
  roles: { night: 3, aurora: 4, overcast: 5, whiteout: 6, storm: 7, nightOvercast: 9 },
  pools: {},                 // { slot: [entry, ...] } per-day variants; entry like a slots row
  basePath: '',              // prefix for entry.file
  loadImage: null,           // async (url) => HTMLImageElement | ImageBitmap; default ImageLoader + decode
  radius: 1700,              // dome scale; keep inside camera.far
  segments: [48, 24],
  anisotropy: 8,
  placeholder: '#8fa3b8',    // colour of an empty slot (never shown while its weight is 0)
  hazeColor: 0xd7dee6,       // default grade target; copy scene.fog.color into uniforms.hazeColor each frame
  grade: null,               // (linColorNode, ctx) => vec3 node; replaces the default grade (see SKILL.md)
  knobs: {},                 // overrides for PHOTO_SKY_KNOBS
};

// Live knobs (sky.knobs): read every update(); edit at runtime.
export const PHOTO_SKY_KNOBS = {
  fadeDeg: 4,          // half-width of each band crossfade, degrees of sun elevation (capped at 45% of a band)
  fadeSharp: 4,        // cloud-aware blend: 0 = plain dissolve, 8 = harder; clouds stay opaque mid-fade
  warp: 1,             // 0 = photo sun stays at its own elevation, 1 = pulled to the clock's
  warpMax: 2.2,        // the warped sun stays within [sunElev / warpMax, sunElev * warpMax]
  warpTop: 80,         // degrees; the warp never lifts a sun above this
  storm: 0.85,         // strength of the storm fold toward hazeColor
  bakeCap: 1.0,        // linear cap on the sky while baking (no HDR sun in the PMREM)
  nightHaze: 0.15,     // night wash toward hazeColor (a full wash erases the night photo)
  stormHaze: 0.1,      // overcast wash by day (the weather photo carries the deck; this is only a veil)
  hazeEase: 0.8,       // 1/s, easing of the wash
  weatherFade: 120,    // s, clear <-> weather photo crossfade time constant
  overFold: 0.1,       // residual storm fold by day under a weather photo
  nightFold: 0.3,      // ... and at night (the fog under rain is mid grey; the dark deck must meet it)
  auroraFade: 60,      // s, aurora crossfade time constant
  rainPick: 0.3,       // rain above this picks the storm photo
  brightPick: 0.3,     // bright above this picks the whiteout photo
  exposureRef: 0.86,   // renderer.toneMappingExposure the photos are matched to (update({ exposure }) overrides)
  horizonBand: 0.22,   // dir.y below which the horizon converges to hazeColor
  horizonHaze: 0.95,   // strength of that convergence at the horizon
  pin: -1,             // >= 0 shows one slot only (inspection)
  rebakeSunY: 0.06,    // re-bake when sunDir.y drifts this far from the last bake
  rebakeWeight: 0.25,  // ... or when sum |w - wBaked| exceeds this
  rebakeEvery: 1.5,    // s, minimum gap between bakes
};

// three's acesFilmicToneMapping matrices, same element order as its mat3(); inverted on the CPU.
const ACES_IN = [0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];
const invMat3 = (a) => mat3(...new THREE.Matrix3().fromArray(a).invert().elements);

// Display-linear y (clamped 0.985 so a clipped sun comes back as HDR, ~8) -> pre-tone-map linear at exposure 0.6.
// RRTAndODTFit is a ratio of quadratics; this solves the quadratic for its positive root (a < 0).
export function acesInverse(y) {
  const v = invMat3(ACES_OUT).mul(min(y, vec3(0.985)));
  const a = v.mul(0.983729).sub(1.0), b = v.mul(0.432951).sub(0.0245786), c = v.mul(0.238081).add(0.000090537);
  const fit = b.add(sqrt(b.mul(b).sub(a.mul(c).mul(4.0)).max(0.0))).div(a.mul(-2.0));
  return invMat3(ACES_IN).mul(fit).max(0.0);
}

// Per-day hash. Keep the final >>> 0: XOR is signed int32 and a negative hash indexes off a table.
export const dayHash = (d, salt = 0) => {
  let h = (Math.floor(d) + salt) * 2654435761 >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return h >>> 0;
};

const sstep = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
const placeholderCanvas = (css) => {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1);
  c.width = c.height = 1;
  const g = c.getContext('2d'); g.fillStyle = css; g.fillRect(0, 0, 1, 1);
  return c;
};

/**
 * Build the sky. Returns { mesh, textures, uniforms, slots, knobs, load, setSlotImage, update, bakeGate,
 * needsRebake, bake }. See SKILL.md for the update() inputs.
 */
export function createPhotoSky(options = {}) {
  const o = { ...PHOTO_SKY_DEFAULTS, ...options };
  const knobs = { ...PHOTO_SKY_KNOBS, ...o.knobs };
  const roles = { ...o.roles };
  const slots = o.slots.slice();                     // current entry per slot (pool picks replace rows)
  const N = Math.max(o.slotCount, Math.ceil(slots.length / 4) * 4);
  const R = Math.PI / 180, TAU = 2 * Math.PI;
  const has = (i) => i != null && i >= 0 && i < N;

  // ONE Texture object per slot for the whole session; images are swapped in place (no material rebuild).
  const textures = Array.from({ length: N }, () => {
    const t = new THREE.Texture(placeholderCanvas(o.placeholder));
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = o.anisotropy;
    t.needsUpdate = true;
    return t;
  });

  const uniforms = {
    weights: Array.from({ length: N / 4 }, () => uniform(new THREE.Vector4())), // slot weights, sum 1
    warp: textures.map(() => uniform(new THREE.Vector4(0.8, 0.8, 1, 1))),   // (eT, eI, kLo, kHi) radians
    rotU: uniform(0),                         // dome rotation: image column 0.5 lands on the sun azimuth
    exposure: uniform(0.6 / knobs.exposureRef),
    imgSunDir: uniform(new THREE.Vector3(0, 1, 0)), // where the photo's sun is drawn: azimuth + warped elevation
    storm: uniform(0), stormK: uniform(knobs.storm),
    bakeCap: uniform(knobs.bakeCap),
    fadeSharp: uniform(knobs.fadeSharp),
    gate: uniform(1),                         // 0 while baking the PMREM: no HDR sun, no wash, no storm fold
    haze: uniform(0),
    hazeColor: uniform(new THREE.Color(o.hazeColor)),
    horizonBand: uniform(knobs.horizonBand), horizonHaze: uniform(knobs.horizonHaze),
  };

  // Piecewise-linear elevation remap (horizon and zenith fixed): the photo's sun row moves to the clock's elevation.
  const warpV = (e, p) => select(e.lessThan(p.x), e.mul(p.z), p.y.add(e.sub(p.x).mul(p.w))).div(Math.PI / 2);

  const dir = positionWorld.sub(cameraPosition).normalize();
  const horizonBand = clamp(sub(1.0, dir.y.div(uniforms.horizonBand)), 0.0, 1.0).pow(2.0);
  const defaultGrade = (lin) => {
    const g = mix(lin, uniforms.hazeColor, max(uniforms.haze.mul(uniforms.gate), horizonBand.mul(uniforms.horizonHaze))).toVar();
    g.assign(mix(g, uniforms.hazeColor, uniforms.storm.mul(uniforms.stormK).mul(uniforms.gate)));
    g.assign(mix(g, uniforms.hazeColor, smoothstep(0.0, -0.05, dir.y)));  // below the horizon: haze colour
    return g;
  };

  const colorNode = Fn(() => {
    const d = dir.toVar();
    // three's equirect convention + rotation. toVar BEFORE any If: a node first used inside one If is declared in
    // that branch's WGSL scope, and every later slot samples an unassigned u (concentric rings).
    const u = fract(atan(d.z, d.x).div(TAU).add(0.5).add(uniforms.rotU)).toVar();
    // Analytic azimuth derivative d(phi) = (x dz - z dx) / (x^2 + z^2): no mip seam at the atan/fract wrap.
    const r2 = d.x.mul(d.x).add(d.z.mul(d.z)).max(1e-6).mul(TAU);
    const dux = d.x.mul(dFdx(d.z)).sub(d.z.mul(dFdx(d.x))).div(r2).toVar();
    const duy = d.x.mul(dFdy(d.z)).sub(d.z.mul(dFdy(d.x))).div(r2).toVar();
    const e = asin(clamp(d.y, 0.0, 1.0)).toVar();
    // Cloud-aware blend: weight x exp(sharp x cloudiness), cloudiness = luminance x (1 - saturation), renormalised.
    // Where either photo has a cloud that photo wins (no half-transparent clouds); clear sky still dissolves.
    const acc = vec3(0).toVar(), wsum = float(0).toVar();
    textures.forEach((tex, s) => {
      const ws = uniforms.weights[s >> 2]['xyzw'[s & 3]];
      const vS = warpV(e, uniforms.warp[s]).toVar();
      const gx = vec2(dux, dFdx(vS)).toVar(), gy = vec2(duy, dFdy(vS)).toVar(); // derivatives in uniform flow
      const c = vec3(0).toVar();
      If(ws.greaterThan(0.0), () => { c.assign(texture(tex, vec2(u, vS)).grad(gx, gy).rgb); }); // unweighted: no fetch
      const mx = max(c.r, max(c.g, c.b)).max(1e-4), mn = min(c.r, min(c.g, c.b));
      const cloud = luminance(c).mul(sub(1.0, mx.sub(mn).div(mx)));
      const wp = ws.mul(exp(cloud.mul(uniforms.fadeSharp)));
      acc.addAssign(c.mul(wp)); wsum.addAssign(wp);
    });
    const disp = acc.div(wsum.max(1e-5)).toVar();
    const lin = acesInverse(disp).mul(uniforms.exposure).toVar();
    lin.assign(mix(min(lin, vec3(uniforms.bakeCap)), lin, uniforms.gate));
    const ctx = { dir: d, gate: uniforms.gate, haze: uniforms.haze, hazeColor: uniforms.hazeColor, horizonBand,
      storm: uniforms.storm.mul(uniforms.stormK), imgSunDir: uniforms.imgSunDir, defaultGrade };
    return vec4(o.grade ? o.grade(lin, ctx) : defaultGrade(lin), 1.0);
  })();

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  material.colorNode = colorNode;
  material.fog = false;          // the dome is past the fog far plane; the grade does its own haze
  material.depthWrite = false;   // sky at infinity: drawn first, no depth (a depth-tested dome slices far terrain)
  material.depthTest = false;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, o.segments[0], o.segments[1]), material);
  mesh.scale.setScalar(o.radius);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'photo-sky';

  // ---- images --------------------------------------------------------------------------------------------------
  const loadImage = o.loadImage ?? (async (url) => {
    const img = await new THREE.ImageLoader().loadAsync(url);
    if (img.decode) await img.decode();
    return img;
  });
  const urlOf = (entry) => o.basePath + entry.file;
  const pickFor = (i, day) => { const p = o.pools[i]; return p ? p[dayHash(day, 31 + i) % p.length] : slots[i]; };
  const pending = {};           // slot -> { want, img } decoded, waiting for the slot's zero-weight window
  let day = 0;

  function setSlotImage(i, img, entry) {
    textures[i].image = img; textures[i].needsUpdate = true;
    if (entry) slots[i] = entry;
  }
  // Load every slot (the day's pool picks). Await before the first PMREM bake: the bake renders the dome.
  function load(dayIndex = 0) {
    day = dayIndex;
    for (const k of Object.keys(o.pools)) slots[+k] = pickFor(+k, day);
    return Promise.allSettled(slots.map(async (m, i) => { if (m?.file) setSlotImage(i, await loadImage(urlOf(m))); }))
      .then((r) => r.forEach((x, i) => { if (x.status === 'rejected') console.warn('photo-sky: image failed', slots[i]?.file, x.reason); }));
  }

  // ---- per-frame state (module-level arrays, refilled every frame: never allocate per frame) ---------------------
  const w = new Float32Array(N), tW = new Float32Array(N), wBaked = new Float32Array(N);
  const ab = new Float32Array(o.bands.length);
  const weatherSlots = [roles.overcast, roles.whiteout, roles.storm];
  const firstWeather = weatherSlots.find(has);
  const sel = new Float32Array([1, 0, 0]);   // eased one-hot over overcast / whiteout / storm
  let overK = 0, auroraMix = 0, skyClear = 0, bakeSunY = 10, bakeTimer = 0, sunY = 0;
  const result = { skyClear: 0, weights: w };

  function update({ dt = 0, sunDir, overcast = 0, rain = 0, bright = 0, aurora = 0, dayFrac, azimuth, nightShare,
    day: dayIn, exposure, camera } = {}) {
    if (camera) mesh.position.copy(camera.position);
    if (dayIn !== undefined) day = dayIn;
    sunY = THREE.MathUtils.clamp(sunDir.y, -1, 1);
    const eC = Math.asin(sunY) / R;

    // band weights by sun elevation: ab[k] = 1 while the sun is above band k (ramps of 2 x hk degrees)
    const B = o.bands;
    for (let k = 0; k < B.length; k++) {
      const E = B[k][0];
      const below = k === 0 ? E + 90 : E - B[k - 1][0], above = k + 1 < B.length ? B[k + 1][0] - E : 90 - E;
      const hk = Math.max(1e-3, Math.min(knobs.fadeDeg, 0.45 * Math.min(below, above)));
      ab[k] = THREE.MathUtils.clamp((eC - E) / (2 * hk) + 0.5, 0, 1);
    }
    const night = nightShare ?? 1 - ab[0];
    const dayScale = ab[0] > 1e-6 ? (1 - night) / ab[0] : 0;
    tW.fill(0);
    if (has(roles.night)) tW[roles.night] = night;
    for (let k = 0; k < B.length; k++) tW[B[k][1]] += (ab[k] - (k + 1 < B.length ? ab[k + 1] : 0)) * dayScale;
    if (ab[0] <= 1e-6 && night < 1) tW[B[0][1]] += 1 - night;
    const dayShare = 1 - night;

    // weather: overK eases toward overcast; the photo pick (rain -> storm, bright -> whiteout, else overcast) eases too
    const fadeW = 1 - Math.exp(-dt / knobs.weatherFade);
    overK += (overcast - overK) * (has(firstWeather) ? fadeW : 0);
    const want = rain > knobs.rainPick ? 2 : bright > knobs.brightPick ? 1 : 0;
    const fadeS = 1 - Math.exp(-dt / (knobs.weatherFade * 0.5));
    let selSum = 0;
    for (let k = 0; k < 3; k++) { sel[k] += ((k === want ? 1 : 0) - sel[k]) * fadeS; selSum += sel[k]; }
    auroraMix += ((has(roles.aurora) ? aurora : 0) - auroraMix) * (1 - Math.exp(-dt / knobs.auroraFade));

    w.fill(0);
    for (let i = 0; i < N; i++) if (i !== roles.night) w[i] = tW[i] * (1 - overK);
    const nightClear = night * (1 - overK);
    if (has(roles.night)) w[roles.night] += nightClear * (1 - auroraMix);
    if (has(roles.aurora)) w[roles.aurora] += nightClear * auroraMix;
    for (let k = 0; k < 3; k++) {
      const s = has(weatherSlots[k]) ? weatherSlots[k] : firstWeather;
      if (has(s)) w[s] += dayShare * overK * sel[k] / selSum;
    }
    const nightWx = has(roles.nightOvercast) ? roles.nightOvercast : roles.night;
    if (has(nightWx)) w[nightWx] += night * overK;   // the overcast photos are day-lit: night weather goes here
    if (knobs.pin >= 0) { w.fill(0); w[knobs.pin] = 1; }
    uniforms.weights.forEach((u, j) => u.value.fromArray(w, j * 4));

    // per-day variants: swap a pooled slot's image only while it is off screen (its weight is 0)
    for (const key of Object.keys(o.pools)) {
      const i = +key; if (w[i] !== 0 || tW[i] !== 0) continue;
      const p = pending[i];
      if (p) { if (p.img) { setSlotImage(i, p.img, p.want); delete pending[i]; } continue; }
      const next = pickFor(i, day);
      if (next !== slots[i]) {
        const job = { want: next, img: null }; pending[i] = job;
        loadImage(urlOf(next)).then((img) => { job.img = img; }, (err) => { console.warn('photo-sky: image failed', next.file, err); delete pending[i]; });
      }
    }

    // per-slot elevation warp; exposure trim; sun-visibility for a flare
    let expMix = 0, eTmix = 0; skyClear = 0;
    for (let i = 0; i < N; i++) {
      const m = slots[i];
      const sunless = !m || m.sunElev == null;
      const eI = sunless ? 45 : Math.max(0.1, m.sunElev);
      const eT = sunless ? eI : THREE.MathUtils.lerp(eI, THREE.MathUtils.clamp(eC, eI / knobs.warpMax, Math.min(knobs.warpTop, eI * knobs.warpMax)), knobs.warp);
      uniforms.warp[i].value.set(eT * R, eI * R, eI / eT, (90 - eI) / (90 - eT));
      expMix += w[i] * (m?.exp ?? 1);
      eTmix += w[i] * eT;
      if (!sunless) skyClear += w[i] * (m.sunClear ?? 0) * (1 - sstep(Math.abs(eT - eC), 3, 8));
    }
    uniforms.exposure.value = expMix * 0.6 / (exposure ?? knobs.exposureRef);

    // dome rotation: photo column 0.5 (the sun) on the sun azimuth; atan2(z, x) matches three's equirect u
    const az = azimuth ?? (dayFrac !== undefined ? dayFrac * TAU : Math.atan2(sunDir.z, sunDir.x));
    uniforms.rotU.value = THREE.MathUtils.euclideanModulo(-az / TAU, 1);
    const eT = eTmix * R;
    uniforms.imgSunDir.value.set(Math.cos(az) * Math.cos(eT), Math.sin(eT), Math.sin(az) * Math.cos(eT));

    // grade drive: storm fold (residual under a weather photo, more at night), night / overcast wash
    uniforms.storm.value = overcast * (1 - overK * (1 - THREE.MathUtils.lerp(knobs.overFold, knobs.nightFold, night)));
    const dayLight = Math.max(0, sunY) ** 0.6;
    const hazeTarget = Math.max(sstep(-sunY, 0.02, 0.14) * knobs.nightHaze, overcast * 0.62 * dayLight * knobs.stormHaze);
    uniforms.haze.value += (hazeTarget - uniforms.haze.value) * (1 - Math.exp(-dt * knobs.hazeEase));
    uniforms.stormK.value = knobs.storm; uniforms.bakeCap.value = knobs.bakeCap; uniforms.fadeSharp.value = knobs.fadeSharp;
    uniforms.horizonBand.value = knobs.horizonBand; uniforms.horizonHaze.value = knobs.horizonHaze;

    bakeTimer -= dt;
    result.skyClear = skyClear;
    return result;
  }

  // on = true while rendering the dome into a PMREM: caps the HDR sun, drops the wash and the storm fold.
  function bakeGate(on) { uniforms.gate.value = on ? 0 : 1; }

  // Sun drift or a crossfade since the last bake, throttled by rebakeEvery. Skip it yourself at night if the
  // environment intensity is 0.
  function needsRebake() {
    if (bakeTimer > 0) return false;
    let d = 0; for (let i = 0; i < N; i++) d += Math.abs(w[i] - wBaked[i]);
    return Math.abs(sunY - bakeSunY) > knobs.rebakeSunY || d > knobs.rebakeWeight;
  }

  // Render the dome alone into a PMREM. Pass the same renderTarget every time after the first bake (a new
  // scene.environment texture rebuilds every lit material). Returns the render target.
  const envScene = new THREE.Scene();
  function bake(pmrem, { renderTarget = null, sigma = 0.04, near = 0.1, far = o.radius * 1.2, size } = {}) {
    const parent = mesh.parent;
    let rt = renderTarget;
    try {
      envScene.add(mesh);
      bakeGate(true);
      rt = pmrem.fromScene(envScene, sigma, near, far, { renderTarget, position: mesh.position, ...(size ? { size } : {}) });
      bakeSunY = sunY; wBaked.set(w); bakeTimer = knobs.rebakeEvery;
    } catch (err) {
      console.warn('photo-sky: environment bake failed', err);
    } finally {
      bakeGate(false);
      if (parent) parent.add(mesh); else envScene.remove(mesh);
    }
    return rt;
  }

  return { mesh, material, textures, uniforms, slots, knobs, load, setSlotImage, update, bakeGate, needsRebake, bake,
    state: () => ({ overK, auroraMix, skyClear, sel: Array.from(sel) }) };
}
