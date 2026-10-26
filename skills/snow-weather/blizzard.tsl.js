// blizzard.tsl.js — GPU compute snowfall for THREE.WebGPURenderer (TSL), calm drift to whiteout.
//
// One compute pass over storage buffers + one instanced sprite draw. Flakes live in a square box
// (half-width `radius`) around the camera's ground point and WRAP toroidally in x/z, so the field
// follows the camera with no respawn band. Each flake chases a target velocity (wind x shear x gust
// fronts + fall + two-octave turbulence) plus a per-flake swing; dies by age or leaving the slab
// and is reborn in the volume. Opacity = `envelope` (caller) max'd with the built-in squall clock and
// ash; density (live fraction of the drawn prefix) is a separate rebirth gate, so density changes
// take hold per lifecycle (2.5-9 s) with no pops.
//
// ANCHORING: every position-derived trig argument is camera-RELATIVE (pos - center) and the clock
// resets on activation; buffers stay world space. Far from the origin, absolute positions in sin()
// jitter.
//
// Usage:
//   import { SnowField } from './blizzard.tsl.js';
//   const snow = new SnowField(renderer, scene, { groundAt: (x, z) => terrainHeight(x, z) });
//   await snow.init(camera);                              // warms both compute pipelines
//   snow.update(dt, camera, spells.snowFieldInput(snow.count));   // per frame (weather-spells.js)
//
// Written against three r186.1; if an import fails, check `three/tsl` in the installed version.

import * as THREE from 'three/webgpu';
import {
  Fn, instanceIndex, uint, float, vec2, vec3, uniform, hash, uv, mix, min, max, step, fract, floor,
  smoothstep, sin, cos, exp, abs, sub, instancedArray, positionView, viewportDepthTexture,
  perspectiveDepthToViewZ, cameraNear, cameraFar,
} from 'three/tsl';

// ---------------------------------------------------------------- soft particles
// Alpha fades over the last `distance` m in front of the opaque scene (NVIDIA curve, contrast 2).
// ONE shared viewportDepthTexture node = one depth copy per frame however many systems use it.
// Pass the particle's REAL view z: for a SpriteNodeMaterial with positionNode, positionView.z is
// real; for quads placed by a custom vertexNode from an offset attribute, positionView is the zero
// position stub (fades everything out) - pass modelViewMatrix x offset .z instead. `name` names
// the varying; give each system its own.
const sceneDepth = /*@__PURE__*/ viewportDepthTexture();
export const softParticlesOn = /*@__PURE__*/ uniform(1); // 1 soft, 0 hard (A/B at runtime)
export const softAlphaAt = (alpha, distance, viewZ, name) => {
  const sceneViewZ = perspectiveDepthToViewZ(sceneDepth, cameraNear, cameraFar);
  const t = viewZ.toVarying(name).sub(sceneViewZ).div(distance).saturate().toVar(); // 0 at the scene, 1 a full distance in front
  const lo = t.mul(t).mul(2.0), hi = sub(1.0, sub(1.0, t).mul(sub(1.0, t)).mul(2.0));
  return mix(alpha, alpha.mul(mix(lo, hi, step(0.5, t))), softParticlesOn);
};

export const SNOW_DEFAULTS = {
  // --- field ---------------------------------------------------------------
  capacity: 64_000,          // buffer size (7 x capacity x 4-16 B; 64k ~ 2.8 MB); the storm mode asks for 64k
  count: 64_000,             // drawn prefix = dispatch size; paid in full whatever the density
  radius: 80,                // half-width of the wrapped box around the camera, m
  ceiling: 18,               // slab height above the camera's ground point, m
  killBelow: 30,             // flakes this far under the ground point are reborn
  groundAt: null,            // (x, z) => ground y under the camera; null = 0
  teleport: 150,             // camera jump (m) that reseeds the field
  // --- look ------------------------------------------------------------------
  size: 0.8,                 // flake size multiplier (base 0.018-0.118 m)
  colorSlow: 0xccdbf7,       // slow flakes: off-white, faintly cool; not blue
  colorFast: 0xffffff,       // fast flakes whiten
  ashColor: 0x2b2624,        // the ash variant: dark grey flakes
  lightFloor: 0.34,          // flakes never darker than this x colour (night still reads)
  ashLightFloor: 0.5,
  softDistance: 0.15,        // soft fade before the ground, m
  hideBelow: 0.03,           // envelope under this: mesh hidden, no compute, no draw
  renderOrder: 2,
  // --- camera bubble (cabin / helmet views) ------------------------------------
  bubbleInner: 0.9,          // flakes gone inside this radius of the camera, m
  bubbleOuter: 1.4,          // full opacity past this
  // --- exclusion boxes (vehicles, shelters) ------------------------------------
  maxBoxes: 4,
  // --- squall clock (built-in whiteouts) -------------------------------------
  squalls: true,
  squallWind: 12,            // m/s a squall blows at (raised to, never lowered from, the ambient)
  squallFirst: [45, 135],    // s until the first squall
  squallLength: [15, 20],    // s of whiteout
  squallLull: [60, 180],     // s between squalls
  squallMinWinter: 0.55,     // no squall below this winter (above the rain/snow crossfade)
  squallIn: 0.7,             // ease rates (1/s): ~3 s to blow in
  squallOut: 0.45,           //                   ~5 s to die away
};

const pick = ([a, b]) => a + Math.random() * (b - a);
// Per-flake randoms from a seed that advances on every rebirth.
const rand = (s, k) => fract(sin(s.mul(127.1 + k * 21.37).add(k * 7.31 + 1.7)).mul(43758.5453));

export class SnowField {
  constructor(renderer, scene, options = {}) {
    const o = this.options = { ...SNOW_DEFAULTS, ...options };
    const CAP = o.capacity, R = o.radius, CEIL = o.ceiling;
    this._renderer = renderer;
    this._scene = scene;
    this.count = Math.min(o.count, CAP);
    this._elapsed = 0;
    this._last = new THREE.Vector3(1e9, 0, 0);
    this._env = 0;                                  // eased squall envelope
    this._squall = 0;                               // s of squall remaining
    this._lull = pick(o.squallFirst);
    this._lastGust = null;
    this.envelope = 0;                              // readout: the opacity actually used
    this._fronts = [{ x: -R, v: 16, w: 8, g: 0.9 }, { x: 0, v: 25, w: 4.2, g: 0.7 }];

    const u = this._u = {
      delta: uniform(1 / 60), time: uniform(0),
      dirX: uniform(1), dirZ: uniform(0), speed: uniform(2),
      pulse: uniform(1),
      frontA: uniform(-R), widthA: uniform(7), gainA: uniform(1),
      frontB: uniform(0), widthB: uniform(4), gainB: uniform(1),
      center: uniform(new THREE.Vector3()),         // camera x/z at ground height
      camPos: uniform(new THREE.Vector3()),
      bubble: uniform(0),
      env: uniform(0), density: uniform(1), fall: uniform(3), turb: uniform(0.1),
      hbias: uniform(0),                            // birth height: 0 even fill, 1 ground-hugging
      light: uniform(new THREE.Color(1, 1, 1)),
      ash: uniform(0), size: uniform(o.size),
    };
    this._boxes = [];
    for (let i = 0; i < o.maxBoxes; i++) {
      this._boxes.push({
        pos: uniform(new THREE.Vector3(0, -1e5, 0)),
        fwd: uniform(new THREE.Vector2(0, 1)),
        half: uniform(new THREE.Vector3(1, 1, 1)),  // (along forward, up, sideways)
      });
    }

    const posBuf = instancedArray(CAP, 'vec3');
    const velBuf = instancedArray(CAP, 'vec3');
    const seedBuf = instancedArray(CAP, 'float');
    const ageBuf = instancedArray(CAP, 'float');
    const lifeBuf = instancedArray(CAP, 'float');
    const sizeBuf = instancedArray(CAP, 'float');
    const alphaBuf = instancedArray(CAP, 'float');

    // Birth, emitted inline: take 1 = reborn this step; fill 1 = initial fill (scatter ages).
    const emitBirth = (take, seed, dir, fill) => {
      const p = posBuf.element(instanceIndex), v = velBuf.element(instanceIndex);
      const s = seedBuf.element(instanceIndex), g = ageBuf.element(instanceIndex);
      const l = lifeBuf.element(instanceIndex), z = sizeBuf.element(instanceIndex);
      const ns = fract(seed.add(0.7548776662)); // golden-ratio advance
      const r0 = rand(ns, 0), r2 = rand(ns, 2), r3 = rand(ns, 3), r4 = rand(ns, 4), r5 = rand(ns, 5);
      const height = mix(r2, r2.mul(r2), u.hbias).mul(CEIL).add(0.3);
      const where = vec3(r0.sub(0.5).mul(2 * R), height, r3.sub(0.5).mul(2 * R)).add(u.center);
      const vis = step(rand(ns, 9), u.density); // a losing roll parks this life at size 0
      p.assign(mix(p, where, take));
      v.assign(mix(v, dir.mul(u.speed.mul(r5.mul(0.5).add(0.4))), take));
      s.assign(mix(s, ns, take));
      l.assign(mix(l, r3.mul(6.5).add(2.5), take));
      z.assign(mix(z, r4.mul(r4).mul(0.10).add(0.018).mul(vis), take));
      g.assign(mix(g, mix(float(0), r5.mul(l), fill), take));
    };

    this._initPass = Fn(() => {
      const seed = hash(instanceIndex.add(uint(9127)));
      seedBuf.element(instanceIndex).assign(seed);
      alphaBuf.element(instanceIndex).assign(float(0));
      emitBirth(float(1), seed, vec3(u.dirX, 0, u.dirZ), float(1));
    })().compute(CAP);

    this._updatePass = Fn(() => {
      const p = posBuf.element(instanceIndex), v = velBuf.element(instanceIndex);
      const s = seedBuf.element(instanceIndex), g = ageBuf.element(instanceIndex);
      const l = lifeBuf.element(instanceIndex), a = alphaBuf.element(instanceIndex);
      const dt = u.delta, t = u.time;
      const dir = vec3(u.dirX, 0, u.dirZ);
      const perp = vec3(u.dirZ.negate(), 0, u.dirX);
      const rel = p.sub(u.center).toVar();
      const c0 = rand(s, 6), c1 = rand(s, 7), c2 = rand(s, 8);

      // Gust fronts: two Gaussian bands sweeping downwind through the field.
      const proj = rel.x.mul(u.dirX).add(rel.z.mul(u.dirZ));
      const qa = proj.sub(u.frontA).div(u.widthA), qb = proj.sub(u.frontB).div(u.widthB);
      const gust = exp(qa.mul(qa).negate()).mul(u.gainA).add(exp(qb.mul(qb).negate()).mul(u.gainB)).mul(u.pulse);

      // Turbulence: two octaves of folded trig drifting through the field.
      const q1 = rel.mul(0.34).add(vec3(t.mul(0.62), t.mul(0.24), t.mul(-0.44)));
      const o1 = vec3(sin(q1.z.mul(1.1).add(cos(q1.y.mul(0.9)))), sin(q1.x.mul(0.8).add(cos(q1.z.mul(1.3)))), sin(q1.y.mul(1.2).add(cos(q1.x.mul(0.7)))));
      const q2 = rel.mul(0.97).add(vec3(t.mul(-1.15), t.mul(0.83), t.mul(0.61)));
      const o2 = vec3(sin(q2.z.add(cos(q2.y.mul(1.4)))), sin(q2.x.add(cos(q2.z.mul(0.8)))), sin(q2.y.add(cos(q2.x.mul(1.1)))));
      const turb = o1.add(o2.mul(0.5));

      // Target velocity: faster aloft (shear), gusts carry harder; fall = descent speed.
      const shear = rel.y.mul(0.055).add(0.62);
      const carry = u.speed.mul(shear).mul(gust.mul(1.7).add(0.7)).mul(c2.mul(0.45).add(0.78));
      const target = dir.mul(carry).add(vec3(0, c2.mul(0.8).add(0.6).mul(u.fall).negate(), 0))
        .add(turb.mul(gust.mul(4.2).add(1.5)).mul(u.turb));

      // Per-flake chase rate spread: the main source of the chaotic look.
      let vel = v.add(target.sub(v).mul(min(dt.mul(c1.mul(3.4).add(1.1)), float(1))));
      // Swing: fine per-flake tumble so no two neighbours track together.
      const ph = c0.mul(6.2832), fr = c1.mul(3.0).add(1.4);
      vel = vel.add(perp.mul(sin(t.mul(fr).add(ph)).mul(1.9))
        .add(vec3(0, cos(t.mul(fr.mul(0.61)).add(ph.mul(2.3))).mul(0.9), 0))
        .mul(gust.mul(0.9).add(0.35)).mul(u.turb.mul(0.7).add(0.3)).mul(dt));

      // Toroidal wrap in x/z: the field follows the camera; no ground clamp (wrong on slopes).
      const nrel = p.add(vel.mul(dt)).sub(u.center);
      const span = float(2 * R);
      const wxz = vec2(nrel.x, nrel.z);
      const wrapped = wxz.sub(floor(wxz.add(R).div(span)).mul(span));
      const age = g.add(dt);
      const dead = max(step(l, age), max(step(float(CEIL + 8), nrel.y), step(float(o.killBelow), nrel.y.negate())));
      const alpha = smoothstep(float(0), l.mul(0.10), age).mul(float(1).sub(smoothstep(l.mul(0.80), l, age))).mul(float(1).sub(dead));

      v.assign(vel);
      p.assign(vec3(wrapped.x, nrel.y, wrapped.y).add(u.center));
      g.assign(age);
      a.assign(alpha);
      emitBirth(dead, s, dir, float(0));
    })().compute(CAP);

    // ---- sprite material
    const pos = posBuf.toAttribute();
    const alphaAttr = alphaBuf.toAttribute();
    const speed = velBuf.toAttribute().length();
    const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    mat.positionNode = pos;
    mat.scaleNode = sizeBuf.toAttribute().mul(alphaAttr.mul(0.35).add(0.65)).mul(u.size);
    const snow = mix(uniform(new THREE.Color(o.colorSlow)), uniform(new THREE.Color(o.colorFast)), smoothstep(float(2), float(20), speed))
      .mul(max(u.light, vec3(o.lightFloor)));
    mat.colorNode = mix(snow, uniform(new THREE.Color(o.ashColor)).mul(max(u.light, vec3(o.ashLightFloor))), u.ash);
    const disc = float(1).sub(smoothstep(float(0.10), float(0.5), uv().sub(0.5).length()));
    const bubble = mix(float(1), smoothstep(o.bubbleInner, o.bubbleOuter, pos.sub(u.camPos).length()), u.bubble);
    let mask = disc.mul(alphaAttr).mul(u.env).mul(bubble).mul(0.9);
    for (const b of this._boxes) {
      const r = pos.sub(b.pos);
      const lon = r.x.mul(b.fwd.x).add(r.z.mul(b.fwd.y));
      const lat = r.x.mul(b.fwd.y).sub(r.z.mul(b.fwd.x));
      const q = max(max(abs(lon).div(b.half.x), abs(lat).div(b.half.z)), abs(r.y).div(b.half.y));
      mask = mask.mul(smoothstep(0.85, 1.05, q));
    }
    this.uSoft = uniform(o.softDistance);
    mat.opacityNode = softAlphaAt(mask, this.uSoft, positionView.z, 'vSoftZFlake');

    this.material = mat;
    this.mesh = new THREE.Sprite(mat);
    this.mesh.name = 'snow-field';
    this.mesh.count = this.count;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Boot warm-up of both compute pipelines. Warm the sprite pipeline too (compileAsync with the mesh visible). */
  async init(camera) {
    this._center(camera);
    await this._renderer.computeAsync(this._initPass);
    this._u.delta.value = 0;
    await this._renderer.computeAsync(this._updatePass);
  }

  /** Squall envelope 0..1. Fold it into the sky's overcast: never a whiteout under a blue sky. */
  get whiteout() { return this._env; }

  /** Start a squall now. */
  triggerSquall() { this._lull = 0; this._squall = 0; }

  /** Drive one hard gust front through the field now. */
  slam() {
    const f = this._fronts[1];
    f.x = -this.options.radius; f.v = 34; f.w = 7.5; f.g = 1.9;
    this._u.pulse.value = 2.4;
  }

  /**
   * input: {
   *   envelope 0..1  spell opacity (WeatherSpells: min(1, snowing x 2.2) x snowShare)
   *   drive  { density 0..1, fall m/s, turbulence 0..1 }
   *   wind   { speed m/s, dir rad (world heading, x = cos, z = sin), gustAmp m/s }
   *   gust   ground gust object { strength } or null; a new object launches a front
   *   ash 0..1, winter 0..1 (gates squalls)
   * }
   */
  update(dt, camera, input = {}) {
    const o = this.options, d = Math.min(dt, 1 / 30);
    const winter = input.winter ?? 1, ash = input.ash ?? 0;
    if (o.squalls) {
      if (this._squall > 0) {
        this._squall -= d;
        if (this._squall <= 0) this._lull = pick(o.squallLull);
      } else if ((this._lull -= d) <= 0) {
        if (winter >= o.squallMinWinter) this._squall = pick(o.squallLength);
        else this._lull = pick(o.squallLull) * 0.5; // off-season: re-roll sooner
      }
    }
    const on = this._squall > 0;
    this._env += ((on ? winter : 0) - this._env) * (1 - Math.exp(-d * (on ? o.squallIn : o.squallOut)));
    const env = this.envelope = Math.max(this._env, input.envelope ?? 0, ash * 0.9);
    this._u.env.value = env;
    if (env <= o.hideBelow) { this.mesh.visible = false; return; } // the invisible tail still costs compute + draw

    this._center(camera);
    const jumped = camera.position.distanceTo(this._last) > o.teleport;
    this._last.copy(camera.position);
    if (!this.mesh.visible || jumped) {
      this.mesh.visible = true;
      this._elapsed = 0;                            // small trig arguments
      this._drive(input, 0);
      this._renderer.compute(this._initPass, this.count);
    }
    this._elapsed += d;
    this._drive(input, d);
    this._renderer.compute(this._updatePass, this.count); // the drawn prefix only
  }

  _drive(input, d) {
    const u = this._u, o = this.options, sq = this._env, el = this._elapsed;
    const wind = input.wind ?? {}, drive = input.drive ?? {}, ash = input.ash ?? 0;
    const a = (wind.dir ?? 0) + Math.sin(el * 0.23) * 0.45 + Math.sin(el * 0.61) * 0.17; // heading wobble
    u.dirX.value = Math.cos(a); u.dirZ.value = Math.sin(a);
    const ambient = (wind.speed ?? 0) + Math.sin(el * 0.5) * (wind.gustAmp ?? 0);
    const squallWind = o.squallWind + Math.sin(el * 0.17) * 2.5;
    const speed = ambient + (Math.max(ambient, squallWind) - ambient) * sq;
    u.speed.value = speed;
    u.hbias.value = Math.max(sq, Math.min(1, Math.max(0, (speed - 2) / 8)) * 0.5); // windy: births hug the ground
    let fall = drive.fall ?? 3;
    fall += (1.0 - fall) * sq;                      // squall flakes float on the wind
    fall += (2.2 - fall) * ash;                     // ash drifts down slowly
    u.fall.value = fall;
    u.ash.value = ash;
    const turb = drive.turbulence ?? 0.1;
    u.turb.value = turb + (1 - turb) * sq;
    // Density LEADS the envelope (births lag a lifetime): the squall CLOCK opens it, not the eased envelope.
    u.density.value = Math.max(drive.density ?? 1, this._squall > 0 ? 1 : 0, ash * 0.55);
    if (input.gust !== this._lastGust) {
      this._lastGust = input.gust;
      if (input.gust) {
        const f = this._fronts[1];
        f.x = -o.radius; f.v = 10 + input.gust.strength * 1.4;
        f.w = 5 + Math.random() * 3; f.g = Math.min(1.4, 0.4 + input.gust.strength * 0.06);
      }
    }
    for (const f of this._fronts) {
      f.x += f.v * d;
      if (f.x > o.radius) { f.x = -o.radius; f.v = 13 + Math.random() * 18; f.w = 3 + Math.random() * 6.5; f.g = 0.5 + Math.random() * 0.9; }
    }
    const [A, B] = this._fronts;
    u.frontA.value = A.x; u.widthA.value = A.w; u.gainA.value = A.g;
    u.frontB.value = B.x; u.widthB.value = B.w; u.gainB.value = B.g;
    u.pulse.value += (1 - u.pulse.value) * Math.min(d * 0.9, 1);
    u.delta.value = d;
    u.time.value = el;
  }

  _center(camera) {
    const c = camera.position, g = this.options.groundAt;
    this._u.center.value.set(c.x, g ? g(c.x, c.z) : 0, c.z);
    this._u.camPos.value.copy(c);
  }

  /** Scene light on the flakes: color x intensity, clamped to 1 (a floor applies in the shader). */
  setLight(color, intensity = 1) {
    this._u.light.value.setRGB(Math.min(1, color.r * intensity), Math.min(1, color.g * intensity), Math.min(1, color.b * intensity));
  }

  /** Camera inside a cabin / helmet: fade flakes within the bubble around the camera. */
  setCameraBubble(on) { this._u.bubble.value = on ? 1 : 0; }

  /** Up to maxBoxes oriented boxes [{ position, forward, size: [length, height, width] }] (full metres,
   *  forward planar). Flakes inside are hidden from ANY camera; call per frame for moving vehicles. */
  setExclusionBoxes(boxes = []) {
    this._boxes.forEach((b, i) => {
      const box = boxes[i];
      if (!box) { b.pos.value.set(0, -1e5, 0); return; }
      b.pos.value.copy(box.position);
      const f = box.forward, l = Math.hypot(f.x, f.z) || 1;
      b.fwd.value.set(f.x / l, f.z / l);
      const s = Array.isArray(box.size) ? box.size : [box.size.x, box.size.y, box.size.z];
      b.half.value.set(s[0] / 2, s[1] / 2, s[2] / 2);
    });
  }

  set size(v) { this._u.size.value = v; }
  get size() { return this._u.size.value; }

  dispose() {
    this._scene.remove(this.mesh);
    this.material.dispose();
    this._initPass.dispose?.();
    this._updatePass.dispose?.();
  }
}
