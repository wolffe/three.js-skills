// windowMaterial.tsl.js — layered-parallax "window mapping" for THREE.WebGPURenderer (TSL).
//
// The layer model: a flat pane; a little behind the glass (dressingDepth) the
// dressing, blinds, roller blinds, curtains or nets, drawn by parallax; behind
// that (interiorDepth, with a mid plane at 0.38 of it) a blurred hint of a room
// that shifts as the viewer moves; the frame and glazing bars on the glass; at
// night, lights on in a share of the windows. Every window has a seed of its
// own (from its grid cell, or a windowId attribute), so no two dress alike.
// Options: WINDOW_DEFAULTS below. One option is not in that list: coords, a
// TSL node giving continuous window coordinates (one unit per window) in place
// of the UVs, for a surface that is not a quad; never clamp it (zero derivatives
// give NaN).
//
// Usage:
//   import { createWindowMaterial, setWindowNight } from './windowMaterial.tsl.js';
//   const mat = createWindowMaterial({ dressing: { venetian: 1 } });
//   scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), mat));
//
// Written against three r187; TSL names move between releases, so if an import
// fails, check `three/tsl` in the installed version before rewriting anything.

import * as THREE from 'three/webgpu';
import {
  Fn, uniform, uv, positionView, cameraWorldMatrix, modelWorldMatrix, instanceIndex, varying, attribute, texture,
  float, vec2, vec3, vec4, dFdx, dFdy, mix, step, smoothstep, fract, floor, abs, max, min, clamp, dot, cross,
  normalize, length, reflect, pow, exp, sin, select, property,
} from 'three/tsl';

export const WINDOW_DEFAULTS = {
  // --- layout --------------------------------------------------------------
  unitsPerMeter: 1,          // scene units per metre (100 if the scene is in cm)
  grid: [1, 1],              // windows per quad: [cols, rows]. >1 = one quad covers a facade
  idAttribute: false,        // true = read per-window seed from a float `windowId` attribute

  // --- parallax depths, metres behind the glass ------------------------------
  dressingDepth: 0.08,       // blinds / curtains
  interiorDepth: 2.2,        // back plane of the blurry hint; mid plane sits at 0.38x

  // --- interior hint ---------------------------------------------------------
  interiorTint: 0x8f887c,    // overall colour of the unlit room
  interiorMap: null,         // optional THREE.Texture (any photo); sampled blurred on the back plane
  interiorMapBlur: 4,        // mip bias used when interiorMap is set (higher = blurrier)
  interiorMapSize: 3.0,      // metres the texture spans at the back plane
  ambient: 0.5,              // daytime visibility of the room (0 = black glass)

  // --- lights (night) --------------------------------------------------------
  night: 0,                  // 0 = day, 1 = night; drive with setWindowNight()
  litRatio: 0.6,             // share of windows with lights on at night
  warm: 0xffb066,            // incandescent tone
  cool: 0x9fc4ff,            // TV / fluorescent tone
  coolChance: 0.15,
  lightLevel: 2.2,           // emissive strength of a lit room
  transmission: 0.35,        // how much room light glows through closed blinds / curtains

  // --- dressing (per-window random pick, weights) ------------------------------
  dressing: { venetian: 1, roller: 1, curtains: 1, bare: 1 },
  sheerChance: 0.35,         // chance of a net curtain (only behind curtains or bare glass)
  dressingColorA: 0xf2efe6,  // dressing colour is a per-window blend A..B
  dressingColorB: 0xb9ac98,
  slatPitch: 0.035,          // venetian slat spacing, metres
  dropMin: 0.35,             // blinds are lowered between dropMin..1 of the window height

  // --- frame -----------------------------------------------------------------
  frameWidth: 0.05,          // metres; 0 disables the frame
  mullionWidth: 0.035,       // metres; 0 disables glazing bars
  panes: [2, 1],             // glazing bars split the window into [cols, rows] panes
  frameColor: 0xf4f4f1,

  // --- glass -----------------------------------------------------------------
  glassRoughness: 0.06,
  haze: 0.0,                 // 0..1 milky/dirty veil; raises the "nondescript" factor
  skyColor: 0xbcd4ee,        // fake sky reflection (works without an environment map)
  horizonColor: 0x7f8a8c,    // what the glass mirrors head-on: the street opposite, not the sky
  groundColor: 0x4a463f,
  reflection: 1.0,           // strength of the fake reflection; set 0 if scene.environment is set
  glassReflectance: 0.1,     // head-on reflectance; ~0.1 suits double glazing, 0.04 a single pane
  grazingFade: 1.0,          // 0..1 how hard the interior fades into reflection at shallow angles

  seed: 0,                   // change to reshuffle every window
};

const TAU = 6.28318;

const winHash2 = /*@__PURE__*/ Fn(([p]) => {
  const q = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  q.addAssign(dot(q, q.yzx.add(33.33)));
  return fract(q.x.add(q.y).mul(q.z));
});

// smooth value noise: the "blur" in the blurry hint
const winNoise = /*@__PURE__*/ Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  f.assign(f.mul(f).mul(f.mul(-2.0).add(3.0)));
  return mix(
    mix(winHash2(i), winHash2(i.add(vec2(1, 0))), f.x),
    mix(winHash2(i.add(vec2(0, 1))), winHash2(i.add(vec2(1, 1))), f.x),
    f.y,
  );
});

// soft-edged box, 1 inside, 0 outside
const winSoftBox = /*@__PURE__*/ Fn(([p, halfSize, soft]) => {
  const d = smoothstep(halfSize.add(soft), halfSize.sub(soft), abs(p));
  return d.x.mul(d.y);
});

function cumulativeStyle(d) {
  const v = Math.max(0, d.venetian ?? 0), r = Math.max(0, d.roller ?? 0);
  const c = Math.max(0, d.curtains ?? 0), b = Math.max(0, d.bare ?? 0);
  const sum = v + r + c + b || 1;
  return new THREE.Vector3(v / sum, (v + r) / sum, (v + r + c) / sum);
}

/**
 * Build the window material (MeshStandardNodeMaterial). Extra keys in
 * `options.material` are passed to the material constructor.
 * Live uniforms are exposed on `material.userData.window` (e.g. `.uWinNight.value`).
 */
export function createWindowMaterial(options = {}) {
  const o = { ...WINDOW_DEFAULTS, ...options };
  // a partial `dressing` means "only these": { venetian: 1 } gives venetian blinds everywhere
  if (options.dressing) o.dressing = { venetian: 0, roller: 0, curtains: 0, bare: 0, ...options.dressing };
  const col = (c) => new THREE.Color(c);

  const u = {
    uWinUnit: uniform(o.unitsPerMeter),
    uWinGrid: uniform(new THREE.Vector2(o.grid[0], o.grid[1])),
    uWinDepth: uniform(new THREE.Vector2(o.dressingDepth, o.interiorDepth)),
    uWinTint: uniform(col(o.interiorTint)),
    uWinAmbient: uniform(o.ambient),
    uWinNight: uniform(o.night),
    uWinLitRatio: uniform(o.litRatio),
    uWinWarm: uniform(col(o.warm)),
    uWinCool: uniform(col(o.cool)),
    uWinCoolChance: uniform(o.coolChance),
    uWinLightLevel: uniform(o.lightLevel),
    uWinTransmission: uniform(o.transmission),
    uWinStyle: uniform(cumulativeStyle(o.dressing)),
    uWinSheer: uniform(o.sheerChance),
    uWinDressA: uniform(col(o.dressingColorA)),
    uWinDressB: uniform(col(o.dressingColorB)),
    uWinSlat: uniform(o.slatPitch),
    uWinDropMin: uniform(o.dropMin),
    uWinFrame: uniform(new THREE.Vector4(o.frameWidth, o.mullionWidth, o.panes[0], o.panes[1])),
    uWinFrameColor: uniform(col(o.frameColor)),
    uWinGlassRough: uniform(o.glassRoughness),
    uWinHaze: uniform(o.haze),
    uWinSky: uniform(col(o.skyColor)),
    uWinHorizon: uniform(col(o.horizonColor)),
    uWinGround: uniform(col(o.groundColor)),
    uWinReflect: uniform(o.reflection),
    uWinF0: uniform(o.glassReflectance),
    uWinGrazing: uniform(o.grazingFade),
    uWinSeed: uniform(o.seed),
  };

  if (o.interiorMap) {
    const t = o.interiorMap;
    t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;   // mirrored tiling reads as a room corner
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = true;                            // the blur is a mip bias, so mips are required
    t.minFilter = THREE.LinearMipmapLinearFilter;
    if (t.image) t.needsUpdate = true;                   // a still-loading texture flags itself
    u.uWinMapBlur = uniform(o.interiorMapBlur);
    u.uWinMapSize = uniform(o.interiorMapSize);
  }

  // Written inside the colour slot, read back by the emissive / roughness slots.
  // (The colour slot is evaluated first in the fragment stage.)
  const winEmissive = property('vec3', 'winEmissive');
  const winRough = property('float', 'winRough');

  const hash = (p, s) => {
    const q = fract(p.mul(0.1031).add(s * 0.2137).add(u.uWinSeed.mul(0.0713))).toVar();
    q.addAssign(dot(q, q.zyx.add(31.32)));
    return fract(q.x.add(q.y).mul(q.z));
  };

  // Everything is computed once, in the colour slot.
  const shared = Fn(() => {
    // ---- tangent frame from derivatives (view space, camera at origin) -------
    const P = positionView;
    const dp1 = dFdx(P).toVar(), dp2 = dFdy(P).toVar();
    const guv = (o.coords ?? uv().mul(u.uWinGrid)).toVar();   // continuous; one unit per window (or the caller's coords node)
    const du1 = dFdx(guv).toVar(), du2 = dFdy(guv).toVar();
    const det = du1.x.mul(du2.y).sub(du1.y.mul(du2.x)).toVar();
    const inv = float(1.0).div(select(abs(det).lessThan(1e-12), float(1e-12), det)).toVar();
    const T = dp1.mul(du2.y).sub(dp2.mul(du1.y)).mul(inv).toVar();   // dP/du : length = window width
    const B = dp2.mul(du1.x).sub(dp1.mul(du2.x)).mul(inv).toVar();   // dP/dv : length = window height
    const sizeM = max(vec2(length(T), length(B)), 1e-6).div(u.uWinUnit).toVar();   // metres
    const Tn = normalize(T), Bn = normalize(B);
    const N0 = normalize(cross(dp1, dp2)).toVar();
    const N = select(dot(N0, P).greaterThan(0.0), N0.negate(), N0).toVar();        // face the camera
    const R = normalize(P).toVar();                                                // view ray, into the wall
    const cosV = max(dot(R.negate(), N), 0.0).toVar();
    // lateral shift (metres) per metre of depth; clamped so grazing angles cannot explode
    const slope = vec2(dot(R, Tn), dot(R, Bn)).div(max(cosV, 0.14)).toVar();

    const cell = floor(guv).toVar();
    const cuv = guv.sub(cell).toVar();                        // 0..1 inside this window
    const pm = cuv.sub(0.5).mul(sizeM).toVar();               // metres from window centre, y up
    const px = max(length(dp1), length(dp2)).div(u.uWinUnit).toVar();   // metres per pixel (worst axis)
    const pxX = abs(du1.x).add(abs(du2.x)).mul(sizeM.x).toVar();        // metres per pixel along the window's width

    // per-window seed: quantised world origin of the object (+ instance index, + grid cell)
    const origin = floor(modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz.mul(8.0).add(0.137));
    const inst = floor(varying(float(instanceIndex)).add(0.5));
    let seed = origin.add(vec3(inst.mul(13.0), inst.mul(7.0), inst));
    if (o.idAttribute) seed = vec3(floor(attribute('windowId', 'float').add(0.5)), 17.0, 3.0);
    const id = seed.add(vec3(cell.x.mul(7.0), cell.y.mul(7.0), cell.x.add(cell.y.mul(3.0)))).toVar();

    const h1 = hash(id, 1).toVar(), h2 = hash(id, 2).toVar(), h3 = hash(id, 3).toVar();
    const h4 = hash(id, 4).toVar(), h5 = hash(id, 5).toVar(), h6 = hash(id, 6).toVar();

    // ---- frame + glazing bars (depth 0) --------------------------------------
    const fw = u.uWinFrame.x, mw = u.uWinFrame.y, panes = u.uWinFrame.zw;
    const edge = sizeM.mul(0.5).sub(abs(pm));                 // metres to the opening edge
    const eMin = min(edge.x, edge.y).toVar();
    const paneD = float(0.5).sub(abs(fract(cuv.mul(panes)).sub(0.5))).mul(sizeM).div(panes);
    const frame = float(1.0).sub(smoothstep(fw.sub(px), fw.add(px), eMin)).mul(step(1e-5, fw));
    const bars = float(1.0).sub(smoothstep(mw.mul(0.5).sub(px), mw.mul(0.5).add(px), min(paneD.x, paneD.y))).mul(step(1e-5, mw));
    const frameMask = max(frame, bars).toVar();
    // soft contact shadow the frame/reveal throws onto whatever is behind the glass
    const reveal = mix(0.5, 1.0, smoothstep(0.0, 0.12, eMin.sub(fw))).toVar();

    // ---- dressing plane --------------------------------------------------------
    const pd = pm.add(slope.mul(u.uWinDepth.x)).toVar();      // metres, parallax-shifted
    const qd = pd.div(sizeM).add(0.5).toVar();                // 0..1 across the window
    const fromTop = sizeM.y.mul(0.5).sub(pd.y).toVar();       // metres below the head of the window
    const dressCol = mix(u.uWinDressA, u.uWinDressB, h4).toVar();
    const dressRGB = vec3(0.0).toVar();
    const dressA = float(0.0).toVar();

    const isVen = step(h1, u.uWinStyle.x).toVar();
    const isRol = step(h1, u.uWinStyle.y).mul(isVen.oneMinus()).toVar();
    const isCur = step(h1, u.uWinStyle.z).mul(isVen.oneMinus()).mul(isRol.oneMinus()).toVar();

    // lowered amount: about a third of blinds are fully down
    const drop = mix(u.uWinDropMin, 1.0, smoothstep(0.0, 0.65, h2));
    const dropM = drop.mul(sizeM.y).toVar();
    const covered = float(1.0).sub(smoothstep(dropM.sub(px), dropM.add(px), fromTop)).toVar();

    // venetian: the slat pulse train is box-filtered analytically over the pixel
    // footprint: exact coverage at any distance, so no moire.
    {
      const sy = fromTop.div(u.uWinSlat).toVar();
      const tilt = mix(0.45, 0.96, h3).toVar();               // 1 = fully closed
      const w = max(abs(du1.y).add(abs(du2.y)).mul(sizeM.y).div(u.uWinSlat), 1e-4).toVar();   // slats per pixel
      // filter two pixels wide: at 2 px per slat that spans exactly one period, which
      // nulls the pattern right where it would start to beat against the pixel grid
      const a0 = sy.sub(w).toVar(), a1 = sy.add(w).toVar();
      const f0 = min(fract(a0), tilt).toVar(), f1 = min(fract(a1), tilt).toVar();
      const n = floor(a1).sub(floor(a0)).mul(tilt).toVar();
      const flat = smoothstep(0.4, 0.8, w).toVar();                                            // beyond that: plain average
      const cov = mix(clamp(n.add(f1).sub(f0).div(w.mul(2.0)), 0.0, 1.0), tilt, flat).toVar();  // slat coverage
      // same integral weighted by the slat shading (lit top 1.0 -> shadowed underside 0.62)
      const g1 = f1.sub(f1.mul(f1).mul(0.19).div(tilt)), g0 = f0.sub(f0.mul(f0).mul(0.19).div(tilt));
      const lum = n.mul(0.81).add(g1).sub(g0).div(w.mul(2.0));
      const shade = mix(clamp(lum.div(max(cov, 1e-3)), 0.55, 1.0), 0.81, flat);
      const rail = float(1.0).sub(smoothstep(px.negate().add(0.022), px.add(0.022), abs(fromTop.sub(dropM).add(0.011))))
        .mul(clamp(float(0.05).div(px), 0.0, 1.0)).toVar();
      const a = max(cov.mul(covered), rail);
      const c = dressCol.mul(mix(shade, 0.9, rail));
      dressRGB.assign(mix(dressRGB, c, isVen)); dressA.assign(mix(dressA, a, isVen));
    }
    // roller blind: plain fabric with a hem bar
    {
      const hem = float(1.0).sub(smoothstep(px.negate().add(0.03), px.add(0.03), abs(fromTop.sub(dropM).add(0.015))));
      const wav = winNoise(pd.mul(vec2(3.0, 0.7)).add(h5.mul(40.0))).mul(0.06).add(0.94);
      const c = dressCol.mul(mix(wav, 0.78, hem.mul(covered)));
      dressRGB.assign(mix(dressRGB, c, isRol)); dressA.assign(mix(dressA, covered.mul(0.96), isRol));
    }
    // curtains: two panels drawn back from the centre, vertical folds
    {
      const open = mix(0.12, 0.85, h2).toVar();               // 0 = closed, 1 = fully open
      const xc = abs(qd.x.sub(0.5)).mul(2.0);                 // 0 centre .. 1 jamb
      const waist = sin(clamp(qd.y, 0.0, 1.0).mul(3.14159)).mul(0.10).mul(open);   // tie-back
      const edgeX = open.sub(waist).add(sin(pd.y.mul(9.0).add(h5.mul(TAU))).mul(0.012));
      const edgeM = xc.sub(edgeX).mul(sizeM.x).mul(0.5).toVar();   // metres past the curtain edge
      const a = smoothstep(px.negate(), px, edgeM);
      const foldW = mix(0.11, 0.06, open).toVar();            // tighter folds when bunched up
      const ph = pd.x.div(foldW).add(winNoise(vec2(pd.x.mul(3.0), h5.mul(20.0))).mul(2.0));
      const fold = sin(ph.mul(TAU)).mul(0.5).add(0.5);
      const lod = smoothstep(0.1, 0.33, pxX.div(foldW));     // folds gone before they hit 2 px
      const shade = mix(mix(0.58, 1.0, fold), 0.8, lod).mul(mix(0.8, 1.0, smoothstep(0.0, 0.05, edgeM)));
      dressRGB.assign(mix(dressRGB, dressCol.mul(shade), isCur)); dressA.assign(mix(dressA, a, isCur));
    }
    // net curtain, only behind curtains or bare glass (net + slats reads as plaid)
    {
      const on = step(h6, u.uWinSheer).mul(isVen.oneMinus()).mul(isRol.oneMinus());
      const ph = pd.x.div(0.07).add(winNoise(vec2(pd.x.mul(4.0), h4.mul(30.0))).mul(1.5));
      const lod = smoothstep(0.1, 0.33, pxX.div(0.07));
      const fold = mix(sin(ph.mul(TAU)).mul(0.5).add(0.5), 0.5, lod).toVar();
      const c = vec3(0.93, 0.93, 0.91).mul(mix(0.78, 1.0, fold));
      const a = mix(0.5, 0.68, fold).mul(on);
      dressRGB.assign(mix(c, dressRGB, dressA));              // main dressing sits in front of the net
      dressA.assign(max(dressA, a));
    }

    // ---- interior hint: two blurry planes ----------------------------------------
    const pb = pm.add(slope.mul(u.uWinDepth.y)).toVar();              // back wall
    const pmid = pm.add(slope.mul(u.uWinDepth.y).mul(0.38)).toVar();  // furniture-ish silhouettes
    const off = vec2(hash(id, 11), hash(id, 12)).mul(37.0).toVar();

    const tone = winNoise(pb.mul(0.75).add(off)).mul(0.34).add(0.42)
      .add(winNoise(pb.mul(1.9).add(off.yx)).mul(0.16)).toVar();
    tone.mulAssign(mix(0.62, 1.0, smoothstep(-1.3, 0.3, pb.y)));      // darker towards the floor
    const rc = vec2(hash(id, 13), hash(id, 14)).sub(0.5).mul(vec2(1.8, 0.5));
    const rs = mix(vec2(0.22, 0.38), vec2(0.5, 0.75), hash(id, 15));
    const patchTone = mix(-0.32, 0.7, step(0.45, hash(id, 16)));      // doorway vs far window
    tone.addAssign(winSoftBox(pb.sub(rc), rs, float(0.22)).mul(patchTone));
    const hint = u.uWinTint.mul(max(tone, 0.02)).toVar();
    hint.mulAssign(mix(vec3(1.0), vec3(1.08, 0.98, 0.9), winNoise(pb.mul(0.5).add(off).add(9.0))));
    // no two rooms alike: brightness and a slight warm/cool cast per window
    hint.mulAssign(mix(0.5, 1.2, hash(id, 18)));
    hint.mulAssign(mix(vec3(1.06, 1.0, 0.92), vec3(0.92, 0.98, 1.08), hash(id, 19)));
    if (o.interiorMap) {
      const muv = pb.div(u.uWinMapSize).add(0.5).add(off.mul(0.37));
      hint.assign(texture(o.interiorMap, muv).bias(u.uWinMapBlur).rgb.mul(u.uWinTint).mul(1.6));
    }

    // mid plane: dark masses rising from below
    const ridge = winNoise(vec2(pmid.x.mul(1.1).add(off.x), off.y)).sub(0.5).mul(0.55).sub(0.25)
      .add(winNoise(vec2(pmid.x.mul(2.7).add(off.y), 3.0)).sub(0.5).mul(0.25)).toVar();
    const mass = smoothstep(ridge.add(0.22), ridge.sub(0.22), pmid.y.add(float(0.5).sub(hash(id, 17)).mul(0.6)));
    hint.mulAssign(mix(1.0, 0.32, mass));

    // ---- room light ----------------------------------------------------------------
    const lit = step(hash(id, 21), u.uWinLitRatio).toVar();
    const lamp = mix(u.uWinWarm, u.uWinCool, step(u.uWinCoolChance.oneMinus(), hash(id, 22)));
    const bright = mix(0.55, 1.0, hash(id, 23));
    const ambientL = vec3(u.uWinAmbient).mul(u.uWinNight.mul(0.9).oneMinus()).toVar();         // daylight that got in
    const lampL = lamp.mul(u.uWinLightLevel.mul(bright).mul(lit).mul(u.uWinNight)).toVar();    // the room's own lights
    const roomLight = ambientL.add(lampL).toVar();
    const lc = vec2(hash(id, 24), hash(id, 25)).sub(0.5).mul(vec2(1.4, 0.7)).add(vec2(0.0, 0.1));
    const dl = pmid.sub(lc).toVar();
    const glow = exp(dot(dl, dl).div(-0.18));
    const room = hint.mul(roomLight).mul(glow.mul(2.2).mul(lit).mul(u.uWinNight).add(1.0));

    // ---- composite --------------------------------------------------------------------
    // Fabric scatters: behind dressing you get the room's average light, not its detail.
    // Daylight bouncing back out is as dark as the room; lamp light reaches the fabric
    // directly, so a lit room makes closed blinds glow whatever colour the room is.
    const scattered = dressCol.mul(u.uWinTransmission).mul(u.uWinTint.mul(0.55).mul(ambientL).add(lampL.mul(0.45)));
    const through = mix(room, scattered, dressA).toVar();

    const fres = pow(cosV.oneMinus(), 5.0).toVar();
    const F = u.uWinF0.add(u.uWinF0.oneMinus().mul(fres));
    through.mulAssign(u.uWinGrazing.mul(smoothstep(0.02, 0.55, fres)).oneMinus());

    const reflW = cameraWorldMatrix.mul(vec4(reflect(R, N), 0.0)).xyz.toVar();    // view -> world
    const skyRef = mix(u.uWinGround,
      mix(u.uWinHorizon, u.uWinSky, smoothstep(0.03, 0.42, reflW.y)),
      smoothstep(-0.1, 0.03, reflW.y));
    const reflection = skyRef.mul(F).mul(u.uWinReflect).mul(u.uWinNight.mul(0.92).oneMinus());

    const glassBase = vec3(0.012).add(vec3(0.55, 0.57, 0.58).mul(u.uWinHaze).mul(0.5));
    const diffuse = mix(glassBase, dressRGB, dressA.mul(u.uWinHaze.mul(0.5).oneMinus())).mul(reveal);
    const emissive = through.mul(reveal).mul(u.uWinHaze.mul(0.6).oneMinus()).add(reflection);
    const rough = mix(u.uWinGlassRough, 0.3, u.uWinHaze);

    winEmissive.assign(emissive.mul(frameMask.oneMinus()));
    winRough.assign(mix(rough, 0.55, frameMask));
    return vec4(mix(diffuse, u.uWinFrameColor, frameMask), 1.0);
  });

  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0, ...(o.material || {}) });
  material.colorNode = shared();          // evaluated first in the fragment stage
  material.roughnessNode = winRough;
  material.emissiveNode = winEmissive;
  material.userData.window = u;
  return material;
}

/** 0 = day, 1 = night. Optional overrides: { litRatio, lightLevel, ambient }. */
export function setWindowNight(material, night, overrides = {}) {
  const u = material.userData.window;
  u.uWinNight.value = THREE.MathUtils.clamp(night, 0, 1);
  if (overrides.litRatio !== undefined) u.uWinLitRatio.value = overrides.litRatio;
  if (overrides.lightLevel !== undefined) u.uWinLightLevel.value = overrides.lightLevel;
  if (overrides.ambient !== undefined) u.uWinAmbient.value = overrides.ambient;
}
