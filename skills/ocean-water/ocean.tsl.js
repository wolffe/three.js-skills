// ocean.tsl.js - open sea for THREE.WebGPURenderer (TSL): camera-following sheet, normalised Gerstner
// spectrum, top-level planar reflector() pass with a layer whitelist, Schlick Fresnel, Beer-Lambert
// against a baked seabed height tile, caustics, GGX glint, Worley-shaded foam, shore wave train,
// underwater ceiling, spot-light splash, scene fog. Unlit (MeshBasicNodeMaterial): all light is manual.
//
// Frame order (see SKILL.md): ocean.update(camera, dt, sunDir) -> ocean.renderMirror(renderer, camera)
// -> renderer.render(scene, camera). Never let the reflector run nested inside the scene render.
//
// Written against three r185/r186. TSL names move between releases: if an import fails, check
// `three/tsl` in the installed version before rewriting anything.

import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, uniform, varying, texture, positionLocal, positionWorld, cameraPosition, screenUV,
  viewportSharedTexture, reflector, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float, fwidth, mix,
  max, dot, cross, normalize, pow, exp, sqrt, length, sin, cos, fract, oneMinus, frontFacing, smoothstep, abs,
} from 'three/tsl';

// Look presets. The first is the default: low amplitude on purpose (one sea state that also reads as
// still water in bays). shoreFoam = column depth (m) where shore foam fades; foamScale = world m ->
// noise space; floatFoam = open-water patches.
export const OCEAN_PRESETS = {
  'Calm coast': { crestThresh: .6, crestSkew: 8, crestFoam: 1.2, shoreFade: .1, shoreFoam: 6, foamScale: .2, floatFoam: .3, amplitude: .3, choppiness: .3, roughness: .16, rippleStrength: .24, rippleScale: .16, absorb: .3, reflectivity: .1, deep: '#191f2f', shallow: '#26465a', foam: '#a5c2d5', caustics: .25, sss: 1.1, specular: 1.4 },
  'Glassy calm': { crestThresh: .3, crestSkew: 1.2, crestFoam: .2, shoreFade: .4, shoreFoam: 1.2, foamScale: .125, floatFoam: .25, amplitude: .28, choppiness: .25, roughness: .045, rippleStrength: .16, rippleScale: .08, absorb: .075, deep: '#04283c', shallow: '#2a97a4', caustics: .7, sss: .6, specular: 1.3 },
  'Coastal breeze': { crestThresh: .18, crestSkew: 1.8, crestFoam: 1, shoreFade: .65, shoreFoam: 2, foamScale: .125, floatFoam: .8, amplitude: 1, choppiness: .62, roughness: .11, rippleStrength: .35, rippleScale: .055, absorb: .115, deep: '#052a3a', shallow: '#1f8f9a', caustics: .55, sss: .9, specular: 1.6 },
  'Tropical shallows': { crestThresh: .22, crestSkew: 1.5, crestFoam: .7, shoreFade: .55, shoreFoam: 2.8, foamScale: .125, floatFoam: .5, amplitude: .6, choppiness: .5, roughness: .08, rippleStrength: .3, rippleScale: .07, absorb: .055, deep: '#046277', shallow: '#48d6c2', caustics: 1.1, sss: 1.3, specular: 1.5 },
  'Open ocean': { crestThresh: .15, crestSkew: 2.2, crestFoam: 1, shoreFade: .8, shoreFoam: 1.8, foamScale: .1, floatFoam: 1.3, amplitude: 1.9, choppiness: .72, roughness: .14, rippleStrength: .44, rippleScale: .05, absorb: .17, deep: '#03202f', shallow: '#166f80', caustics: .28, sss: .85, specular: 1.7 },
  'Storm swell': { crestThresh: .1, crestSkew: 2.8, crestFoam: 1.4, shoreFade: 1.2, shoreFoam: 3.5, foamScale: .1, floatFoam: 1.8, amplitude: 3.4, choppiness: .86, roughness: .26, rippleStrength: .62, rippleScale: .045, absorb: .24, deep: '#0a1a1e', shallow: '#2c5a60', caustics: .1, sss: .55, specular: 1.1 },
  'Golden hour': { crestThresh: .18, crestSkew: 1.8, crestFoam: .85, shoreFade: .62, shoreFoam: 2.1, foamScale: .125, floatFoam: .7, amplitude: 1.15, choppiness: .6, roughness: .1, rippleStrength: .33, rippleScale: .058, absorb: .14, deep: '#07202c', shallow: '#276f74', caustics: .3, sss: 1.5, specular: 2.3 },
  'Moonlit': { crestThresh: .2, crestSkew: 1.6, crestFoam: .75, shoreFade: .55, shoreFoam: 1.9, foamScale: .125, floatFoam: .5, amplitude: .85, choppiness: .55, roughness: .07, rippleStrength: .28, rippleScale: .06, absorb: .19, deep: '#030c17', shallow: '#0e3a52', caustics: .14, sss: .35, specular: 2.6 },
  'Arctic': { crestThresh: .13, crestSkew: 2.5, crestFoam: 1.2, shoreFade: .95, shoreFoam: 2.8, foamScale: .11, floatFoam: 1.2, amplitude: 1.5, choppiness: .68, roughness: .16, rippleStrength: .4, rippleScale: .05, absorb: .1, deep: '#0b3b4a', shallow: '#79c6cd', caustics: .4, sss: 1.1, specular: 1.4 },
};

export const OCEAN_DEFAULTS = {
  seed: 0x5eed,
  waveCount: 16,
  totalAmplitude: 2.35,          // sum of all wave amplitudes before params.amplitude scales it (m)
  wavelengths: [140, 5.5],       // longest, shortest (m); geometric series between
  // Wave geometry. focus {x,z}: RING waves converging on that point (an island centre: every coast
  // gets onshore waves). null: plane waves around windDir (radians, travel direction).
  focus: null,
  ringSpread: 15000,             // ring mode: wave centres scatter up to this far from focus (m)
  windDir: 0,
  dirSpread: 0.6,                // plane mode: +- radians of direction spread (short waves spread most)
  sheet: { segments: 320, inner: 160, outer: 1700, frac: 0.55 }, // outer defaults to fog.far * 1.15 when fog.far is set
  seaLevel: 0,
  heightAt: null,                // (x, z) => terrain/seabed height (m); null = bottomless open sea
  stamps: null,                  // (cx, cz, half) => { domes: [{x,z,r}], boxes: [{x,z,yaw,hx,hz}] } stamped into the bed
  isActive: null,                // (camera) => bool, polled every 15th update; false hides sheet + mirror
  bed: { res: 384, extent: 1536, rebakeDistance: 380, rowsPerFrame: 12, deep: 60 },
  fog: { color: 0xbfc8d0, near: null, far: null }, // color: THREE.Color or a TSL uniform node (shared, not copied)
  mirror: { resolutionScale: 0.5, layers: null }, // layers: a Layers mask (number) for the virtual camera; null = camera's
  fade: { vertex: [140, 620], detail: [90, 560], haze: [300, 950] }, // metres from camera
  shore: { period: 5.4, depthPerLine: 1.6 }, // shore wave train: seconds between breakers, still-water m per line
  spotSlots: 2,                  // spot lights the shader can splash (fed by setSpots)
  spotGain: 0.5,                 // spot.intensity -> splash strength
  preset: 'Calm coast',
  presets: null,                 // extra { name: params } merged into OCEAN_PRESETS
  params: null,                  // overrides on top of the preset
};

const PARAM_DEFAULTS = {
  amplitude: 1.0, choppiness: 0.62, timeScale: 1.25,
  roughness: 0.11, rippleScale: 0.055, rippleStrength: 0.35,
  reflectivity: 1.0, refractDistort: 0.055, specular: 1.6,
  absorb: 0.115, deep: '#052a3a', shallow: '#1f8f9a',
  absorbTint: '#ba878c', // Beer-Lambert per-channel RATES; near-neutral (a strong red rate leaves mid depths saturated blue)
  crestFoam: 1.0, shoreFoam: 2.5, foam: '#e8f4f4',
  caustics: 0.55, sss: 0.9,
  shoreFadeOn: true, shoreFade: 0.65,
  foamScale: 0.125, floatFoam: 1.0,
  crestSkew: 1.8, crestThresh: 0.18,
};

// params key -> uniform key
const PARAM_UNIFORMS = {
  amplitude: 'amp', choppiness: 'chop', rippleStrength: 'ripple', rippleScale: 'rippleSc',
  roughness: 'rough', reflectivity: 'reflect', refractDistort: 'distort', specular: 'spec',
  absorb: 'absorb', caustics: 'caustics', sss: 'sss', crestFoam: 'crest', shoreFoam: 'shore',
  shoreFade: 'shoreFade', foamScale: 'foamScale', floatFoam: 'floatFoam',
  crestSkew: 'crestSkew', crestThresh: 'crestThresh',
};
const SHEET_CURVE = 2.2;

/** Seeded geometric spectrum, swell -> chop; total amplitude normalised to `total`. */
export function buildWaveSet(count, seed, total, { wavelengths = [140, 5.5], focus = null, ringSpread = 15000, windDir = 0, dirSpread = 0.6 } = {}) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const [Lmax, Lmin] = wavelengths;
  const out = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const L = Lmax * Math.pow(Lmin / Lmax, t);
    const amp = Math.pow(L / Lmax, 0.85) * (0.65 + 0.7 * rnd());
    const offA = rnd() * Math.PI * 2;
    const spreadT = i === 0 ? 0 : Math.min(1, (0.35 + 0.85 * t) * (0.4 + 0.6 * rnd()));
    const w = { L, amp, phase: rnd() * Math.PI * 2, k: (2 * Math.PI) / L };
    w.c = Math.sqrt(9.81 / w.k); // deep-water phase speed
    if (focus) {
      w.ring = true;
      w.cx = focus.x + Math.cos(offA) * ringSpread * spreadT;
      w.cz = focus.z + Math.sin(offA) * ringSpread * spreadT;
    } else {
      const a = windDir + Math.cos(offA) * dirSpread * spreadT;
      w.ring = false; w.dx = Math.cos(a); w.dz = Math.sin(a);
    }
    out.push(w);
    sum += amp;
  }
  for (const w of out) w.amp *= total / sum;
  return out;
}

/** Radially warped grid: uniform out to `inner` m over the inner `frac`, then power-curved to `outer`. */
export function makeWaterGeometry(segments, inner, outer, frac) {
  const g = new THREE.PlaneGeometry(2, 2, segments, segments);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const r = Math.max(Math.abs(x), Math.abs(z));
    if (r < 1e-6) continue;
    const nr = r <= frac ? (r / frac) * inner : inner + (outer - inner) * Math.pow((r - frac) / (1 - frac), SHEET_CURVE);
    p.setX(i, x * nr / r);
    p.setZ(i, z * nr / r);
  }
  g.computeBoundingSphere();
  return g;
}

const fbm01 = (p, octaves) => mx_fractal_noise_float(p, octaves, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
const worleyDist = (xz) => sqrt(mx_worley_noise_float(xz, 1.0)); // mx metric is squared distance

const _v = new THREE.Vector3();

export class Ocean {
  constructor(scene, options = {}) {
    const o = { ...OCEAN_DEFAULTS, ...options };
    for (const k of ['sheet', 'bed', 'fog', 'mirror', 'fade', 'shore']) o[k] = { ...OCEAN_DEFAULTS[k], ...(options[k] || {}) };
    if (!options.sheet?.outer && o.fog.far) o.sheet.outer = o.fog.far * 1.15;
    this.options = o;
    this.scene = scene;
    this.seaLevel = o.seaLevel;
    this.presets = { ...OCEAN_PRESETS, ...(o.presets || {}) };
    this.params = { ...PARAM_DEFAULTS, ...(this.presets[o.preset] || {}), ...(o.params || {}) };
    const P = this.params;

    this.waves = buildWaveSet(o.waveCount, o.seed, o.totalAmplitude, o);
    this.FOLD_SUM = this.waves.reduce((a, w) => a + w.amp * w.k, 0); // normalises the breaking threshold to ~0-1

    const sh = o.sheet;
    this.sheetCell = (2 / sh.segments) * (sh.inner / sh.frac); // vertices stay on this world lattice
    this.fogColor = o.fog.color?.isNode ? o.fog.color : uniform(o.fog.color?.isColor ? o.fog.color : new THREE.Color(o.fog.color));
    this.shoreOmega = (Math.PI * 2) / o.shore.period;
    this.shoreKd = (Math.PI * 2) / o.shore.depthPerLine;

    this.u = {
      time: uniform(0),
      origin: uniform(new THREE.Vector2()),     // sheet centre, world xz
      bedOrigin: uniform(new THREE.Vector2()),  // seabed tile centre, world xz
      amp: uniform(P.amplitude), chop: uniform(P.choppiness),
      ripple: uniform(P.rippleStrength), rippleSc: uniform(P.rippleScale),
      rough: uniform(P.roughness), reflect: uniform(P.reflectivity),
      distort: uniform(P.refractDistort), spec: uniform(P.specular),
      absorb: uniform(P.absorb), crest: uniform(P.crestFoam), shore: uniform(P.shoreFoam),
      sss: uniform(P.sss), caustics: uniform(P.caustics),
      deep: uniform(new THREE.Color(P.deep)), shallow: uniform(new THREE.Color(P.shallow)),
      foam: uniform(new THREE.Color(P.foam)), absorbTint: uniform(new THREE.Color(P.absorbTint)),
      sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunColor: uniform(new THREE.Color(1, 1, 1)),
      foamLight: uniform(1),     // day/night ambient on foam (update() derives it from sunDir)
      // Shore zone (all from the seabed tile, no solver). Open-sea waves shoal (Green's law, capped),
      // lag (a static phase delay = refraction) and fade to 0 at the waterline; the SHORE TRAIN's phase
      // is still-water depth, so its crests follow depth contours on any coast.
      shoalRef: uniform(10.0),   // shore zone starts at this depth (m)
      shoalMax: uniform(1.5),    // shoaling cap; 1 = off
      shoreBend: uniform(70.0),  // phase lag up to k x this many metres; 0 = off
      shoreWave: uniform(1.5),   // train height as a multiple of amplitude; 0 = off
      shoreT: uniform(0),        // train clock (omega t) mod 2 pi, fed by update(); share it with surf/wet sand
      breakerPeak: uniform(2.0), // peaked cnoidal crest leaning shoreward; 0 = plain sine
      noiseFilter: uniform(1.0), // footprint filtering of the procedural noise; 0 = raw (aliases)
      surfGrain: uniform(1.0),   // tearing of the surf wash; 0 = soft blanket, 2 = ragged
      boostPos: uniform(new THREE.Vector3(0, -1e5, 0)), // reflection lift near a point (setReflectionBoost)
      boostRefl: uniform(0),
      shoreFadeOn: uniform(P.shoreFadeOn ? 1 : 0), shoreFade: uniform(P.shoreFade),
      foamScale: uniform(P.foamScale), floatFoam: uniform(P.floatFoam),
      crestSkew: uniform(P.crestSkew), crestThresh: uniform(P.crestThresh),
      spotSum: uniform(0),
    };
    this.spotU = Array.from({ length: o.spotSlots }, () => ({
      pos: uniform(new THREE.Vector3()), dir: uniform(new THREE.Vector3(0, 0, 1)),
      cone: uniform(new THREE.Vector2(0.883, 0.968)), range: uniform(55), intensity: uniform(0),
    }));
    this.spots = [];
    // Wave constants bake into the graph (the sum unrolls); only the wrapped clocks are uniforms.
    this.waveUniforms = this.waves.map((w) => ({
      ...w, ctr: w.ring ? vec2(w.cx, w.cz) : null,
      tph: uniform(0), // (k c t) mod 2 pi on the CPU: never feed unbounded time into shader trig (f32)
    }));

    // Seabed tile (half float, metres). Starts deep; baked from heightAt around the camera.
    const B = o.bed;
    this.bedTexture = new THREE.DataTexture(new Uint16Array(B.res * B.res).fill(THREE.DataUtils.toHalfFloat(this.seaLevel - B.deep)),
      B.res, B.res, THREE.RedFormat, THREE.HalfFloatType);
    this.bedTexture.minFilter = this.bedTexture.magFilter = THREE.LinearFilter;
    this.bedTexture.wrapS = this.bedTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.bedTexture.needsUpdate = true;
    this._bedJob = null;
    this._bedAt = new THREE.Vector2(1e9, 1e9);
    this._domes = [];
    this._boxes = [];

    // Planar mirror. bounces:false; its own nested updateBefore is disabled below and renderMirror()
    // drives it as a TOP-LEVEL pass once per frame.
    this.mirror = reflector({ resolutionScale: o.mirror.resolutionScale, bounces: false });
    this.mirror.target.rotateX(-Math.PI / 2);
    this.mirror.target.position.y = this.seaLevel;
    this.mirror.target.updateMatrixWorld();
    scene.add(this.mirror.target);
    this.reflectionLayers = o.mirror.layers;
    this._mirrorManual = false;
    this._mirrorFrame = { scene, camera: null, renderer: null, material: null };
    {
      const node = this.mirror.reflector;
      const updateBefore = node.updateBefore.bind(node);
      node.updateBefore = (frame) => (this._mirrorManual ? updateBefore(frame) : undefined);
    }

    this.mesh = new THREE.Mesh(makeWaterGeometry(sh.segments, sh.inner, sh.outer, sh.frac), this._buildMaterial());
    this.mesh.name = 'ocean';
    this.mesh.position.y = this.seaLevel;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this._gateTick = 0;
    this._camXZ = new THREE.Vector2();
  }

  /** Shore wave-train phase (TSL): crests (sin = 1) on depth contours, moving shoreward as shoreT runs. */
  shorePhase(depth, xz) {
    const wob = sin(xz.x.mul(0.013)).add(sin(xz.y.mul(0.017))).mul(0.9); // alongshore wobble
    return depth.mul(this.shoreKd).add(this.u.shoreT).add(wob);
  }

  _wavePhase(w, xz) {
    if (w.ring) {
      const toC = w.ctr.sub(xz), rC = length(toC).max(1.0);
      return { f: rC.negate().mul(w.k).sub(w.tph).add(w.phase), dirX: toC.x.div(rC), dirZ: toC.y.div(rC) };
    }
    return { f: xz.x.mul(w.dx).add(xz.y.mul(w.dz)).mul(w.k).sub(w.tph).add(w.phase), dirX: float(w.dx), dirZ: float(w.dz) };
  }

  /* Gerstner sum + analytic tangent/binormal at world xz. ampScale = shoaling, lagG = shore phase
     lag (m), cleanT = 1 deep -> 0 at the waterline, cellV = local sheet cell size (m). */
  _gerstner(xz, ampScale, lagG, cleanT, cellV) {
    const u = this.u;
    let dx = float(0), dy = float(0), dz = float(0);
    let tx = float(1), ty = float(0), tz = float(0);
    let bx = float(0), by = float(0), bz = float(1);
    let fold = float(0);
    for (const w of this.waveUniforms) {
      // Nyquist fade: a wave fades where the cell passes 0.2-0.45 of its wavelength, else it aliases
      // and re-rolls every time the sheet origin steps.
      const A = u.amp.mul(w.amp).mul(ampScale).mul(cleanT).mul(oneMinus(cellV.div(w.L).smoothstep(0.2, 0.45)));
      const WA = A.mul(w.k), Q = u.chop;
      const { f: f0, dirX, dirZ } = this._wavePhase(w, xz);
      const f = f0.sub(lagG.mul(w.k));
      const sf = sin(f), cf = cos(f);
      const QWAs = Q.mul(WA).mul(sf);
      dx = dx.add(Q.mul(A).mul(dirX).mul(cf));
      dy = dy.add(A.mul(sf));
      dz = dz.add(Q.mul(A).mul(dirZ).mul(cf));
      tx = tx.sub(QWAs.mul(dirX).mul(dirX));
      ty = ty.add(WA.mul(dirX).mul(cf));
      tz = tz.sub(QWAs.mul(dirX).mul(dirZ));
      bx = bx.sub(QWAs.mul(dirX).mul(dirZ));
      by = by.add(WA.mul(dirZ).mul(cf));
      bz = bz.sub(QWAs.mul(dirZ).mul(dirZ));
      fold = fold.add(QWAs);
    }
    const tangent = normalize(vec3(tx, ty, tz)), binormal = normalize(vec3(bx, by, bz));
    return { disp: vec3(dx, dy, dz), tangent, binormal, normal: normalize(cross(binormal, tangent)), fold };
  }

  /** Surface nodes at world xz + sheet-local radius rLoc: { wave, lagG, shoreY, shoreXZ, shoreSlope, cellV }.
   *  The sheet's vertex stage uses it; a surf/wash layer should ride the same call. */
  surfaceAt(worldXZ, rLoc) {
    const u = this.u, { extent, deep } = this.options.bed, sh = this.options.sheet;
    const bedUV = worldXZ.sub(u.bedOrigin).div(extent).add(0.5);
    const edge = max(abs(bedUV.x.sub(0.5)), abs(bedUV.y.sub(0.5)));
    // Smoothed depth (centre + four taps 8 m out): raw texels wobble under the coarse outer cells.
    const tap = (ox, oz) => texture(this.bedTexture, bedUV.add(vec2(ox, oz).div(extent))).level(0).r;
    const bC = tap(0, 0), bXp = tap(8, 0), bXm = tap(-8, 0), bZp = tap(0, 8), bZm = tap(0, -8);
    const bedSmooth = bC.mul(0.34).add(bXp.add(bXm).add(bZp).add(bZm).mul(0.165));
    const depthV = mix(float(this.seaLevel).sub(bedSmooth), float(deep), edge.smoothstep(0.40, 0.49)).max(0.0);
    // Shoaling = Green's law clamp; refraction = bounded static phase lag. Never scale omega by depth
    // (unbounded shear) or rotate directions per vertex (phase noise).
    const shoalAmp = pow(u.shoalRef.div(depthV.max(0.6)), 0.25).clamp(1.0, u.shoalMax);
    const lagG = oneMinus(depthV.div(u.shoalRef).clamp(0.0, 1.0).sqrt()).mul(u.shoreBend);
    const cleanT = depthV.div(u.shoalRef).clamp(0.0, 1.0);
    // makeWaterGeometry's mapping, differentiated: the local cell size
    const cellV = max(float(this.sheetCell), rLoc.sub(sh.inner).div(sh.outer - sh.inner).clamp(0.0, 1.0).pow((SHEET_CURVE - 1) / SHEET_CURVE)
      .mul((2 / sh.segments) * (sh.outer - sh.inner) * SHEET_CURVE / (1 - sh.frac)));
    const wave = this._gerstner(worldXZ, shoalAmp, lagG, cleanT, cellV);

    // Shore train; the same taps give the bed gradient (uphill = shoreward).
    const bedGrad = vec2(bXp.sub(bXm), bZp.sub(bZm)).div(16.0);
    const gMag = length(bedGrad).max(1e-4);
    const shoreDir = bedGrad.div(gMag);
    const phiS = this.shorePhase(depthV, worldXZ);
    // Growth to the ~1.4 m break, then collapse to a 0.35 bore.
    const growS = oneMinus(depthV.div(u.shoalRef)).clamp(0.0, 1.0).div(oneMinus(float(1.4).div(u.shoalRef))).min(1.0).pow(1.6);
    const peakT = depthV.smoothstep(0.3, 1.4).mul(growS).mul(growS);
    const ampEnv = growS.mul(mix(float(0.35), float(1.0), depthV.smoothstep(0.2, 1.4))).mul(oneMinus(edge.smoothstep(0.40, 0.49)));
    const trainFade = oneMinus(rLoc.smoothstep(170.0, 300.0)); // coarser cells alias the train's shape
    const aS = u.amp.mul(u.shoreWave).mul(ampEnv).mul(trainFade);
    const sS = sin(phiS), cS = cos(phiS);
    const Pk = float(1.0).add(peakT.mul(u.breakerPeak));
    const s01 = sS.mul(0.5).add(0.5).max(1e-4);
    const shoreY = pow(s01, Pk).mul(2.0).sub(1.0).add(Pk.sub(1.0).mul(0.19)).mul(aS); // +0.19 (P-1): the mean the power removes
    const shoreXZ = shoreDir.mul(aS).mul(cS).mul(float(0.5).add(peakT));             // crest leans shoreward
    const dYds = aS.mul(Pk).mul(pow(s01, Pk.sub(1.0))).mul(cS).mul(gMag.mul(-this.shoreKd));
    return { wave, lagG, shoreY, shoreXZ, shoreSlope: shoreDir.mul(dYds), cellV };
  }

  _buildMaterial() {
    const u = this.u, o = this.options;
    const fogColor = this.fogColor;
    const worldXZ = positionLocal.xz.add(u.origin);
    const vertFade = oneMinus(length(positionLocal.xz).smoothstep(o.fade.vertex[0], o.fade.vertex[1]));
    const { wave, lagG, shoreY, shoreXZ, shoreSlope } = this.surfaceAt(worldXZ, length(positionLocal.xz));

    // Normal flattens WITH the displacement (else Fresnel bands across the flat far ring).
    const nShore = normalize(vec3(wave.normal.x.sub(shoreSlope.x), wave.normal.y, wave.normal.z.sub(shoreSlope.y)));
    const vNormal = varying(normalize(mix(vec3(0.0, 1.0, 0.0), nShore, vertFade)));
    const vTangent = varying(wave.tangent);
    const vBinormal = varying(wave.binormal);
    const vFold = varying(wave.fold.mul(vertFade));
    const vHeight = varying(wave.disp.y.add(shoreY).mul(vertFade));
    const vDispXZ = varying(wave.disp.xz.add(shoreXZ).mul(vertFade)); // foam rides the orbital motion
    const vLag = varying(lagG);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.fog = true;              // the scene's fog, same as the land; never a private sea fog
    mat.transparent = true;      // after the opaque seabed: refraction reads it
    mat.side = THREE.DoubleSide; // underside = the underwater ceiling
    mat.positionNode = positionLocal.add(wave.disp.add(vec3(shoreXZ.x, shoreY, shoreXZ.y)).mul(vertFade));

    const mirror = this.mirror;
    const mirrorBaseUV = mirror.uvNode; // captured so the reassignment below stays idempotent
    const w0 = this.waveUniforms[0];
    const FOLD_SUM = this.FOLD_SUM, extent = o.bed.extent, deep = o.bed.deep, seaLevel = this.seaLevel;

    const bedUVw = positionWorld.xz.sub(u.bedOrigin).div(extent).add(0.5);
    const bedHw = texture(this.bedTexture, bedUVw).r;
    const columnW = positionWorld.y.sub(bedHw).max(0);

    // Soft waterline over shoreFade m of column; near the boost point the thin sheet keeps some opacity
    // to carry its reflection, the last 12 cm still fade.
    const boostNearO = oneMinus(length(positionWorld.xz.sub(u.boostPos.xz)).smoothstep(3.0, 14.0));
    mat.opacityNode = max(mix(float(1), columnW.smoothstep(0, u.shoreFade), u.shoreFadeOn),
      boostNearO.mul(u.boostRefl).mul(1.8).min(0.85).mul(columnW.smoothstep(0.0, 0.12)));

    mat.colorNode = Fn(() => {
      const Pw = positionWorld;
      const V = normalize(cameraPosition.sub(Pw));
      const L = normalize(u.sunDir);
      const dist = length(cameraPosition.xz.sub(Pw.xz)).toVar();
      const detail = oneMinus(dist.smoothstep(o.fade.detail[0], o.fade.detail[1])).toVar();

      // Analytic noise mip: fw = pixel footprint (m); band(f) = surviving share of a noise of f
      // cycles/m. Each layer fades to its MEAN by its own band.
      const fw = length(fwidth(Pw.xz)).mul(u.noiseFilter).toVar();
      const band = (cpm) => oneMinus(fw.mul(cpm).smoothstep(0.25, 0.75));

      // Ripple normals, time as the third axis; 4 octaves weighted by band.
      const np = vec3(Pw.xz.mul(u.rippleSc), u.time.mul(0.35));
      const e = 0.09;
      const ripW = [0, 1, 2, 3].map((i) => band(u.rippleSc.mul(2 ** i)).mul(0.55 ** i).toVar());
      const ripH = (p) => ripW.reduce((sum, w, i) => sum.add(mx_noise_float(p.mul(2 ** i)).mul(w)), float(0.0));
      const ripLost = oneMinus(ripW.reduce((sum, w) => sum.add(w), float(0.0)).div(1 + 0.55 + 0.55 ** 2 + 0.55 ** 3));
      const h0 = ripH(np);
      const gx = ripH(np.add(vec3(e, 0, 0))).sub(h0).div(e);
      const gz = ripH(np.add(vec3(0, e, 0))).sub(h0).div(e);
      const bent = vNormal.sub(vTangent.mul(gx).add(vBinormal.mul(gz)).mul(u.ripple).mul(detail));
      const N = normalize(vec3(bent.x, max(bent.y, 0.06), bent.z)).toVar();
      const NoV = dot(N, V).clamp(0, 1);
      const NoL = dot(N, L).clamp(0, 1).toVar();

      // Schlick Fresnel, water F0 = 0.02.
      const F = float(0.02).add(pow(oneMinus(NoV), 5).mul(0.98)).mul(u.reflect).clamp(0, 1).toVar();

      mirror.uvNode = mirrorBaseUV.add(N.xz.mul(u.distort).mul(0.55).mul(detail));
      // Far field: haze the reflection toward the fog colour (the flat ring mirrors clouds in patches).
      const reflCol = mix(mirror.rgb, fogColor, dist.smoothstep(o.fade.haze[0], o.fade.haze[1]).mul(0.9));

      // Water column; beyond the tile force deep (its clamped border would read as shallow).
      const tileEdge = max(abs(bedUVw.x.sub(0.5)), abs(bedUVw.y.sub(0.5)));
      const column = mix(columnW, float(deep), tileEdge.smoothstep(0.40, 0.49)).toVar();
      const thick = column.div(max(V.y, 0.22)).toVar();

      // Refraction; distortion fades in the shallows (taps would land on objects in front).
      const off = N.xz.mul(u.distort).mul(column.smoothstep(0.0, 2.0)).mul(detail);
      let bottom = viewportSharedTexture(screenUV.add(off).clamp(vec2(0.002), vec2(0.998))).rgb;

      const cw = mx_fractal_noise_float(vec3(Pw.xz.mul(0.32), u.time.mul(0.22)), 3, 2.0, 0.5, 1.0);
      const caus = pow(oneMinus(cw.abs().mul(2.1)).clamp(0, 1), 3).mul(band(0.64));
      bottom = bottom.add(u.sunColor.mul(caus).mul(u.caustics).mul(exp(column.mul(-0.10))).mul(NoL));

      // Beer-Lambert: per-channel transmittance + in-scattered body colour.
      const trans = exp(thick.mul(u.absorb).negate().mul(u.absorbTint));
      const inScatter = oneMinus(exp(thick.mul(u.absorb).mul(-0.55)));
      const body = mix(u.deep, u.shallow, exp(thick.mul(u.absorb).mul(-0.65)));
      const refrCol = bottom.mul(trans).add(body.mul(inScatter));

      // GGX glint; filtered-away ripples become roughness. Clamped (assumes no bloom).
      const H = normalize(L.add(V));
      const a = max(u.rough.add(ripLost.mul(u.ripple).mul(0.3)), 0.02);
      const a2 = a.mul(a).mul(a).mul(a);
      const NoH = dot(N, H).clamp(0, 1);
      const den = NoH.mul(NoH).mul(a2.sub(1)).add(1);
      const spec = a2.div(den.mul(den).mul(Math.PI).add(1e-5)).mul(F).mul(NoL).mul(u.spec).min(12);

      // Backlit subsurface through crests.
      const lift = vHeight.mul(0.30).clamp(0, 1);
      const backLit = pow(dot(V, L.negate()).mul(0.5).add(0.5).clamp(0, 1), 3);
      const sss = u.shallow.mul(u.sunColor).mul(lift).mul(backLit).mul(u.sss);

      // ---- foam, sampled at the REST position so it rides the water ----
      const pS = Pw.xz.sub(vDispXZ).mul(u.foamScale).toVar();
      const flow = vec2(u.time.mul(0.15), u.time.mul(-0.09));

      // Shore pulse: dP = distance from the waterline in foam units via column depth (2.4 = gone).
      const dP = column.div(max(u.shore, 0.01)).mul(2.4).toVar();
      const ring = float(0.0).toVar(), contact = float(0.0).toVar();
      If(dP.lessThan(2.4), () => { // both are exactly 0 beyond: skips 9 octaves offshore
        const jit = fbm01(vec3(pS.mul(0.35), u.time.mul(0.08)), 3);
        const surge = sin(dP.mul(jit.mul(1.6).add(1.9)).sub(u.time.mul(2.1)).add(jit.mul(3.0))).mul(0.5).add(0.5);
        const ringVary = fbm01(vec3(pS.mul(0.22).add(71.0), u.time.mul(0.05)), 3).mul(0.8).add(0.5);
        ring.assign(oneMinus(dP.smoothstep(0.0, 2.4)).mul(surge.mul(0.60).add(0.12)).mul(ringVary));
        const dn = dP.add(fbm01(vec3(pS.mul(2.4).add(5.0), u.time.mul(0.30)), 3).sub(0.5).mul(0.45));
        const c = oneMinus(dn.smoothstep(-0.2, 0.75));
        contact.assign(c.mul(c).mul(surge.mul(0.40).add(0.30)));
      });

      // Crest foam: fold-based whitecaps skewed onto the back of the dominant crest.
      const phi0 = this._wavePhase(w0, Pw.xz).f.sub(vLag.mul(w0.k));
      const sinceCrest = fract(float(Math.PI * 0.5).sub(phi0).div(Math.PI * 2));
      const sK = fract(sinceCrest.add(h0.mul(0.08))); // ripple-bent, with a ramp at the wrap: no ruler line
      const skew = max(exp(sK.mul(u.crestSkew).negate()), smoothstep(0.93, 1.0, sK));
      const crestCover = vFold.div(FOLD_SUM).mul(u.crest).smoothstep(u.crestThresh, u.crestThresh.add(0.12)).mul(skew).clamp(0, 1);

      // Breaking: breaker index ~0.78 (height / column), shoaling zone only.
      const breaking = vHeight.max(0.0).mul(2.0).div(column.max(0.15)).smoothstep(0.45, 0.78)
        .mul(oneMinus(column.smoothstep(4.0, 8.0))).mul(0.8);
      const foamAmt = ring.mul(0.945).add(contact.mul(0.585)).add(crestCover).add(breaking).clamp(0, 1);

      // Lace: two warped, advected fbm layers + holes.
      const warp = vec2(
        mx_fractal_noise_float(vec3(pS.mul(0.5), u.time.mul(0.06)), 3, 2.0, 0.5, 1.0),
        mx_fractal_noise_float(vec3(pS.mul(0.5).add(53.0), u.time.mul(0.06)), 3, 2.0, 0.5, 1.0),
      ).mul(1.3);
      const pw = pS.add(warp).toVar();
      const f1 = fbm01(vec3(pw.mul(1.9).add(flow.mul(2.0)), u.time.mul(0.18)), 4).toVar();
      const f2 = fbm01(vec3(pw.mul(4.8).sub(flow.mul(3.0)).add(17.0), u.time.mul(0.26)), 3).toVar();
      const holes = fbm01(vec3(pS.mul(8.0).add(43.0), u.time.mul(0.4)), 3).toVar();
      const lace = f1.smoothstep(0.46, 0.66).mul(0.7).add(f2.smoothstep(0.50, 0.62).mul(0.6))
        .mul(holes.smoothstep(0.30, 0.60).mul(0.45).add(0.55)).toVar();
      lace.assign(mix(float(0.3), lace, band(u.foamScale.mul(3.8)))); // 0.3 = mean coverage
      const foamMask = foamAmt.mul(lace).mul(1.5).add(contact.mul(lace).mul(0.40)).add(contact.mul(0.06)).clamp(0, 1).toVar();

      // Floating foam: sparse elongated patches drifting on open water.
      const drift = vec2(u.time.mul(0.045), u.time.mul(0.028));
      const pStreak = vec2(pw.x.mul(0.42).add(pw.y.mul(0.20)), pw.y.mul(1.05).sub(pw.x.mul(0.12))).add(drift.mul(8.0));
      const patch = fbm01(vec3(pStreak.mul(0.55), u.time.mul(0.05)), 3).smoothstep(0.585, 0.70).mul(u.floatFoam);
      foamMask.assign(foamMask.add(patch.mul(lace).mul(0.55)).clamp(0, 1));
      foamMask.assign(foamMask.mul(foamMask).mul(float(3.0).sub(foamMask.mul(2.0))));

      // Worley bubbles shade the interior; each tap fades to its 0.4 mean by band and is skipped once gone.
      const bubB1 = band(u.foamScale.mul(9.0)).toVar(), bubB2 = band(u.foamScale.mul(24.0)).toVar();
      const bub1 = float(0.4).toVar(), bub2 = float(0.4).toVar();
      If(bubB1.greaterThan(0.0), () => {
        bub1.assign(mix(float(0.4), oneMinus(worleyDist(pS.mul(9.0).add(flow.mul(4.0))).smoothstep(0.30, 0.80)), bubB1));
      });
      If(bubB2.greaterThan(0.0), () => {
        bub2.assign(mix(float(0.4), oneMinus(worleyDist(pS.mul(24.0).sub(flow.mul(6.0))).smoothstep(0.25, 0.70)), bubB2));
      });
      foamMask.assign(foamMask.mul(mix(bub2.mul(0.85).add(0.15), float(1.0), foamMask)));

      // Whitewater + wash in the surf zone: breaking, or a wash decaying since the train's crest passed;
      // a billow whose threshold opens with age. Seaward edge noised +-30 % by f1.
      const inSurf = oneMinus(column.div(u.shore.mul(1.2).mul(f1.mul(0.6).add(0.7))).smoothstep(0.35, 1.0)).toVar();
      If(inSurf.greaterThan(0.001), () => {
        // Train phase PER PIXEL (never a varying: outer cells are wider than the train's wavelength).
        const phiPx = this.shorePhase(float(seaLevel).sub(bedHw).max(0.0), Pw.xz);
        const sinceShore = fract(phiPx.sub(Math.PI / 2).div(Math.PI * 2));
        const sW = fract(sinceShore.add(f1.sub(0.5).mul(0.18)));
        const age = max(exp(sW.mul(u.crestSkew).mul(0.1833).negate()), smoothstep(0.88, 1.0, sW));
        const whiteAmt = max(breaking, age).mul(inSurf).clamp(0, 1);
        const soft = fbm01(vec3(pS.mul(0.42).add(flow.mul(0.6)), u.time.mul(0.06)), 3);
        const grain = f2.sub(0.5).mul(0.55).mul(band(u.foamScale.mul(4.8)))
          .add(holes.sub(0.5).mul(0.40).mul(band(u.foamScale.mul(8.0)))).mul(u.surfGrain);
        const softG = soft.add(grain);
        const tight = u.surfGrain.clamp(0.0, 1.0).mul(0.10);
        const billow = softG.smoothstep(mix(float(0.66), float(0.30), whiteAmt).add(tight.mul(0.4)), mix(float(0.84), float(0.68), whiteAmt).sub(tight));
        foamMask.assign(max(foamMask, whiteAmt.mul(billow).mul(softG.mul(0.5).add(0.62)).clamp(0, 1)));
      });

      const film = oneMinus(dP.smoothstep(0.4, 3.5)).mul(f1.smoothstep(0.35, 0.65)).mul(0.10); // milky residue

      const boostNear = oneMinus(length(Pw.xz.sub(u.boostPos.xz)).smoothstep(3.0, 14.0));
      let col = mix(refrCol, reflCol, F.add(boostNear.mul(u.boostRefl)).clamp(0, 1));
      col = col.add(sss).add(u.sunColor.mul(spec).mul(oneMinus(foamMask.mul(0.75))));
      // Foam light = max(foamLight, fog colour x 1.1): never black at dawn/dusk, never glowing at night.
      const foamLit = u.foam.mul(max(NoL, 0.25).mul(0.85).add(0.55))
        .mul(h0.mul(0.5).add(0.5).mul(0.3).add(0.85))
        .mul(float(0.72).add(bub1.mul(0.16)).add(bub2.mul(0.12)))
        .mul(max(vec3(u.foamLight), fogColor.mul(1.1)));
      col = mix(col, foamLit.mul(0.75), film);
      col = mix(col, foamLit, foamMask);
      const edgeFoam = oneMinus(column.smoothstep(0.0, 0.5)).mul(lace.mul(0.60).add(0.40));
      col = mix(col, foamLit, edgeFoam.clamp(0, 1).mul(0.55));

      // Spot splash: cone/range attenuation, GGX glint + faint diffuse, x2.2 on foam. A real If:
      // multiplying by a zero uniform does not skip the work.
      const hl = float(0).toVar();
      If(u.spotSum.greaterThan(0.001), () => {
        let sum = float(0);
        for (const s of this.spotU) {
          const toFrag = Pw.sub(s.pos);
          const d = length(toFrag);
          const L2 = toFrag.div(max(d, 1e-4));
          const atten = oneMinus(d.div(s.range)).clamp(0, 1).pow(2).mul(dot(L2, s.dir).smoothstep(s.cone.x, s.cone.y));
          const Lv = L2.negate();
          const NoHh = dot(N, normalize(Lv.add(V))).clamp(0, 1);
          const denh = NoHh.mul(NoHh).mul(a2.sub(1)).add(1);
          const ggxh = a2.div(denh.mul(denh).mul(Math.PI).add(1e-5));
          sum = sum.add(atten.mul(dot(N, Lv).clamp(0, 1)).mul(ggxh.mul(F).mul(2.2).add(0.10)).mul(s.intensity));
        }
        hl.assign(sum.mul(mix(float(1), float(2.2), foamMask)));
      });
      col = col.add(vec3(1.0, 0.93, 0.73).mul(hl));

      // Seen from below: Snell window, dark internal reflection, faint foam, sun glow. Inside If
      // (select() would evaluate both sides on every pixel).
      const surfCol = vec3(col).toVar();
      If(frontFacing.not(), () => {
        const thru = V.negate();
        const belowSky = mix(vec3(0.46, 0.53, 0.55), vec3(0.20, 0.28, 0.32), pow(max(thru.y, 0.06).clamp(0, 1), 0.55));
        surfCol.assign(mix(vec3(0.020, 0.075, 0.085), belowSky.mul(vec3(0.55, 0.80, 0.80)), thru.y.smoothstep(0.30, 0.80))
          .add(foamLit.mul(foamMask).mul(0.35))
          .add(u.sunColor.mul(pow(max(dot(thru, normalize(u.sunDir)), 0.0), 60.0)).mul(0.5))
          .mul(u.foamLight.clamp(0.12, 1.0)));
      });
      return surfCol; // scene fog applies after (mat.fog): it hides the flat outer ring
    })();
    return mat;
  }

  /* Gerstner height at a fixed world point: invert the horizontal offset (2 fixed-point passes), sum
     vertical terms. Mirrors _gerstner + vertFade; open sea only (no shoaling, no shore train). */
  _waveHeightAt(qx, qz, camX, camZ) {
    const t = this.u.time.value, A = this.u.amp.value, Q = this.u.chop.value, fv = this.options.fade.vertex;
    const fade = 1 - THREE.MathUtils.smoothstep(Math.hypot(qx - camX, qz - camZ), fv[0], fv[1]);
    if (fade <= 0) return 0;
    const phase = (w, px, pz) => {
      if (!w.ring) return { f: w.k * (w.dx * px + w.dz * pz) - t * w.k * w.c + w.phase, dx: w.dx, dz: w.dz };
      const tx = w.cx - px, tz = w.cz - pz, r = Math.max(1, Math.hypot(tx, tz));
      return { f: -r * w.k - t * w.k * w.c + w.phase, dx: tx / r, dz: tz / r };
    };
    let px = qx, pz = qz;
    for (let pass = 0; pass < 2; pass++) {
      let ox = 0, oz = 0;
      for (const w of this.waves) {
        const p = phase(w, px, pz), qa = Q * A * w.amp * Math.cos(p.f);
        ox += qa * p.dx; oz += qa * p.dz;
      }
      px = qx - ox; pz = qz - oz;
    }
    let dy = 0;
    for (const w of this.waves) dy += A * w.amp * Math.sin(phase(w, px, pz).f);
    return dy * fade;
  }

  /** Surface world Y at (x, z) for floating objects. Pass the camera xz so the fade matches the drawn sheet. */
  surfaceHeightAt(x, z, camX = x, camZ = z) {
    return this.seaLevel + this._waveHeightAt(x, z, camX, camZ);
  }

  /** Camera depth below the surface (m); <= 0 above water, -1 while the sheet is hidden. Drives underwater fog. */
  submersion(camera) {
    if (!this.mesh.visible) return -1;
    const p = camera.position;
    return this.surfaceHeightAt(p.x, p.z) - p.y;
  }

  /** Layers mask for the reflector's virtual camera (e.g. (1 << SKY) | (1 << VEHICLES)); null = inherit. */
  setReflectionLayers(mask) { this.reflectionLayers = mask; }

  /** Spot lights (THREE.SpotLight, up to spotSlots) whose cones splash on the water; read every update. */
  setSpots(spots) { this.spots = spots || []; }

  /** Lift the reflection share within ~14 m of a point (a player vehicle reads better in its own reflection). */
  setReflectionBoost(position, strength = 0.2) {
    if (position) this.u.boostPos.value.copy(position); else this.u.boostPos.value.set(0, -1e5, 0);
    this.u.boostRefl.value = position ? strength : 0;
  }

  /** Bed height with domes + boxes stamped in (parabolic rims, crest just under the waterline). */
  _bedHeightAt(x, z) {
    const sl = this.seaLevel, RIM = 3, CREST = -0.35; // crest >= 0 makes the soft waterline cut holes beside hulls
    let h = this.options.heightAt(x, z);
    for (const r of this._domes) {
      const dx = x - r.x, dz = z - r.z, R = r.r * 1.5, d2 = dx * dx + dz * dz;
      if (d2 < R * R) h = Math.max(h, sl + 0.4 - 3.2 * (d2 / (R * R)));
    }
    for (const b of this._boxes) {
      const dx = x - b.x, dz = z - b.z;
      const lx = Math.abs(dx * b.c - dz * b.s) - b.hx, lz = Math.abs(dx * b.s + dz * b.c) - b.hz;
      const d2 = Math.max(lx, 0) ** 2 + Math.max(lz, 0) ** 2;
      if (d2 < RIM * RIM) h = Math.max(h, sl + CREST - 3.2 * (d2 / (RIM * RIM)));
    }
    return h;
  }

  _startBedJob(cx, cz) {
    const B = this.options.bed;
    const st = this.options.stamps ? this.options.stamps(cx, cz, B.extent / 2 + 40) || {} : {};
    this._domes = st.domes || [];
    this._boxes = (st.boxes || []).map((b) => ({ ...b, c: Math.cos(b.yaw || 0), s: Math.sin(b.yaw || 0) }));
    this._bedJob = { x: cx, z: cz, row: 0, data: new Uint16Array(B.res * B.res) };
  }

  _stepBedJob(rows) {
    const job = this._bedJob, { res, extent } = this.options.bed;
    const end = Math.min(res, job.row + rows);
    for (; job.row < end; job.row++) {
      const z = job.z + ((job.row + 0.5) / res - 0.5) * extent;
      for (let i = 0; i < res; i++) {
        const x = job.x + ((i + 0.5) / res - 0.5) * extent;
        job.data[job.row * res + i] = THREE.DataUtils.toHalfFloat(this._bedHeightAt(x, z));
      }
    }
    if (job.row < res) return;
    // Swap atomically: pixels and origin must always agree.
    this.bedTexture.image.data.set(job.data);
    this.bedTexture.needsUpdate = true;
    this.u.bedOrigin.value.set(job.x, job.z);
    this._bedAt.set(job.x, job.z);
    this._bedJob = null;
  }

  /** Synchronous full bake around (x, z): call once at boot so the first frames have a shore. */
  bakeBedNow(x, z) {
    if (!this.options.heightAt) return;
    this._startBedJob(x, z);
    this._stepBedJob(this.options.bed.res);
  }

  /** Reflection pass: top-level, AFTER update() and BEFORE the scene render, every frame the sea shows. */
  renderMirror(renderer, camera) {
    if (!this.mesh.visible) return false;
    camera.updateMatrixWorld();
    // Cloned once per camera by three; only its matrices refresh, so the mask set here holds.
    if (this.reflectionLayers !== null) this.mirror.reflector.getVirtualCamera(camera).layers.mask = this.reflectionLayers;
    const f = this._mirrorFrame;
    f.camera = camera; f.renderer = renderer; f.material = this.mesh.material; // the reflector hides this material
    this._mirrorManual = true;
    try { this.mirror.reflector.updateBefore(f); } finally { this._mirrorManual = false; }
    return true;
  }

  /** Per frame: clocks, gate, follow camera (lattice-snapped), glint light (moon = sun antipode), spots, seabed. */
  update(camera, dt, sunDir) {
    const u = this.u, o = this.options;
    u.time.value += dt * this.params.timeScale;
    for (const w of this.waveUniforms) w.tph.value = (w.k * w.c * u.time.value) % (Math.PI * 2);
    u.shoreT.value = (this.shoreOmega * u.time.value) % (Math.PI * 2);

    if (o.isActive && this._gateTick++ % 15 === 0) this.mesh.visible = !!o.isActive(camera);
    if (!this.mesh.visible) return;

    // Snap the origin to the sheet cell: the vertex stage samples the seabed, sliding vertices wobble crests.
    const cell = this.sheetCell;
    const ox = Math.round(camera.position.x / cell) * cell, oz = Math.round(camera.position.z / cell) * cell;
    this.mesh.position.set(ox, this.seaLevel, oz);
    u.origin.value.set(ox, oz);

    if (sunDir.y > 0.015) {
      u.sunDir.value.copy(sunDir);
      const low = 1 - THREE.MathUtils.smoothstep(sunDir.y, -0.03, 0.44);
      const k = THREE.MathUtils.lerp(0.55, 1.25, 1 - low);
      u.sunColor.value.setRGB(k, k * (1 - 0.32 * low), k * (1 - 0.66 * low));
    } else {
      const moon = Math.max(0, -sunDir.y) ** 0.6;
      u.sunDir.value.copy(sunDir).negate();
      u.sunColor.value.setRGB(0.30, 0.36, 0.48).multiplyScalar(0.25 + 0.75 * moon);
    }
    const dayL = THREE.MathUtils.smoothstep(sunDir.y, -0.04, 0.3);
    u.foamLight.value = Math.min(1, 0.05 + 0.95 * dayL + 0.18 * Math.max(0, -sunDir.y) ** 0.6);

    let spotSum = 0;
    this.spotU.forEach((s, i) => {
      const spot = this.spots[i];
      const on = spot && spot.visible && spot.intensity > 0;
      s.intensity.value = on ? spot.intensity * o.spotGain : 0;
      if (!on) return;
      spot.getWorldPosition(s.pos.value);
      spot.target.getWorldPosition(_v);
      s.dir.value.copy(_v).sub(s.pos.value).normalize();
      s.cone.value.set(Math.cos(spot.angle), Math.cos(spot.angle * (1 - Math.max(spot.penumbra, 0.05))));
      s.range.value = spot.distance > 0 ? spot.distance : 55;
      spotSum += s.intensity.value;
    });
    u.spotSum.value = spotSum;

    if (!o.heightAt) return;
    this._camXZ.set(camera.position.x, camera.position.z);
    if (!this._bedJob && this._camXZ.distanceTo(this._bedAt) > o.bed.rebakeDistance) this._startBedJob(this._camXZ.x, this._camXZ.y);
    if (this._bedJob) this._stepBedJob(o.bed.rowsPerFrame);
  }

  /** Push one params key into its uniform (wave lengths/directions are compiled constants). */
  push(key) {
    const P = this.params, u = this.u;
    if (key === 'shoreFadeOn') { u.shoreFadeOn.value = P.shoreFadeOn ? 1 : 0; return; }
    if (PARAM_UNIFORMS[key]) { u[PARAM_UNIFORMS[key]].value = P[key]; return; }
    if (key === 'deep' || key === 'shallow' || key === 'foam' || key === 'absorbTint') u[key].value.set(P[key]);
  }

  applyPreset(name) {
    Object.assign(this.params, this.presets[name]);
    for (const key of Object.keys(this.params)) this.push(key);
  }

  /** lil-gui folder: preset picker + sliders. */
  attachGui(folder) {
    const P = this.params;
    const sync = () => folder.controllers.forEach((c) => c.updateDisplay());
    folder.add({ preset: this.options.preset }, 'preset', Object.keys(this.presets)).onChange((v) => { this.applyPreset(v); sync(); });
    const rows = [
      ['amplitude', 0, 4.5, 0.01], ['choppiness', 0, 1, 0.01], ['timeScale', 0, 3, 0.01],
      ['rippleStrength', 0, 1.2, 0.01], ['rippleScale', 0.01, 0.16, 0.002],
      ['roughness', 0.01, 0.6, 0.005], ['reflectivity', 0, 1.4, 0.01],
      ['refractDistort', 0, 0.18, 0.002], ['specular', 0, 5, 0.05],
      ['absorb', 0.01, 0.5, 0.005], ['caustics', 0, 2, 0.02], ['sss', 0, 2.5, 0.02],
      ['crestFoam', 0, 3, 0.02], ['crestThresh', 0.02, 0.9, 0.005], ['crestSkew', 0, 8, 0.05],
      ['shoreFoam', 0.2, 8, 0.05], ['shoreFade', 0.02, 2.5, 0.01],
      ['foamScale', 0.03, 0.4, 0.005], ['floatFoam', 0, 2, 0.01],
    ];
    for (const [key, lo, hi, st] of rows) folder.add(P, key, lo, hi, st).onChange(() => this.push(key));
    folder.add(P, 'shoreFadeOn').onChange(() => this.push('shoreFadeOn'));
    for (const key of ['deep', 'shallow', 'foam', 'absorbTint']) folder.addColor(P, key).onChange(() => this.push(key)); // absorbTint = rates: more red = LESS red light
    return folder;
  }

  dispose() {
    this.scene.remove(this.mesh, this.mirror.target);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.bedTexture.dispose();
    this.mirror.reflector.dispose();
  }
}
