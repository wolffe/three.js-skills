// planar-reflection.js - a planar mirror about a horizontal plane y = planeY for THREE.WebGPURenderer:
// one extra render from the reflected camera with an oblique near-plane clip (three's Reflector maths),
// into a HalfFloat target. For lakes, ice, wet floors, and one-layer captures (a "puddle mirror" of a
// single layer over a transparent clear: target alpha = the reflected objects' mask).
// The surface samples it projectively: planarReflectionSample() below, or your own textureMatrix lookup.
// Call render() top-level each frame, before the scene render that samples it.

import * as THREE from 'three/webgpu';
import { uniform, texture, positionWorld, vec2, vec4 } from 'three/tsl';

export const PLANAR_REFLECTION_DEFAULTS = {
  size: 512,                     // target width and height (px); square is fine, the lookup is projective
  type: THREE.HalfFloatType,     // keep HalfFloat: same attachment shape as a HalfFloat frame buffer and the
                                 // reflector() targets, so they share one render context (no extra codegen)
};

export class PlanarReflection {
  constructor(renderer, options = {}) {
    const o = { ...PLANAR_REFLECTION_DEFAULTS, ...options };
    this.renderer = renderer;
    this.rt = new THREE.RenderTarget(o.size, o.size, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: o.type });
    this.camera = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4(); // world -> [0,1]^2 of rt (projective; divide by w)
    this.planeY = 0;
    this._plane = new THREE.Plane();
    this._clip = new THREE.Vector4();
    this._q = new THREE.Vector4();
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._n = new THREE.Vector3(0, 1, 0);
  }

  /** Render `scene` mirrored about y = planeY. hide: objects switched off for this pass (the mirror
   *  surface itself, anything that samples rt, particles). layer: render ONLY that layer (lights are
   *  layer-tested too: enable it on them) over a transparent clear; null = layer 0 with the background. */
  render(scene, camera, planeY, hide = [], layer = null) {
    const cam = this.camera;
    this.planeY = planeY;
    cam.layers.set(layer ?? 0);
    camera.updateMatrixWorld();
    // Reflect position, look target and up (a proper rotation; the mirroring lives in the lookup).
    this._view.copy(camera.position);
    this._view.y = 2 * planeY - this._view.y;
    this._look.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this._target.copy(camera.position).add(this._look);
    this._target.y = 2 * planeY - this._target.y;
    cam.position.copy(this._view);
    cam.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    cam.up.y = -cam.up.y;
    cam.lookAt(this._target);
    cam.near = camera.near;
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);

    // Y row negated: TSL samples render targets with v = 0 at NDC y = +1.
    this.textureMatrix.set(
      0.5, 0, 0, 0.5,
      0, -0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    );
    this.textureMatrix.multiply(cam.projectionMatrix);
    this.textureMatrix.multiply(cam.matrixWorldInverse);

    // Oblique near plane at the mirror plane: everything below it is cut.
    this._plane.set(this._n, -planeY);
    this._plane.applyMatrix4(cam.matrixWorldInverse);
    this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const e = cam.projectionMatrix.elements, q = this._q;
    q.x = (Math.sign(this._clip.x) + e[8]) / e[0];
    q.y = (Math.sign(this._clip.y) + e[9]) / e[5];
    q.z = -1.0;
    q.w = (1.0 + e[10]) / e[14];
    // WebGPU z row (NDC z in [0,1]): just the scaled clip plane. The GL variant (+1 on z) skews the clip.
    this._clip.multiplyScalar(1.0 / this._clip.dot(q));
    e[2] = this._clip.x; e[6] = this._clip.y; e[10] = this._clip.z; e[14] = this._clip.w;

    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const hidden = [];
    for (const m of hide) if (m.visible) { m.visible = false; hidden.push(m); }
    // Layer capture: drop scene.background (a colour background forces clear alpha 1).
    let prevAlpha = 1, prevBackground = null;
    if (layer !== null) { prevAlpha = r.getClearAlpha(); r.setClearAlpha(0); prevBackground = scene.background; scene.background = null; }
    r.setRenderTarget(this.rt);
    r.render(scene, cam);
    r.setRenderTarget(prevTarget);
    if (layer !== null) { r.setClearAlpha(prevAlpha); scene.background = prevBackground; }
    for (const m of hidden) m.visible = true;
  }

  dispose() { this.rt.dispose(); }
}

/** TSL lookup of a PlanarReflection for the receiving material: { color (vec4), uv, matrix }.
 *  offset: optional vec2 node (normal.xz x strength) to ripple the reflection. The matrix uniform holds
 *  a reference to reflection.textureMatrix, so render() updates it with no copy. */
export function planarReflectionSample(reflection, offset = null) {
  const matrix = uniform(reflection.textureMatrix);
  const clip = matrix.mul(vec4(positionWorld, 1.0));
  let uv = clip.xy.div(clip.w);
  if (offset) uv = uv.add(offset);
  uv = uv.clamp(vec2(0.001), vec2(0.999));
  return { color: texture(reflection.rt.texture, uv), uv, matrix };
}
