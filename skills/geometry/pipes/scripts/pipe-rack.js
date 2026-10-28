/**
 * pipe-rack.js
 * A parametric "Pipe rack" model: a module of parallel pipes along Y (y = 0 to y = length), their
 * centrelines `stand` above the z = 0 plane they are carried from (a floor, a wall, a soffit: the
 * caller turns the module). A flanged joint at y = 0 so modules set end to end join; lagging bands;
 * a valve on the first pipe (a body between flanges, an actuator box with a status lamp); supports
 * down to the plane every 4 m or so (a rack: a beam on two posts with clamps, or a saddle per pipe);
 * an optional end bend of 1.5 diameters' radius out of the plane or across it, with a tail.
 * Three levels of detail through spec.detail ('high' | 'medium' | 'low').
 *
 * Usage:
 *   import { registerModel, createModel } from './procedural-models.js';
 *   import { pipeRack } from './pipe-rack.js';  registerModel(pipeRack);
 *   scene.add(createModel('pipes', { pipes: 3, length: 12, diameter: 0.4 }));
 *
 * It is written against the kernel of a procedural-models library (procedural-models.js: Geo, prism,
 * cyl, tube, box, rbox, boltsAt, MAT, the matrix helpers). That library is the owner's and is not
 * shipped here; registerModel(pipeRack) adds this model to it.
 * Written against three 0.186.1.
 */
import { Geo, P2, prism, cyl, tube, box, rbox, boltsAt, MAT, T, X, RX, HALF, TAU } from './procedural-models.js';

export const pipeRack = {
  id: 'pipes', tab: 'Pipes', name: 'Pipe rack', kind: 'Parallel pipes on supports, flanged, with a valve and an end bend',
  view: { az: -0.8, el: 0.3 },
  params: [
    { key: 'pipes', label: 'Pipes', type: 'range', min: 1, max: 5, step: 1, value: 3 },
    { key: 'length', label: 'Length', type: 'range', min: 3, max: 24, step: 0.5, value: 12, unit: 'm' },
    { key: 'diameter', label: 'Diameter', type: 'range', min: 0.15, max: 1.2, step: 0.05, value: 0.4, unit: 'm' },
    { key: 'spacing', label: 'Spacing', type: 'range', min: 1.4, max: 3, step: 0.1, value: 1.8, unit: 'diameters' },
    { key: 'stand', label: 'Stand-off', type: 'range', min: 0.3, max: 2.5, step: 0.05, value: 0.9, unit: 'm' },
    { key: 'supports', label: 'Supports', type: 'select', options: [['rack', 'Rack'], ['saddles', 'Saddles'], ['none', 'None']], value: 'rack' },
    { key: 'flanges', label: 'Flanged joint', type: 'toggle', value: true },
    { key: 'lagging', label: 'Lagging bands', type: 'toggle', value: false },
    { key: 'valve', label: 'Valve', type: 'toggle', value: true },
    { key: 'bend', label: 'End bend', type: 'select', options: [['none', 'None'], ['out', 'Out of the plane'], ['in', 'Into the plane'], ['left', 'Left'], ['right', 'Right']], value: 'none' },
    { key: 'color', label: 'Paint', type: 'color', options: ['#C9C0A6', '#984A38', '#6C7A86', '#A3ABB0'], value: '#C9C0A6' },
  ],
  build(s) {
    const lod = s.detail || 'high', hi = lod === 'high', lo = lod === 'low';
    const n = s.pipes, L = s.length, D = s.diameter, pitch = D * s.spacing, zc = s.stand;
    const SIZES = [1, 0.6, 0.8, 0.5, 0.7], radii = Array.from({ length: n }, (_, i) => D / 2 * SIZES[i]), rMax = Math.max(...radii);
    const xs = radii.map((_, i) => (i - (n - 1) / 2) * pitch), W = (n - 1) * pitch + 2 * rMax;
    const segs = r => (lo ? 8 : hi ? (r < 0.15 ? 12 : r < 0.5 ? 20 : 28) : 12);
    const pipes = new Geo(), flanges = new Geo(), valves = new Geo(), supports = new Geo(), bolts = new Geo(), bands = new Geo(), lamps = new Geo();
    const bendDir = { out: [0, 0, 1], in: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0] }[s.bend];
    // a flanged joint at y on a pipe of radius r: two discs with a gap between, a bolt ring on the outer face of each
    const joint = (x, y, r) => {
      const fr = r * 1.3, ft = Math.max(0.03, r * 0.3), gap = Math.max(0.01, r * 0.08);
      for (const e of [-1, 1]) {
        flanges.add(hi ? cyl(fr, ft, segs(r), ft * 0.2) : cyl(fr, ft, segs(r)), T(x, y + e * (gap / 2 + ft / 2), zc));
        if (!hi) continue;
        const ring = [], bn = r < 0.15 ? 6 : r < 0.4 ? 8 : 12;
        for (let i = 0; i < bn; i++) ring.push([fr * 0.8 * Math.cos(TAU * i / bn), fr * 0.8 * Math.sin(TAU * i / bn)]);
        boltsAt(bolts, X(T(x, y + e * (gap / 2 + ft), zc), RX(e > 0 ? -HALF : HALF)), ring, Math.max(0.012, r * 0.1), 'nut');
      }
    };
    radii.forEach((r, i) => {
      const x = xs[i], sg = segs(r);
      if (bendDir) {
        // the straight length, a bend of 1.5 diameters' radius at its end, and a tail of two diameters on
        const R = 3 * r, tail = 4 * r;
        pipes.add(tube([[x, 0, zc], [x, L, zc], [x + bendDir[0] * (R + tail), L, zc + bendDir[2] * (R + tail)]], r, { bend: R, segs: sg, arcSegs: hi ? 8 : 4 }));
      } else pipes.add(cyl(r, L, sg).at(x, L / 2, zc));
      if (s.flanges) joint(x, 0, r);
      if (s.lagging && !lo) for (let y = 1; y < L - 0.5; y += 2) bands.add(cyl(r + 0.02, 0.08, sg).at(x, y, zc));
    });
    // the valve: on the first pipe at mid-length, a body between two flanged joints; on it, on a stem, an actuator box
    // with a status lamp on its top
    if (s.valve && !lo) {
      const r = radii[0], x = xs[0], y = L / 2, body = Math.max(0.3, 2.4 * r), box3 = (w, h, d, b) => (hi ? rbox(w, h, d, b, 2) : box(w, h, d));
      joint(x, y - body / 2, r); joint(x, y + body / 2, r);
      valves.add(box3(r * 2.2, body - r * 0.6, r * 2.2, r * 0.08), T(x, y, zc));
      valves.add(cyl(r * 0.25, r * 0.6, 8).rx(HALF), T(x, y, zc + r * 1.3));
      valves.add(box3(r * 1.4, r * 1.4, r * 1.6, r * 0.06), T(x, y, zc + r * 2.4));
      lamps.add(cyl(r * 0.18, 0.06, 8).rx(HALF), T(x, y, zc + r * 3.2 + 0.03));
    }
    // the supports, at stations along the module: a rack (a beam across on a post at each end, a clamp round
    // each pipe), or a saddle under each pipe on its own post; each post on a base plate
    if (s.supports !== 'none' && !lo) {
      const every = L / Math.ceil(L / 4), pw = 0.1 + rMax * 0.2;
      const post = (x, y, top) => { supports.add(box(pw, top, pw).rx(HALF), T(x, y, top / 2)); supports.add(box(pw * 3, pw * 3, 0.02), T(x, y, 0.01)); };
      const clamp = (x, y, r) => supports.add(prism(P2.circle(r + 0.035, segs(r)), 0.06, { holes: [P2.circle(r + 0.005, segs(r))] }).rx(HALF), T(x, y, zc));
      for (let y = every / 2; y < L; y += every) {
        if (s.supports === 'rack') {
          const under = zc - rMax - 0.07;
          supports.add(box(W + 0.5, 0.16, 0.14), T(0, y, under));
          for (const e of [-1, 1]) post(e * (W / 2 + 0.15), y, under - 0.07);
          radii.forEach((r, i) => clamp(xs[i], y, r));
        } else radii.forEach((r, i) => { supports.add(box(r * 2.2, 0.3, r * 0.25), T(xs[i], y, zc - r - r * 0.125)); post(xs[i], y, zc - r - r * 0.25); });
      }
    }
    return {
      layers: [
        { name: 'Pipes', geo: pipes, mat: MAT.paint(s.color) },
        { name: 'Flanges', geo: flanges, mat: MAT.steel },
        { name: 'Valve', geo: valves, mat: { color: '#2a2d31', rough: 0.58, metal: 0.15 } },
        { name: 'Supports', geo: supports, mat: MAT.galv },
        { name: 'Lagging bands', geo: bands, mat: MAT.zinc },
        { name: 'Fasteners', geo: bolts, mat: { color: '#565c63', rough: 0.4, metal: 0.85 } },
        { name: 'Status lamp', geo: lamps, mat: { color: '#3aff8a', rough: 0.4, metal: 0, glow: 1.5 } },
      ],
      figure: [W / 2 + 1, 1, 0],
    };
  },
};
