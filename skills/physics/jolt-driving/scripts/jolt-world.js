// jolt-world.js - a Jolt (jolt-physics 1.0.0, wasm-compat) world for a driving scene.
//
// Two object layers (static world / moving bodies), the broadphase + pair filter tables, a fixed
// step with an accumulator, body helpers that free every WASM temporary, a static-mesh queue (one
// new shape build per pump), heightfield bodies per terrain chunk, a budgeted body retirement
// queue, and a guarded ray cast. createHeightfieldRing() keeps colliders only around the vehicle.
//
// Usage:
//   import initJolt from 'jolt-physics/wasm-compat';
//   const Jolt = await initJolt();
//   const world = createJoltWorld(Jolt);
//   const alpha = world.step(frameDt, () => vehicle.update(world.fixedDt, input, env));
//
// The caller owns the Jolt module; nothing here imports it. Positions are plain {x, y, z};
// quaternions plain {x, y, z, w}. Every body helper returns the Jolt Body (body.GetID()).

export const WORLD_DEFAULTS = {
  fixedDt: 1 / 60,          // s; the vehicle constants are tuned at 60 Hz
  maxSteps: 5,              // fixed steps per frame before the accumulator is dropped (no spiral)
  collisionSteps: 1,        // jolt.Step(dt, n) sub-steps
  gravity: null,            // [x, y, z] m/s^2, null = Jolt default (0, -9.81, 0)
  maxBodies: null,          // JoltSettings.mMaxBodies (null = Jolt default)
  maxBodyPairs: null,       // JoltSettings.mMaxBodyPairs
  maxContactConstraints: null,
  staticFriction: 0.75,     // static boxes, compounds, meshes
  groundFriction: 1.0,      // heightfields: combined with the tyre curves this is the grip baseline
  boxCacheMax: 512,         // LRU of box shapes keyed by half extents
  heightRange: [-1e5, 1e5], // m; heightfield samples outside are rejected (a NaN/garbage bake)
  retirePerFrame: 64,       // bodies destroyed per pumpRetired() call
  maxRayLength: 1000,       // m; longer (or non-finite) rays are refused
};

export const LAYER_NON_MOVING = 0;
export const LAYER_MOVING = 1;

export function createJoltWorld(Jolt, options = {}) {
  const o = { ...WORLD_DEFAULTS, ...options };

  // --- init + filters --------------------------------------------------------
  const settings = new Jolt.JoltSettings();
  if (o.maxBodies != null) settings.mMaxBodies = o.maxBodies;
  if (o.maxBodyPairs != null) settings.mMaxBodyPairs = o.maxBodyPairs;
  if (o.maxContactConstraints != null) settings.mMaxContactConstraints = o.maxContactConstraints;
  const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);
  const BP_NON_MOVING = new Jolt.BroadPhaseLayer(0), BP_MOVING = new Jolt.BroadPhaseLayer(1);
  const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, BP_NON_MOVING);
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, BP_MOVING);
  settings.mObjectLayerPairFilter = objectFilter;
  settings.mBroadPhaseLayerInterface = bpInterface;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    settings.mBroadPhaseLayerInterface, 2, settings.mObjectLayerPairFilter, 2,
  );
  const jolt = new Jolt.JoltInterface(settings); // owns the filter tables from here on
  const physicsSystem = jolt.GetPhysicsSystem();
  const bodyInterface = physicsSystem.GetBodyInterface();
  if (o.gravity) {
    const g = new Jolt.Vec3(o.gravity[0], o.gravity[1], o.gravity[2]);
    physicsSystem.SetGravity(g); Jolt.destroy(g);
  }

  // Scratch WASM objects reused by the helpers (never handed to a body that keeps them).
  const sPos = new Jolt.RVec3(0, 0, 0), sRot = new Jolt.Quat(0, 0, 0, 1), sHalf = new Jolt.Vec3(0, 0, 0);
  const setRot = (q) => (q ? sRot.Set(q.x, q.y, q.z, q.w) : sRot.Set(0, 0, 0, 1));

  const addBody = (bcs, activate) => {
    const body = bodyInterface.CreateBody(bcs);
    bodyInterface.AddBody(body.GetID(), activate ? Jolt.EActivation_Activate : Jolt.EActivation_DontActivate);
    Jolt.destroy(bcs);
    return body;
  };

  // --- fixed step --------------------------------------------------------------
  let accumulator = 0;
  /** Advance by a frame's dt; beforeEachStep() runs before every fixed step (vehicle input goes
   *  there, never once per frame). Returns alpha = accumulator / fixedDt for pose blending. */
  const step = (frameDt, beforeEachStep = null) => {
    accumulator += Math.min(Math.max(frameDt, 0), o.fixedDt * o.maxSteps);
    let n = 0;
    while (accumulator >= o.fixedDt && n < o.maxSteps) {
      beforeEachStep?.(o.fixedDt);
      jolt.Step(o.fixedDt, o.collisionSteps);
      accumulator -= o.fixedDt;
      n++;
    }
    if (n === o.maxSteps) accumulator = 0;
    return accumulator / o.fixedDt;
  };

  // --- shapes ------------------------------------------------------------------
  // Box shapes cached by exact half extents; the cache holds its own ref (AddRef), eviction
  // Releases it and bodies still using it keep theirs.
  const boxShapes = new Map();
  const boxShape = (hx, hy, hz) => {
    const key = hx + ',' + hy + ',' + hz;
    let shape = boxShapes.get(key);
    if (shape) { boxShapes.delete(key); boxShapes.set(key, shape); return shape; }
    sHalf.Set(hx, hy, hz);
    const bs = new Jolt.BoxShapeSettings(sHalf);
    shape = bs.Create().Get();
    Jolt.destroy(bs);
    shape.AddRef();
    boxShapes.set(key, shape);
    if (boxShapes.size > o.boxCacheMax) {
      const oldest = boxShapes.keys().next().value;
      boxShapes.get(oldest).Release();
      boxShapes.delete(oldest);
    }
    return shape;
  };

  /** Dynamic compound: boxes [[x, y, z, hx, hy, hz]], spheres [[x, y, z, r]], COM shifted by
   *  com [x, y, z] (local). Returns a Shape (a fresh one per call: SetShape frees the old one). */
  const compoundShape = (boxes = [], spheres = [], com = null) => {
    const I = Jolt.Quat.prototype.sIdentity();
    const cs = new Jolt.StaticCompoundShapeSettings();
    for (const [x, y, z, hx, hy, hz] of boxes) cs.AddShape(new Jolt.Vec3(x, y, z), I, new Jolt.BoxShapeSettings(new Jolt.Vec3(hx, hy, hz)), 0);
    for (const [x, y, z, r] of spheres) cs.AddShape(new Jolt.Vec3(x, y, z), I, new Jolt.SphereShapeSettings(r), 0);
    if (!com) return cs.Create().Get();
    return new Jolt.OffsetCenterOfMassShapeSettings(new Jolt.Vec3(com[0], com[1], com[2]), cs).Create().Get();
  };

  // --- bodies ------------------------------------------------------------------
  /** Any shape as a dynamic body; mass overrides the shape's, inertia is calculated from it. */
  const createDynamicShape = (shape, { position, rotation = null, mass, friction = 0.8, restitution = 0.1,
    angularDamping = null, allowSleeping = true, activate = false }) => {
    sPos.Set(position.x, position.y, position.z); setRot(rotation);
    const bcs = new Jolt.BodyCreationSettings(shape, sPos, sRot, Jolt.EMotionType_Dynamic, LAYER_MOVING);
    bcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateInertia;
    bcs.mMassPropertiesOverride.mMass = mass;
    bcs.mFriction = friction; bcs.mRestitution = restitution;
    if (angularDamping != null) bcs.mAngularDamping = angularDamping;
    bcs.mAllowSleeping = allowSleeping;
    return addBody(bcs, activate);
  };

  /** Dynamic box (props): spawned asleep, contacts wake it. */
  const createDynamicBox = ({ x, y, z, hx, hy, hz, mass, rotation = null, friction = 0.8, activate = false }) => {
    sHalf.Set(hx, hy, hz);
    const bs = new Jolt.BoxShapeSettings(sHalf);
    const body = createDynamicShape(bs.Create().Get(), { position: { x, y, z }, rotation, mass, friction, restitution: 0.1, activate });
    Jolt.destroy(bs);
    return body;
  };

  /** Dynamic cylinder along local Y (barrels, logs with a rotation). */
  const createDynamicCylinder = ({ x, y, z, halfHeight, radius, mass, rotation = null, friction = 0.6, activate = false }) => {
    const cs = new Jolt.CylinderShapeSettings(halfHeight, radius);
    const body = createDynamicShape(cs.Create().Get(), { position: { x, y, z }, rotation, mass, friction, restitution: 0.15, activate });
    Jolt.destroy(cs);
    return body;
  };

  const createStaticBox = ({ x, y, z, hx, hy, hz, rotation = null, friction = o.staticFriction }) => {
    sPos.Set(x, y, z); setRot(rotation);
    const bcs = new Jolt.BodyCreationSettings(boxShape(hx, hy, hz), sPos, sRot, Jolt.EMotionType_Static, LAYER_NON_MOVING);
    bcs.mFriction = friction;
    return addBody(bcs, false);
  };

  /** One static compound body for many boxes (world-space {x, y, z, hx, hy, hz, rotation?}) in a
   *  frame at (ox, 0, oz): one broadphase entry instead of hundreds. null on empty/failure; then
   *  fall back to createStaticBox per box. */
  const createStaticCompound = (boxes, ox = 0, oz = 0, friction = o.staticFriction) => {
    if (!boxes.length) return null;
    const cs = new Jolt.StaticCompoundShapeSettings();
    const p = new Jolt.Vec3(0, 0, 0), q = new Jolt.Quat(0, 0, 0, 1);
    for (const b of boxes) {
      p.Set(b.x - ox, b.y, b.z - oz);
      if (b.rotation) q.Set(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w); else q.Set(0, 0, 0, 1);
      cs.AddShapeShape(p, q, boxShape(b.hx, b.hy, b.hz), 0);
    }
    const result = cs.Create();
    const shape = result.HasError() ? null : result.Get();
    if (!shape) console.warn('jolt-world: compound failed -', result.GetError().c_str());
    Jolt.destroy(cs); Jolt.destroy(p); Jolt.destroy(q);
    if (!shape) return null;
    sPos.Set(ox, 0, oz); sRot.Set(0, 0, 0, 1);
    const bcs = new Jolt.BodyCreationSettings(shape, sPos, sRot, Jolt.EMotionType_Static, LAYER_NON_MOVING);
    bcs.mFriction = friction;
    return addBody(bcs, false);
  };

  // --- static meshes: cached by key, at most N new shape builds per pump ---------
  const meshShapes = new Map();
  const meshQueue = [];
  const buildMeshShape = (m) => {
    const P = m.positions, I = m.indices, nv = P.length / 3;
    for (let i = 0; i < P.length; i++) if (!Number.isFinite(P[i])) throw new Error('MeshShape ' + m.key + ': non-finite vertex');
    for (let i = 0; i < I.length; i++) if (!(I[i] >= 0 && I[i] < nv)) throw new Error('MeshShape ' + m.key + ': bad index');
    if (I.length % 3 || nv < 3) throw new Error('MeshShape ' + m.key + ': empty');
    const verts = new Jolt.VertexList();
    for (let i = 0; i < P.length; i += 3) { const v = new Jolt.Float3(P[i], P[i + 1], P[i + 2]); verts.push_back(v); Jolt.destroy(v); }
    const tris = new Jolt.IndexedTriangleList();
    for (let i = 0; i < I.length; i += 3) { const t = new Jolt.IndexedTriangle(I[i], I[i + 1], I[i + 2], 0); tris.push_back(t); Jolt.destroy(t); }
    const mats = new Jolt.PhysicsMaterialList(); // the 3-arg overload: 2 args picks another ctor and crashes
    const ms = new Jolt.MeshShapeSettings(verts, tris, mats);
    const result = ms.Create();
    if (result.HasError()) throw new Error('MeshShape ' + m.key + ': ' + result.GetError().c_str());
    const shape = result.Get();
    shape.AddRef(); // the ShapeResult slot is overwritten by the next Create(): the cache needs its own ref
    Jolt.destroy(ms); Jolt.destroy(mats); Jolt.destroy(tris); Jolt.destroy(verts);
    meshShapes.set(m.key, shape);
    return shape;
  };
  const meshBody = (shape, m) => {
    sPos.Set(m.x ?? 0, m.y ?? 0, m.z ?? 0); setRot(m.rotation);
    const bcs = new Jolt.BodyCreationSettings(shape, sPos, sRot, Jolt.EMotionType_Static, LAYER_NON_MOVING);
    bcs.mFriction = m.friction ?? o.staticFriction;
    return addBody(bcs, false);
  };
  /** m = { key, positions: Float32Array, indices, x, y, z, rotation?, isCancelled?() }. A cached
   *  key resolves at once; a new one waits for pumpMeshQueue(). Resolves null if cancelled. */
  const createStaticMeshQueued = (m) => {
    const cached = meshShapes.get(m.key);
    if (cached) return Promise.resolve(meshBody(cached, m));
    return new Promise((resolve, reject) => meshQueue.push({ m, resolve, reject }));
  };
  const pumpMeshQueue = (perFrame = 1) => {
    let built = 0;
    while (meshQueue.length && built < perFrame) {
      const { m, resolve, reject } = meshQueue.shift();
      if (m.isCancelled?.()) { resolve(null); continue; }
      try {
        let shape = meshShapes.get(m.key);
        if (!shape) { shape = buildMeshShape(m); built++; }
        resolve(meshBody(shape, m));
      } catch (e) { reject(e); }
    }
    return meshQueue.length;
  };

  // --- heightfields --------------------------------------------------------------
  /** Static heightfield for one terrain chunk. heights: Float32Array (cells + 1)^2, row-major
   *  (index j * (cells + 1) + i, i along +x, j along +z), world heights in metres; covers
   *  [x, x + size] x [z, z + size]. Throws on a bad length or a non-finite / out-of-range sample. */
  const createHeightfieldChunk = ({ x, z, size, cells, heights, friction = o.groundFriction }) => {
    const N = cells + 1;
    if (!heights || heights.length !== N * N) throw new Error(`heightfield: ${heights?.length} samples, want ${N * N}`);
    const [lo, hi] = o.heightRange;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (!(h >= lo && h <= hi)) throw new Error(`heightfield: bad sample ${h} at ${i} (chunk ${x}, ${z})`);
    }
    const cell = size / cells;
    const hf = new Jolt.HeightFieldShapeSettings();
    hf.mOffset.Set(x, 0, z);
    hf.mScale.Set(cell, 1, cell);
    hf.mSampleCount = N;
    hf.mHeightSamples.resize(N * N);
    // Straight into the WASM heap: per-element push_back crawls. View made after resize (heap may grow).
    new Float32Array(Jolt.HEAPF32.buffer, Jolt.getPointer(hf.mHeightSamples.data()), N * N).set(heights);
    sPos.Set(0, 0, 0); sRot.Set(0, 0, 0, 1);
    const bcs = new Jolt.BodyCreationSettings(hf.Create().Get(), sPos, sRot, Jolt.EMotionType_Static, LAYER_NON_MOVING);
    bcs.mFriction = friction;
    const body = addBody(bcs, false);
    Jolt.destroy(hf); // leaking per-chunk settings OOMs the Jolt heap after minutes of streaming
    return body;
  };

  // --- removal -------------------------------------------------------------------
  const removeBody = (body) => {
    if (!body) return;
    const id = body.GetID();
    bodyInterface.RemoveBody(id); bodyInterface.DestroyBody(id);
  };
  const retiring = [];
  /** Queue for destruction a few per frame (hundreds in one frame is a visible stall). */
  const retireBody = (body) => { if (body) retiring.push(body); };
  const pumpRetired = (n = o.retirePerFrame) => { while (n-- > 0 && retiring.length) removeBody(retiring.pop()); return retiring.length; };

  // --- ray cast --------------------------------------------------------------------
  const ray = {
    bp: new Jolt.DefaultBroadPhaseLayerFilter(jolt.GetObjectVsBroadPhaseLayerFilter(), LAYER_MOVING),
    obj: new Jolt.DefaultObjectLayerFilter(jolt.GetObjectLayerPairFilter(), LAYER_MOVING),
    anyBody: new Jolt.BodyFilter(), ignore: new Map(), shape: new Jolt.ShapeFilter(),
    settings: new Jolt.RayCastSettings(), origin: new Jolt.RVec3(0, 0, 0), dir: new Jolt.Vec3(0, 0, 1),
    collector: new Jolt.CastRayClosestHitCollisionCollector(),
  };
  ray.ray = new Jolt.RRayCast(ray.origin, ray.dir);
  /** Closest hit along a unit direction within maxDist, or null. Non-finite or absurd rays are
   *  refused: a NaN ray sends Jolt's tree walk into an endless loop (the tab hangs). */
  const castRay = (from, dir, maxDist, { ignoreBody = null } = {}) => {
    if (!Number.isFinite(from.x + from.y + from.z + dir.x + dir.y + dir.z + maxDist)) return null;
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len < 1e-9 || maxDist <= 0 || maxDist > o.maxRayLength) return null;
    const k = maxDist / len;
    ray.origin.Set(from.x, from.y, from.z); ray.dir.Set(dir.x * k, dir.y * k, dir.z * k);
    ray.ray.mOrigin = ray.origin; ray.ray.mDirection = ray.dir; // copied in
    let bodyFilter = ray.anyBody;
    if (ignoreBody) {
      const key = ignoreBody.GetID().GetIndexAndSequenceNumber();
      bodyFilter = ray.ignore.get(key);
      if (!bodyFilter) ray.ignore.set(key, (bodyFilter = new Jolt.IgnoreSingleBodyFilter(ignoreBody.GetID())));
    }
    ray.collector.Reset();
    physicsSystem.GetNarrowPhaseQuery().CastRay(ray.ray, ray.settings, ray.collector, ray.bp, ray.obj, bodyFilter, ray.shape);
    if (!ray.collector.HadHit()) return null;
    const f = ray.collector.mHit.mFraction, d = f * maxDist;
    return { fraction: f, distance: d, point: { x: from.x + dir.x / len * d, y: from.y + dir.y / len * d, z: from.z + dir.z / len * d }, bodyId: ray.collector.mHit.mBodyID };
  };

  return {
    Jolt, jolt, physicsSystem, bodyInterface, options: o,
    layers: { NON_MOVING: LAYER_NON_MOVING, MOVING: LAYER_MOVING },
    get fixedDt() { return o.fixedDt; },
    step, boxShape, compoundShape,
    createDynamicShape, createDynamicBox, createDynamicCylinder, createStaticBox, createStaticCompound,
    createStaticMeshQueued, pumpMeshQueue, createHeightfieldChunk,
    removeBody, retireBody, pumpRetired, castRay,
  };
}

export const RING_DEFAULTS = {
  chunkSize: 256,     // m per chunk side
  radius: 1,          // Chebyshev chunks around the vehicle with colliders: 1 = the 3x3
  keepRadius: 2,      // colliders retire only past this (hysteresis: no rebuild on a border wobble)
  buildsPerFrame: 1,  // new heightfields per update() (one costs ~4 ms from pre-baked samples)
};

/** Heightfield colliders that follow a point. samplesFor(cx, cz) -> { heights, cells } or null
 *  (not ready yet); chunk (cx, cz) covers [cx * size, (cx + 1) * size] on x and z. */
export function createHeightfieldRing(world, samplesFor, options = {}) {
  const o = { ...RING_DEFAULTS, ...options };
  const bodies = new Map(); // key -> Body
  const key = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
  const coord = (v) => Math.floor(v / o.chunkSize);
  const build = (cx, cz) => {
    const k = key(cx, cz);
    if (bodies.has(k)) return true;
    const s = samplesFor(cx, cz);
    if (!s) return false;
    bodies.set(k, world.createHeightfieldChunk({ x: cx * o.chunkSize, z: cz * o.chunkSize, size: o.chunkSize, cells: s.cells, heights: s.heights }));
    return true;
  };
  return {
    bodies,
    /** Build the chunk under (x, z) now if it can be; true when a collider is there. */
    ensure(x, z) { return build(coord(x), coord(z)); },
    has(x, z) { return bodies.has(key(coord(x), coord(z))); },
    /** Per frame: nearest missing chunks first (budgeted), retire the far ones. */
    update(x, z) {
      const cx = coord(x), cz = coord(z);
      build(cx, cz);
      let budget = o.buildsPerFrame;
      for (let r = 1; r <= o.radius && budget > 0; r++) {
        for (let dz = -r; dz <= r && budget > 0; dz++) for (let dx = -r; dx <= r && budget > 0; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r || bodies.has(key(cx + dx, cz + dz))) continue;
          if (build(cx + dx, cz + dz)) budget--;
        }
      }
      for (const [k, body] of bodies) {
        const bx = Math.floor(k / 65536) - 32768, bz = (k % 65536) - 32768;
        if (Math.max(Math.abs(bx - cx), Math.abs(bz - cz)) > o.keepRadius) { world.retireBody(body); bodies.delete(k); }
      }
    },
    /** Drop one chunk's collider (its terrain was unloaded). */
    remove(cx, cz) { const k = key(cx, cz), b = bodies.get(k); if (b) { world.retireBody(b); bodies.delete(k); } },
    dispose() { for (const b of bodies.values()) world.removeBody(b); bodies.clear(); },
  };
}
