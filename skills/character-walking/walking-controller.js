// Character walking on a Jolt 1.1.0 CharacterVirtual capsule. Three.js 0.186.1 / WebGPU.
// Two parts: a small adapter over Jolt (createJoltCharacter) and the controller that
// turns input into capsule velocity (createWalker). The controller only uses the
// adapter's interface, so another physics library can be swapped in behind it.
//
// Units: metres, seconds, +Y up. No per-frame allocation.

export const CHARACTER = {
  height: 1.8,        // standing capsule height (feet to crown)
  crouchHeight: 1.0,
  radius: 0.35,
  jumpForce: 8,       // m/s impulse along up
  walkSpeed: 4,
  runSpeed: 7,
  crouchSpeed: 2,
  maxSlopeDeg: 45,
  stepUp: 0.55,       // one stair riser with margin
  stickToFloor: 0.5,
  rideMass: 20,       // ground bodies lighter than this do not carry the character
  crouchEase: 10,     // exponential rate for the visible height
};

/** Cylinder half-length of a capsule whose total height is `height`. */
export const halfHeight = (height, radius) => Math.max(height / 2 - radius, 0.01);

/**
 * Jolt adapter. Build the physics world first (JoltSettings with two object layers,
 * JoltInterface, PhysicsSystem with gravity). `movingLayer` is the object layer index
 * for moving bodies; the character collides with everything that layer collides with.
 *
 * @param {any} Jolt  the module from `await initJolt()`
 * @param {any} jolt  the JoltInterface
 * @param {any} physicsSystem
 * @param {{ movingLayer?: number, height?: number, crouchHeight?: number, radius?: number,
 *           position?: { x: number, y: number, z: number },
 *           groundMass?: (bodyId: number) => number | undefined }} [opts]
 *   groundMass: optional lookup from a ground body's sequence number to its mass, used
 *   for the ride rule. Return undefined for static ground.
 */
export const createJoltCharacter = (Jolt, jolt, physicsSystem, opts = {}) => {
  const height = opts.height ?? CHARACTER.height;
  const crouchHeight = opts.crouchHeight ?? CHARACTER.crouchHeight;
  const radius = opts.radius ?? CHARACTER.radius;
  const movingLayer = opts.movingLayer ?? 1;
  const groundMass = opts.groundMass ?? (() => undefined);

  const identQuat = () => Jolt.Quat.prototype.sIdentity(); // never cache this
  const tmpVec3 = new Jolt.Vec3();
  const tmpRVec3 = new Jolt.RVec3();

  const makeCapsule = (h) => {
    const cylinderHalf = halfHeight(h, radius);
    const offset = new Jolt.Vec3(0, cylinderHalf + radius, 0); // origin at the feet
    const capsule = new Jolt.CapsuleShapeSettings(cylinderHalf, radius);
    const rotated = new Jolt.RotatedTranslatedShapeSettings(offset, identQuat(), capsule);
    const shape = rotated.Create().Get();
    Jolt.destroy(offset);
    return shape;
  };
  const standingShape = makeCapsule(height);
  const crouchingShape = makeCapsule(crouchHeight);

  const settings = new Jolt.CharacterVirtualSettings();
  settings.mMass = 80;
  settings.mMaxSlopeAngle = (CHARACTER.maxSlopeDeg * Math.PI) / 180;
  settings.mMaxStrength = 100;
  settings.mShape = standingShape;
  settings.mBackFaceMode = Jolt.EBackFaceMode_CollideWithBackFaces;
  settings.mCharacterPadding = 0.02;
  settings.mPenetrationRecoverySpeed = 0.5;
  settings.mPredictiveContactDistance = 0.1;
  settings.mSupportingVolume = new Jolt.Plane(Jolt.Vec3.prototype.sAxisY(), -radius);

  const start = opts.position ?? { x: 0, y: height, z: 0 };
  tmpRVec3.Set(start.x, Math.max(0.01, start.y - halfHeight(height, radius)), start.z);
  const character = new Jolt.CharacterVirtual(settings, tmpRVec3, identQuat(), physicsSystem);

  // Filters: the character behaves like a moving body for broad phase and layer tests.
  const bpFilter = new Jolt.DefaultBroadPhaseLayerFilter(jolt.GetObjectVsBroadPhaseLayerFilter(), movingLayer);
  const layerFilter = new Jolt.DefaultObjectLayerFilter(jolt.GetObjectLayerPairFilter(), movingLayer);
  const bodyFilter = new Jolt.BodyFilter();
  const shapeFilter = new Jolt.ShapeFilter();

  const updateSettings = new Jolt.ExtendedUpdateSettings();
  updateSettings.mWalkStairsStepUp.Set(0, CHARACTER.stepUp, 0);
  updateSettings.mStickToFloorStepDown.Set(0, -CHARACTER.stickToFloor, 0);

  let currentHeight = height;
  let crouched = false;

  const state = { x: 0, y: 0, z: 0, grounded: false, steep: false, height, crouched: false,
    velocityY: 0, groundVelocity: { x: 0, y: 0, z: 0 }, rideable: false };

  const sync = () => {
    const p = character.GetPosition(); // feet
    const v = character.GetLinearVelocity();
    state.x = p.GetX();
    state.y = p.GetY() + halfHeight(currentHeight, radius); // centre
    state.z = p.GetZ();
    state.velocityY = v.GetY();
    const g = character.GetGroundState();
    state.grounded = g === Jolt.EGroundState_OnGround;
    state.steep = g === Jolt.EGroundState_OnSteepGround;
    state.height = currentHeight;
    state.crouched = crouched;
    if (state.grounded) {
      character.UpdateGroundVelocity();
      const gv = character.GetGroundVelocity();
      state.groundVelocity.x = gv.GetX(); state.groundVelocity.y = gv.GetY(); state.groundVelocity.z = gv.GetZ();
      const mass = groundMass(character.GetGroundBodyID().GetIndexAndSequenceNumber());
      state.rideable = mass === undefined || mass >= CHARACTER.rideMass;
    } else {
      state.groundVelocity.x = state.groundVelocity.y = state.groundVelocity.z = 0;
      state.rideable = false;
    }
    return state;
  };
  sync();

  return {
    radius,
    standingHeight: height,
    crouchHeight,
    /** Shape swap; Jolt refuses to stand up without headroom, so keep asking. */
    setCrouch(want) {
      if (want === crouched) return crouched;
      const ok = character.SetShape(want ? crouchingShape : standingShape,
        1.5 * physicsSystem.GetPhysicsSettings().mPenetrationSlop,
        bpFilter, layerFilter, bodyFilter, shapeFilter, jolt.GetTempAllocator());
      if (ok) { crouched = want; currentHeight = want ? crouchHeight : height; }
      return crouched;
    },
    /** Sets the velocity and runs Jolt's stair/slope/stick-to-floor update for dt. */
    extendedUpdate(velocity, dt) {
      tmpVec3.Set(velocity.x, velocity.y, velocity.z);
      character.SetLinearVelocity(tmpVec3);
      character.ExtendedUpdate(dt, character.GetUp(), updateSettings,
        bpFilter, layerFilter, bodyFilter, shapeFilter, jolt.GetTempAllocator());
      return sync();
    },
    /** Zero horizontal velocity, keep vertical (used to stop edge creep). */
    holdStill() {
      const v = character.GetLinearVelocity();
      tmpVec3.Set(0, v.GetY(), 0);
      character.SetLinearVelocity(tmpVec3);
    },
    /** Capsule centre and ground state. Shared object: copy if kept. */
    state: sync,
    /** Place the capsule centre at a point (feet derived). */
    teleport(x, y, z) {
      tmpRVec3.Set(x, y - halfHeight(currentHeight, radius), z);
      character.SetPosition(tmpRVec3);
      tmpVec3.Set(0, 0, 0);
      character.SetLinearVelocity(tmpVec3);
      sync();
    },
    character, // the raw CharacterVirtual for listeners or queries
  };
};

/**
 * Locomotion rules on top of the adapter. Physics-library independent.
 * @param {{ character: ReturnType<typeof createJoltCharacter>, gravity?: number,
 *           speeds?: { walk?: number, run?: number, crouch?: number }, jumpForce?: number }} opts
 */
export const createWalker = ({ character, gravity = 18, speeds = {}, jumpForce = CHARACTER.jumpForce }) => {
  const walk = speeds.walk ?? CHARACTER.walkSpeed;
  const run = speeds.run ?? CHARACTER.runSpeed;
  const crouchSpeed = speeds.crouch ?? CHARACTER.crouchSpeed;
  const wish = { x: 0, z: 0 };
  const velocity = { x: 0, y: 0, z: 0 };
  let visibleHeight = character.standingHeight;
  let crouchHeld = false;

  /** 0 standing → 1 fully crouched, from the eased visible height. */
  const crouchBlend = () => Math.min(1, Math.max(0,
    (character.standingHeight - visibleHeight) / (character.standingHeight - character.crouchHeight)));

  return {
    /** Request crouch; the capsule swaps when there is room. */
    setCrouch(want) { crouchHeld = !!want; character.setCrouch(crouchHeld); },
    /**
     * @param {{ x: number, z: number }} move  input axes, -1/0/1 (x right, z back)
     * @param {number} yaw  camera yaw in radians (forward = camera forward on the ground)
     * @param {'walk'|'run'|'crouch'|number} gait  named gait or a speed in m/s
     * @param {boolean} jumpPressed  edge-triggered this frame
     * @param {number} dt  seconds, clamp to 1/30 before calling
     */
    move(move, yaw, gait, jumpPressed, dt) {
      const s = character.state();
      const speed = typeof gait === 'number' ? gait
        : gait === 'run' && !crouchHeld ? run : gait === 'crouch' || crouchHeld ? crouchSpeed : walk;
      // Rotate input axes by the camera yaw. Forward is -Z in camera space.
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      wish.x = move.x * cos + move.z * sin;
      wish.z = -move.x * sin + move.z * cos;
      const len = Math.hypot(wish.x, wish.z);
      const moving = len > 0;
      if (moving) { wish.x /= len; wish.z /= len; }

      // Vertical: keep what the capsule has, or inherit the ground on contact.
      const onGround = s.grounded;
      const towardGround = s.velocityY - s.groundVelocity.y < 0.1;
      let vx = 0, vy = s.velocityY, vz = 0;
      if (onGround && towardGround) {
        if (s.rideable) { vx = s.groundVelocity.x; vy = s.groundVelocity.y; vz = s.groundVelocity.z; }
        else { vx = 0; vy = 0; vz = 0; }
      }
      const canJump = jumpPressed && onGround && !crouchHeld;
      if (canJump) vy += jumpForce;
      vy -= gravity * dt;

      velocity.x = vx + (moving ? wish.x * speed : 0);
      velocity.y = vy;
      velocity.z = vz + (moving ? wish.z * speed : 0);
      const after = character.extendedUpdate(velocity, dt);

      // Edge contacts tilt the ground normal; standing still must not creep off a lip.
      if (!moving && (after.grounded || after.steep)) character.holdStill();

      visibleHeight += (after.height - visibleHeight) * Math.min(1, dt * CHARACTER.crouchEase);
      return after;
    },
    /** Capsule centre and ground state (shared object). */
    state: () => character.state(),
    /** Feet height from the centre, for models. */
    feetY: () => character.state().y - halfHeight(character.state().height, character.radius),
    crouchBlend,
    /** Eye height above the feet, eased with the crouch. */
    eyeHeight(standing = 1.6, crouched = 0.9) { const t = crouchBlend(); return standing + (crouched - standing) * t; },
    /** Heading of the last wish direction, for turning a third-person model. */
    wishHeading: () => (wish.x === 0 && wish.z === 0 ? null : Math.atan2(wish.x, wish.z)),
    teleport: (x, y, z) => character.teleport(x, y, z),
  };
};
