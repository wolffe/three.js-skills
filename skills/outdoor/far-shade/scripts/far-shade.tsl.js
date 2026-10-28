// far-shade.tsl.js — fake terrain self-shadow + canopy blobs from a toroidal world atlas, for THREE.WebGPURenderer.
//
// Replaces a far shadow cascade. One RGBA8 DataTexture of N x N cells at C m, addressed by world position modulo
// N*C (no origin, no recentring): RG = height (16 bit, heightStep m from heightFloor), B = canopy 0..1,
// A = written flag. Terrain tiles write their heights and canopy discs as they arrive; terrain is static, so a
// stale cell from an old lap still holds true heights, and an unwritten cell (A = 0) never occludes.
// Materials evaluate shadeNode() in the VERTEX stage (8 taps toward the sun + one canopy tap) and multiply the
// varying into the albedo.
//
// Usage:
//   const fs = createFarShade();
//   fs.apply(terrainMaterial);                       // any NodeMaterial; wraps its colorNode
//   onTileReady(({ x, z, heights, trees }) => fs.write({ originX: x, originZ: z, heights, size: 256, cells: 64,
//     canopies: trees.map((t) => ({ x: t.x, z: t.z, r: 3 * t.scale })) }));
//   // every frame, before render:
//   fs.setSun(sunDirection);                         // world-space unit vector TOWARD the sun
//   fs.upload();
//
// Written against three r186.

import * as THREE from 'three/webgpu';
import { Fn, uniform, varying, texture, positionWorld, cameraPosition, materialColor, float, vec4, mix, step,
  max, sub, smoothstep } from 'three/tsl';

export const FAR_SHADE_DEFAULTS = {
  cells: 1024,          // atlas texels per side (RGBA8: 4 MB at 1024)
  cellSize: 4,          // m per texel; world wraps every cells * cellSize m (4096 m)
  heightFloor: -600,    // m, height of q = 0
  heightStep: 0.05,     // m per quantisation step (16 bit: floor .. floor + 3276 m)
  taps: [8, 14, 24, 40, 65, 105, 170, 270], // m along the sun's ground direction
  bias: 1.5,            // m an occluder must clear the rising horizon by before it shades
  soft: 4.0,            // m over which a clearance becomes full shade (smoothstep 0..soft)
  canopyHeight: 7,      // m, typical crown height: the canopy is read canopyHeight / tan(elev) up-sun
  canopyReach: 40,      // m cap on that offset (low sun)
  canopySpread: 2.2,    // disc falloff: value = 1 - d^2 / (r^2 * spread), cut at that radius
  minTan: 0.02,         // floor on tan(elevation) (keeps canopyHeight / tan finite)
  sunFade: [0.02, 0.12],// sin(elevation) range over which the shade fades in after sunrise
  strength: 0.7,        // albedo darkening at full shade
  canopy: 0.8,          // canopy strength relative to hills
  near: [0, 1],         // m from the camera: fade-in band. (0, 1) = everywhere (fake AO under the near cascade too)
};

/**
 * Returns { texture, knobs: { strength, canopy, near, kill, dir, tan, fade }, write, upload, setSun, shadeNode,
 * apply }. knobs are uniforms: set .value.
 */
export function createFarShade(options = {}) {
  const o = { ...FAR_SHADE_DEFAULTS, ...options };
  const N = o.cells, C = o.cellSize, H0 = o.heightFloor, HS = o.heightStep, SPAN = N * C;

  const tex = new THREE.DataTexture(new Uint8Array(N * N * 4), N, N, THREE.RGBAFormat);
  // Linear filtering is exact for the split height: bilinear(R) * 256 + bilinear(G) = bilinear(q).
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // the toroid
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  let dirty = false;

  const knobs = {
    strength: uniform(o.strength),
    canopy: uniform(o.canopy),
    near: uniform(new THREE.Vector2(o.near[0], o.near[1])),
    kill: uniform(1),                         // 0 = off (A/B), costs the same
    dir: uniform(new THREE.Vector2(1, 0)),    // sun's ground direction, unit
    tan: uniform(1),                          // tan(sun elevation)
    fade: uniform(0),                         // 0 at night / below the horizon / overcast
  };

  // Texel i holds world i * C; modulo for negative coordinates.
  const wrap = (i) => ((i % N) + N) % N;
  const texel = (ix, iz) => (wrap(ix) + wrap(iz) * N) * 4;
  const data = tex.image.data;

  /**
   * One terrain tile: heights row-major (z rows, x columns), (cells + 1)^2 samples over a size-m square at
   * (originX, originZ). Resampled bilinearly onto the atlas texels inside the square (exact copy when
   * size / cells === cellSize). canopies: [{ x, z, r, strength = 1 }] in world m, max-blended into B.
   */
  function write({ originX, originZ, heights, size, cells, canopies = [] }) {
    const S = cells + 1, step = size / cells;
    const hAt = (fx, fz) => {
      const x0 = Math.min(cells - 1, Math.floor(fx)), z0 = Math.min(cells - 1, Math.floor(fz));
      const tx = fx - x0, tz = fz - z0, i = z0 * S + x0;
      const a = heights[i] + (heights[i + 1] - heights[i]) * tx;
      const b = heights[i + S] + (heights[i + S + 1] - heights[i + S]) * tx;
      return a + (b - a) * tz;
    };
    const ix0 = Math.ceil(originX / C - 1e-6), ix1 = Math.floor((originX + size) / C + 1e-6);
    const iz0 = Math.ceil(originZ / C - 1e-6), iz1 = Math.floor((originZ + size) / C + 1e-6);
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const fx = Math.max(0, Math.min(cells, (ix * C - originX) / step));
      const fz = Math.max(0, Math.min(cells, (iz * C - originZ) / step));
      const q = Math.max(0, Math.min(65535, Math.round((hAt(fx, fz) - H0) / HS)));
      const k = texel(ix, iz);
      data[k] = q >> 8; data[k + 1] = q & 255; data[k + 2] = 0; data[k + 3] = 255;
    }
    // Canopy discs after the heights (the height pass clears B), so a disc crossing into a neighbour tile
    // survives until that neighbour is (re)written.
    for (const c of canopies) {
      const r2 = c.r * c.r, cut = r2 * o.canopySpread, reach = Math.ceil(Math.sqrt(cut) / C);
      const cx = Math.round(c.x / C), cz = Math.round(c.z / C), s = c.strength ?? 1;
      for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
        const ex = (cx + dx) * C - c.x, ez = (cz + dz) * C - c.z, e2 = ex * ex + ez * ez;
        if (e2 > cut) continue;
        const v = Math.round(255 * s * Math.max(0, 1 - e2 / cut));
        const k = texel(cx + dx, cz + dz);
        if (v > data[k + 2]) data[k + 2] = v;
      }
    }
    dirty = true;
  }

  /** Once per frame: at most one full upload, and none when nothing was written. */
  function upload() {
    if (!dirty) return false;
    tex.needsUpdate = true;
    dirty = false;
    return true;
  }

  /**
   * sunDir: world-space vector toward the sun. fade (optional) overrides the elevation fade, e.g. your shadow
   * intensity (day gate x overcast) so the fake fades exactly with the real shadows.
   */
  const _d = new THREE.Vector3();
  function setSun(sunDir, fade) {
    _d.copy(sunDir).normalize();
    const hl = Math.hypot(_d.x, _d.z) || 1e-6;
    knobs.dir.value.set(_d.x / hl, _d.z / hl);
    knobs.tan.value = Math.max(o.minTan, _d.y / hl);
    if (fade === undefined) {
      const t = Math.max(0, Math.min(1, (_d.y - o.sunFade[0]) / (o.sunFade[1] - o.sunFade[0])));
      fade = t * t * (3 - 2 * t);
    }
    knobs.fade.value = fade;
  }

  // World xz -> uv with texel i's CENTRE at world i * C (the +0.5 texel), wrapping via RepeatWrapping.
  const uvOf = (xz) => xz.div(C).add(0.5).div(N);
  const heightAt = (uvN) => {
    const t = texture(tex, uvN).level(0);
    const h = t.r.mul(255 * 256).add(t.g.mul(255)).mul(HS).add(H0);
    return mix(float(-9999), h, step(0.5, t.a)); // unwritten cells never occlude
  };

  /** 0..1 shade factor (1 = lit) at `position` (default positionWorld). Evaluate in the vertex stage. */
  const shadeAt = Fn(([P]) => {
    const uv0 = uvOf(P.xz);
    const occl = float(-9999).toVar();
    for (const d of o.taps) {
      const h = heightAt(uv0.add(knobs.dir.mul(d / SPAN)));
      // Occluder rises above the sun's ray from P (horizon = P.y + tan * d) by more than the bias.
      occl.assign(max(occl, h.sub(P.y.add(knobs.tan.mul(d)).add(o.bias))));
    }
    const hill = smoothstep(0.0, o.soft, occl);
    // The crown that shades P stands UP-sun of it by crownHeight / tan: read the canopy there (blob lands down-sun).
    const back = float(o.canopyHeight).div(knobs.tan).min(o.canopyReach);
    const can = texture(tex, uv0.add(knobs.dir.mul(back.div(SPAN)))).level(0).b.mul(knobs.canopy);
    const shade = max(hill, can).mul(knobs.fade).mul(knobs.kill);
    const reach = smoothstep(knobs.near.x, knobs.near.y, P.sub(cameraPosition).length());
    return sub(1.0, shade.mul(reach).mul(knobs.strength));
  });

  /** A varying of the shade: computed per vertex, interpolated per pixel. Pass a root position for cards. */
  const shadeNode = (position = positionWorld) => varying(shadeAt(position));

  /** Multiplies the material's colour (colorNode, or color x map) by the shade. Call once, before first render. */
  function apply(material, position) {
    const base = vec4(material.colorNode ?? materialColor); // a vec3 node widens to vec4 with alpha 1 (NodeBuilder.format)
    material.colorNode = vec4(base.rgb.mul(shadeNode(position)), base.a);
    material.needsUpdate = true;
    return material;
  }

  return { texture: tex, knobs, write, upload, setSun, shadeNode, apply, options: o };
}
