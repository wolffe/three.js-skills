// jolt-vehicle.js - a drivable four-wheel vehicle on Jolt's VehicleConstraint +
// WheeledVehicleController (jolt-physics 1.0.0 wasm-compat), with the handling layer on top:
// smoothed + speed-sensitive steering, brake-then-reverse pedal logic, a hysteretic holding brake,
// a park pin that sleeps the body, per-wheel friction curves from a surface table (rewritten only
// when a wheel's surface key changes), handbrake slide + assist, airborne extra gravity, water
// buoyancy/drag, an arcade top-speed drag, a fell-through net, flip/reset, and pose read-back with
// prev->current blending for a free-running render loop.
//
// Usage (see SKILL.md): const car = new WheeledVehicle(world, { spawn: { x, z }, heightAt });
//   world.step(dt, (h) => car.update(h, input, env));  car.applyPoseTo(group, wheelObjects, alpha);
// Conventions: +Z forward, +Y up, steer +1 = right. Wheel order FL, FR, RL, RR.

import * as THREE from 'three';

const DEG = Math.PI / 180;

// Per-surface multipliers on Jolt's default tyre curves. wet: share of `env.wetness` that applies.
// snow / asphalt / ice / wet asphalt are tuned values; gravel / dirt / grass are interpolated.
export const SURFACES = {
  snow:       { long: 1.00, lat: 1.00, wet: 0.5 },  // the tuned baseline
  asphalt:    { long: 1.05, lat: 1.18, wet: 1.0 },
  wetAsphalt: { long: 0.735, lat: 0.73, wet: 0.0 }, // asphalt at full wetness, as a fixed class
  gravel:     { long: 0.95, lat: 0.85, wet: 0.5 },
  dirt:       { long: 0.92, lat: 0.90, wet: 0.5 },
  grass:      { long: 0.80, lat: 0.80, wet: 0.5 },
  ice:        { long: 0.25, lat: 0.35, wet: 0.0 },
};

export const VEHICLE_DEFAULTS = {
  spawn: { x: 0, z: 0 }, yaw: 0,
  heightAt: null,                 // (x, z) -> ground height; spawn, flip and the fell-through net
  // chassis: a box, its bottom lifted (clears slope breaks), COM dropped (anti-roll-over lever)
  halfExtents: [1.3, 0.65, 2.9],  // m
  bodyLift: 0.2,                  // m the collider's bottom sits above the visual underside
  comDrop: 0.45,                  // m below the box centre
  mass: 2000,                     // kg
  angularDamping: 0.5,
  maxPitchRoll: 60 * DEG,         // past this tilt the constraint stops driving
  // wheels: positions relative to the chassis centre
  wheelRadius: 0.49, wheelWidth: 0.28,
  halfTrack: 1.02, halfWheelbase: 1.65, mountY: 0.15,
  wheels: null,                   // [{ x, z, steer, handbrake }] (null = 4 from halfTrack/halfWheelbase)
  restHeight: 0.94,               // chassis centre above ground at rest (model offset, reset height)
  // suspension
  suspRest: 0.7,                  // m natural length mount -> wheel centre
  suspMinFrac: 0.40, suspMaxFrac: 1.25,
  suspFrequency: 1.0,             // Hz
  suspDamping: 0.95,              // ratio; near-critical
  antiRoll: 600,                  // N/m per bar (front, rear); undamped springs in Jolt
  castRadiusFrac: 0.5,            // collision tester sphere radius = wheelRadius * this
  // steering / brakes
  maxSteer: 34 * DEG,
  steerSmoothing: 0.12,           // per-step lerp of the steering input
  highSpeedSteer: 0.7,            // share of maxSteer left at top speed
  maxBrakeTorque: 6000,           // Nm per wheel
  maxHandBrakeTorque: 24000,      // Nm, rear wheels only
  // engine / drivetrain: gearless automatic
  engineTorque: 900, minRPM: 800, maxRPM: 6000,
  gearRatio: 3.2, reverseRatio: -3.2, clutchStrength: 10,
  differentials: [[0, 1, 0.5], [2, 3, 0.5]], // [left, right, engine torque share] = 4WD
  // handling layer
  topSpeed: 38,                   // m/s: steering taper reference + arcade drag start
  topSpeedDrag: 2.0,              // 1/s bleed of speed over topSpeed (0 = off)
  reverseRearmSpeed: 0.3,         // m/s: brake pedal reverses only below this, after a release
  brakeToReverse: true,           // the brake pedal reverses once stopped (single-axis pedal)
  holdBrakeOn: 0.5, holdBrakeOff: 1.0, // m/s hysteresis of the automatic holding brake
  parkPinSpeed: 0.35, sleepSpeed: 0.05,
  handbrakeLat: 0.35,             // rear lateral grip share with the handbrake held
  handbrakeDecel: 12,             // m/s^2 assist while held and grounded
  airGravity: 1.9,                // gravity factor with all wheels off the ground
  wetLong: 0.30, wetLat: 0.38,    // grip lost at wetness 1 on a wet: 1 surface
  // water (env.waterLevelAt)
  waterFloatOffset: 0.45, waterBuoyancy: 14, waterDamping: 4, waterDrag: 3, waterDragK: 0.9, waterMaxLift: 22,
  fallThrough: 2,                 // m below heightAt = fell through a missing collider: re-seat
  spawnClearance: 0.15,           // m above suspRest + wheelRadius on reset/flip
  surfaces: SURFACES, defaultSurface: 'asphalt',
};

// Jolt's default tyre curves: longitudinal over slip ratio, lateral over slip angle (degrees).
const LONG_CURVE = [[0, 0], [0.06, 1.2], [0.2, 1.0]];
const LAT_CURVE = [[0, 0], [3, 1.2], [20, 1.0]];

export class WheeledVehicle {
  constructor(world, options = {}) {
    const o = this.o = { ...VEHICLE_DEFAULTS, ...options, surfaces: { ...SURFACES, ...options.surfaces } };
    this.world = world;
    const { Jolt, bodyInterface } = world;
    this.Jolt = Jolt; this.bi = bodyInterface;
    this.wheelDefs = o.wheels ?? [
      { x: -o.halfTrack, z: o.halfWheelbase, steer: true, handbrake: false },
      { x: o.halfTrack, z: o.halfWheelbase, steer: true, handbrake: false },
      { x: -o.halfTrack, z: -o.halfWheelbase, steer: false, handbrake: true },
      { x: o.halfTrack, z: -o.halfWheelbase, steer: false, handbrake: true },
    ];
    const n = this.wheelDefs.length;
    this.towing = false;          // set by a hitch: the park pin then leaves vertical speed alone
    this.fwdSpeed = 0; this.airborne = false; this.inWater = false; this.braking = false; this.reversing = false;
    this.wheelContacts = this.wheelDefs.map(() => ({ x: 0, y: 0, z: 0, grounded: false, surface: null }));
    this._steer = 0; this._steerAngle = 0; this._revArm = true; this._holdBrake = false; this._wasAirborne = false;
    this._surfaceKey = new Array(n).fill(null);
    this._spin = new Array(n).fill(0); this._susp = new Array(n).fill(o.suspRest);
    this._prev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), spin: new Array(n).fill(0), susp: new Array(n).fill(o.suspRest), steer: 0 };
    this._pos = new THREE.Vector3(); this._quat = new THREE.Quaternion(); this._fwd = new THREE.Vector3(0, 0, 1);
    this._tmp = new THREE.Vector3(); this._rq = new THREE.Quaternion(); this._rp = new THREE.Vector3(); this._bq = new THREE.Quaternion();
    this.renderFwd = new THREE.Vector3(0, 0, 1); // blended heading: a chase camera's yaw source
    this._imp = new Jolt.Vec3(0, 0, 0);

    const [hx, , hz] = o.halfExtents;
    const y0 = (o.heightAt ? o.heightAt(o.spawn.x, o.spawn.z) : 0) + this.#rideY();
    this.body = world.createDynamicShape(this.#chassisShape(hx, hz, 0), {
      position: { x: o.spawn.x, y: y0, z: o.spawn.z }, rotation: yawQuat(o.yaw), mass: o.mass,
      friction: 0.8, restitution: 0.1, angularDamping: o.angularDamping, allowSleeping: false, activate: true,
    });
    this.bodyId = this.body.GetID();
    this.#createConstraint();
    this.#snapHistory();
  }

  #rideY() { return this.o.suspRest + this.o.wheelRadius + this.o.spawnClearance; }

  /** Box (hx, hz half extents centred at local z = zc), bottom lifted by bodyLift, COM dropped. */
  #chassisShape(hx, hz, zc) {
    const { Jolt, o } = this;
    this.box = { hx, hz, zc }; // the hitch reads the box's rear
    const box = new Jolt.RotatedTranslatedShapeSettings(
      new Jolt.Vec3(0, o.bodyLift / 2, zc), Jolt.Quat.prototype.sIdentity(),
      new Jolt.BoxShapeSettings(new Jolt.Vec3(hx, o.halfExtents[1] - o.bodyLift / 2, hz)),
    );
    return new Jolt.OffsetCenterOfMassShapeSettings(new Jolt.Vec3(0, -o.comDrop, 0), box).Create().Get();
  }

  /** Refit the chassis box to another body shell (mass and inertia kept). */
  fitChassisBox(hx, zMin, zMax) {
    this.bi.SetShape(this.bodyId, this.#chassisShape(hx, (zMax - zMin) / 2, (zMax + zMin) / 2), false, this.Jolt.EActivation_Activate);
  }

  #createConstraint() {
    const { Jolt, o } = this;
    const settings = new Jolt.VehicleConstraintSettings();
    settings.mMaxPitchRollAngle = o.maxPitchRoll;
    settings.mWheels.clear();
    for (const w of this.wheelDefs) {
      const s = new Jolt.WheelSettingsWV();
      s.mPosition = new Jolt.Vec3(w.x, o.mountY, w.z);
      s.mSuspensionDirection = new Jolt.Vec3(0, -1, 0);
      s.mSteeringAxis = new Jolt.Vec3(0, 1, 0);
      s.mWheelUp = new Jolt.Vec3(0, 1, 0);
      s.mWheelForward = new Jolt.Vec3(0, 0, 1);
      s.mRadius = o.wheelRadius; s.mWidth = o.wheelWidth;
      s.mSuspensionMinLength = o.suspRest * o.suspMinFrac;
      s.mSuspensionMaxLength = o.suspRest * o.suspMaxFrac;
      s.mSuspensionSpring.mFrequency = o.suspFrequency;
      s.mSuspensionSpring.mDamping = o.suspDamping;
      s.mMaxSteerAngle = w.steer ? o.maxSteer : 0;
      s.mMaxBrakeTorque = o.maxBrakeTorque;
      s.mMaxHandBrakeTorque = w.handbrake ? o.maxHandBrakeTorque : 0;
      settings.mWheels.push_back(s);
    }
    const c = new Jolt.WheeledVehicleControllerSettings();
    c.mEngine.mMaxTorque = o.engineTorque; c.mEngine.mMinRPM = o.minRPM; c.mEngine.mMaxRPM = o.maxRPM;
    c.mTransmission.mMode = Jolt.ETransmissionMode_Auto;
    c.mTransmission.mGearRatios.clear(); c.mTransmission.mGearRatios.push_back(o.gearRatio);
    c.mTransmission.mReverseGearRatios.clear(); c.mTransmission.mReverseGearRatios.push_back(o.reverseRatio);
    c.mTransmission.mSwitchTime = 0;
    c.mTransmission.mClutchStrength = o.clutchStrength;
    c.mDifferentials.clear();
    for (const [l, r, share] of o.differentials) {
      const d = new Jolt.VehicleDifferentialSettings();
      d.mLeftWheel = l; d.mRightWheel = r; d.mEngineTorqueRatio = share;
      c.mDifferentials.push_back(d);
    }
    settings.mController = c;
    settings.mAntiRollBars.clear();
    for (let i = 0; i + 1 < this.wheelDefs.length; i += 2) {
      const bar = new Jolt.VehicleAntiRollBar();
      bar.mLeftWheel = i; bar.mRightWheel = i + 1; bar.mStiffness = o.antiRoll;
      settings.mAntiRollBars.push_back(bar);
    }
    this.constraint = new Jolt.VehicleConstraint(this.body, settings);
    // Sphere, not cylinder (catches heightfield triangle edges) nor ray (no width for kerbs/rocks).
    this.constraint.SetVehicleCollisionTester(new Jolt.VehicleCollisionTesterCastSphere(this.world.layers.MOVING, o.wheelRadius * o.castRadiusFrac));
    this.world.physicsSystem.AddConstraint(this.constraint);
    this.stepListener = new Jolt.VehicleConstraintStepListener(this.constraint); // the solver steps the vehicle
    this.world.physicsSystem.AddStepListener(this.stepListener);
    this.controller = Jolt.castObject(this.constraint.GetController(), Jolt.WheeledVehicleController);
  }

  /** Friction fields are LinearCurves, not scalars (a number assignment silently does nothing):
   *  rebuild Jolt's default points with Y scaled. GetSettings() is the base class: cast it. */
  #setWheelFriction(jw, long, lat) {
    const ws = this.Jolt.castObject(jw.GetSettings(), this.Jolt.WheelSettingsWV);
    ws.mLongitudinalFriction.Clear(); for (const [x, y] of LONG_CURVE) ws.mLongitudinalFriction.AddPoint(x, y * long);
    ws.mLateralFriction.Clear(); for (const [x, y] of LAT_CURVE) ws.mLateralFriction.AddPoint(x, y * lat);
  }

  #readPose(pos, quat) {
    const p = this.body.GetPosition(), q = this.body.GetRotation();
    pos.set(p.GetX(), p.GetY(), p.GetZ()); quat.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  }

  #snapHistory() {
    this.#readPose(this._prev.pos, this._prev.quat);
    this._pos.copy(this._prev.pos); this._quat.copy(this._prev.quat);
    for (let i = 0; i < this._spin.length; i++) { this._prev.spin[i] = this._spin[i]; this._prev.susp[i] = this._susp[i]; }
    this._prev.steer = this._steerAngle;
  }

  #impulse(x, y, z) { this._imp.Set(x, y, z); this.bi.AddImpulse(this.bodyId, this._imp); }

  /** Once per FIXED step, before the world steps. input: { throttle 0..1, brake 0..1, steer -1..1
   *  (+1 right), handbrake bool, reverse bool }. env: { surfaceAt(x, z) -> name, waterLevelAt(x, z)
   *  -> y | null, groundContact bool (collider under the vehicle exists), heightAt, wetness 0..1 }. */
  update(dt, input = {}, env = {}) {
    const { o, bi } = this;
    const heightAt = env.heightAt ?? o.heightAt;
    const handbrake = !!input.handbrake;
    this._steer += ((input.steer ?? 0) - this._steer) * o.steerSmoothing;

    this.#readPose(this._pos, this._quat);
    this._prev.pos.copy(this._pos); this._prev.quat.copy(this._quat);
    for (let i = 0; i < this._spin.length; i++) { this._prev.spin[i] = this._spin[i]; this._prev.susp[i] = this._susp[i]; }
    this._prev.steer = this._steerAngle;
    const { x: cx, y: cy, z: cz } = this._pos;
    this._fwd.set(0, 0, 1).applyQuaternion(this._quat);

    // No collider streamed under it yet: hold it on the analytic ground, keep horizontal motion.
    if (env.groundContact === false && heightAt) {
      const floor = heightAt(cx, cz) + this.#rideY();
      if (cy < floor) this.hold(floor);
    }
    // Fell through a missing collider: re-seat upright-as-is at ride height.
    if (heightAt && cy < heightAt(cx, cz) - o.fallThrough) {
      this.place({ x: cx, y: heightAt(cx, cz) + o.restHeight + 0.4, z: cz }, this._quat);
      return;
    }

    const lin = this.body.GetLinearVelocity();
    const lvx = lin.GetX(), lvy = lin.GetY(), lvz = lin.GetZ();
    const hSpeed = Math.hypot(lvx, lvz);
    const fwdSpeed = lvx * this._fwd.x + lvy * this._fwd.y + lvz * this._fwd.z;
    const m = o.mass;

    // Speed-sensitive steering: full lock at walking pace, highSpeedSteer by ~78 % of top speed.
    const taper = 1 - (1 - o.highSpeedSteer) * THREE.MathUtils.smoothstep(Math.min(1, hSpeed / (o.topSpeed * 0.85)), 0.12, 0.78);
    this._steerAngle = this._steer * o.maxSteer * taper;

    // Water: buoyancy toward a float line, vertical damping, horizontal drag low enough to drive out.
    const waterY = env.waterLevelAt ? env.waterLevelAt(cx, cz) : null;
    this.inWater = waterY != null;
    if (this.inWater) {
      const submerged = waterY + o.waterFloatOffset - cy;
      if (submerged > 0) this.#impulse(0, Math.min(o.waterMaxLift, Math.max(0, submerged * o.waterBuoyancy - lvy * o.waterDamping)) * m * dt, 0);
      if (hSpeed > 0.01) {
        const k = -Math.min(hSpeed / dt, o.waterDrag + hSpeed * o.waterDragK) * m * dt / hSpeed;
        this.#impulse(lvx * k, 0, lvz * k);
      }
    }

    // Wheels: contact + suspension from the constraint (never a separate ground ray: its threshold
    // disagrees with Jolt's travel and flips the airborne state every step), surface friction.
    let anyContact = false;
    const wet = env.wetness ?? 0;
    for (let i = 0; i < this.wheelDefs.length; i++) {
      const w = this.wheelDefs[i];
      const mount = this._tmp.set(w.x, o.mountY, w.z).applyQuaternion(this._quat);
      const mx = cx + mount.x, mz = cz + mount.z;
      const jw = this.constraint.GetWheel(i);
      this._susp[i] = Math.max(0.05, jw.GetSuspensionLength());
      const name = env.surfaceAt ? env.surfaceAt(mx, mz) : o.defaultSurface;
      const surf = o.surfaces[name] ?? o.surfaces[o.defaultSurface];
      const wc = this.wheelContacts[i];
      wc.grounded = jw.HasContact(); wc.surface = name;
      if (wc.grounded) {
        anyContact = true;
        wc.x = mx; wc.z = mz; wc.y = heightAt ? heightAt(mx, mz) : cy + mount.y - this._susp[i] - o.wheelRadius;
      }
      // Locked rears alone do not break the back loose (Jolt still solves lateral grip): cut it.
      const slide = handbrake && w.handbrake;
      const wetB = Math.round(wet * surf.wet * 4) / 4; // quantised: friction rewrites stay rare
      const key = name + '|' + wetB + (slide ? '|s' : '');
      if (this._surfaceKey[i] !== key) {
        this._surfaceKey[i] = key;
        const lat = surf.lat * (1 - o.wetLat * wetB);
        this.#setWheelFriction(jw, surf.long * (1 - o.wetLong * wetB), slide ? lat * o.handbrakeLat : lat);
      }
    }

    // Pedals -> driver input. Brake while rolling forward; a fresh press after stopping reverses.
    const throttleIn = input.throttle ?? 0, brakeIn = input.brake ?? 0;
    let throttle = 0, brake = 0;
    if (input.reverse && throttleIn > 0 && brakeIn === 0) {
      // Reverse selected: the throttle drives backwards, after braking out of forward motion.
      if (fwdSpeed > o.reverseRearmSpeed) brake = throttleIn; else throttle = -throttleIn;
      this._revArm = false;
    } else if (throttleIn > 0 && brakeIn === 0) { throttle = throttleIn; this._revArm = false; }
    else if (brakeIn > 0) {
      if (fwdSpeed > o.reverseRearmSpeed || !o.brakeToReverse) { brake = brakeIn; this._revArm = false; }
      else if (this._revArm) throttle = -brakeIn;
      else brake = brakeIn;
    } else {
      this._revArm = true;
      // Holding brake with hysteresis (one threshold bang-bangs into a lurch).
      if (!handbrake) {
        if (Math.abs(fwdSpeed) < o.holdBrakeOn) this._holdBrake = true;
        else if (Math.abs(fwdSpeed) > o.holdBrakeOff) this._holdBrake = false;
        if (this._holdBrake) brake = 1;
      } else this._holdBrake = false;
    }
    this.controller.SetDriverInput(throttle, this._steer, brake, handbrake ? 1 : 0);

    const airborne = !anyContact;
    if (airborne !== this._wasAirborne) { // only on change: jumps land sooner, grounded feel untouched
      this._wasAirborne = airborne;
      bi.SetGravityFactor(this.bodyId, airborne ? o.airGravity : 1);
    }
    const grounded = anyContact && !this.inWater;
    if (handbrake && grounded && hSpeed > 0.5) {
      const k = -Math.min(hSpeed / dt, o.handbrakeDecel) * m * dt / hSpeed;
      this.#impulse(lvx * k, 0, lvz * k);
    }
    // Arcade top speed: bleed the excess (the engine alone tops out at maxRPM / ratios).
    if (o.topSpeedDrag > 0 && grounded && Math.abs(fwdSpeed) > o.topSpeed) {
      const excess = Math.abs(fwdSpeed) - o.topSpeed, k = -Math.min(excess, excess * o.topSpeedDrag * dt) * m / hSpeed;
      this.#impulse(lvx * k, 0, lvz * k);
    }
    // Park pin: Jolt tyres go soft near zero speed (mm/s creep on grades). Zero horizontal speed,
    // keep a downward settle unless towing (then that clamp is a ratchet: the drawbar sinks it).
    const idle = throttleIn === 0 && brakeIn === 0;
    if (grounded && idle && hSpeed < o.parkPinSpeed && Math.abs(fwdSpeed) < o.parkPinSpeed) {
      this._imp.Set(0, this.towing ? lvy : Math.min(0, lvy), 0);
      bi.SetLinearVelocity(this.bodyId, this._imp);
      if (hSpeed < o.sleepSpeed && Math.abs(lvy) < o.sleepSpeed) bi.DeactivateBody(this.bodyId);
    }
    // Wake only while something asks it to move, or a parked vehicle never quiesces.
    if (throttle !== 0 || brakeIn > 0 || (input.steer ?? 0) !== 0 || handbrake || Math.abs(fwdSpeed) > o.sleepSpeed || airborne) bi.ActivateBody(this.bodyId);

    this.airborne = airborne;
    this.fwdSpeed = fwdSpeed;
    this.braking = (brake > 0 || handbrake) && fwdSpeed > 1;
    this.reversing = throttle < 0 || fwdSpeed < -0.5;

    // Visual roll: grounded wheels at travel speed, airborne ones at Jolt's wheel speed; the
    // handbrake locks the rears. Integrated, so switching source never jumps the angle.
    const roll = fwdSpeed / o.wheelRadius;
    for (let i = 0; i < this.wheelDefs.length; i++) {
      const jw = this.constraint.GetWheel(i);
      const wv = handbrake && this.wheelDefs[i].handbrake ? 0 : jw.HasContact() ? roll : jw.GetAngularVelocity();
      this._spin[i] += wv * dt;
    }
  }

  get speed() { const v = this.body.GetLinearVelocity(); return Math.hypot(v.GetX(), v.GetZ()); }
  get speedKmh() { return this.speed * 3.6; }
  /** Current physics pose (not blended). */
  get pose() {
    this.#readPose(this._pos, this._quat);
    return { position: this._pos.clone(), quaternion: this._quat.clone(), yaw: Math.atan2(this._fwd.set(0, 0, 1).applyQuaternion(this._quat).x, this._fwd.z) };
  }

  /** Chassis-local transform for a model whose wheelbase is rawHalfWheelbase * 2 and whose axle
   *  midpoint sits at rawAxleMidZ: put the model under the posed object with these. */
  modelTransform(rawHalfWheelbase, rawAxleMidZ = 0) {
    const s = this.o.halfWheelbase / rawHalfWheelbase;
    return { scale: s, position: new THREE.Vector3(0, -this.o.restHeight, -rawAxleMidZ * s) };
  }

  /** Once per RENDER frame: object3D = blended chassis pose; wheels[i] (hub-centred, axle along
   *  x) at mount - suspension, steered and spun. alpha from world.step. */
  applyPoseTo(object3D, wheels = [], alpha = 1) {
    const p = this.body.GetPosition(), q = this.body.GetRotation();
    this._rp.set(p.GetX(), p.GetY(), p.GetZ()).lerpVectors(this._prev.pos, this._rp, alpha);
    this._bq.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
    this._rq.slerpQuaternions(this._prev.quat, this._bq, alpha); // destination must not be an input
    this.renderFwd.set(0, 0, 1).applyQuaternion(this._rq);
    if (object3D) { object3D.position.copy(this._rp); object3D.quaternion.copy(this._rq); }
    const lerp = (a, b) => a + (b - a) * alpha;
    const steer = lerp(this._prev.steer, this._steerAngle);
    for (let i = 0; i < wheels.length && i < this.wheelDefs.length; i++) {
      const w = this.wheelDefs[i], mesh = wheels[i];
      if (!mesh) continue;
      this._tmp.set(w.x, this.o.mountY - lerp(this._prev.susp[i], this._susp[i]), w.z).applyQuaternion(this._rq);
      mesh.position.copy(this._rp).add(this._tmp);
      mesh.quaternion.copy(this._rq);
      if (w.steer) mesh.rotateY(-steer); // +steer = right = toward -X
      mesh.rotateX(lerp(this._prev.spin[i], this._spin[i]));
    }
  }

  /** Stationary at a pose; position.y null = heightAt + ride height. */
  place(position, quaternion) {
    const { Jolt, bi, o } = this;
    const y = position.y ?? ((o.heightAt ? o.heightAt(position.x, position.z) : 0) + this.#rideY());
    const p = new Jolt.RVec3(position.x, y, position.z), q = new Jolt.Quat(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    bi.SetPositionAndRotation(this.bodyId, p, q, Jolt.EActivation_Activate);
    this._imp.Set(0, 0, 0);
    bi.SetLinearVelocity(this.bodyId, this._imp); bi.SetAngularVelocity(this.bodyId, this._imp);
    Jolt.destroy(p); Jolt.destroy(q);
    this._steer = 0; this._steerAngle = 0;
    this.#snapHistory(); // or the render blends across the teleport
  }

  /** Upright, stationary, facing yaw (0 = +Z). */
  reset(position, yaw = 0) { this.place({ x: position.x, y: position.y ?? null, z: position.z }, yawQuat(yaw)); }

  /** Upright where it is, heading kept, momentum killed. */
  flip() {
    this.#readPose(this._pos, this._quat);
    const f = this._fwd.set(0, 0, 1).applyQuaternion(this._quat);
    this.reset({ x: this._pos.x, z: this._pos.z }, Math.atan2(f.x, f.z));
  }

  /** Hold at height y with no downward motion (no collider under it yet); horizontal untouched. */
  hold(y) {
    const { Jolt, bi } = this;
    const pp = this.body.GetPosition(), p = new Jolt.RVec3(pp.GetX(), y, pp.GetZ());
    bi.SetPosition(this.bodyId, p, Jolt.EActivation_Activate); Jolt.destroy(p);
    const v = this.body.GetLinearVelocity();
    if (v.GetY() < 0) { this._imp.Set(v.GetX(), 0, v.GetZ()); bi.SetLinearVelocity(this.bodyId, this._imp); }
  }

  dispose() {
    const ps = this.world.physicsSystem;
    ps.RemoveStepListener(this.stepListener);
    ps.RemoveConstraint(this.constraint);
    this.world.removeBody(this.body);
    this.Jolt.destroy(this._imp);
    this.body = this.constraint = this.controller = null;
  }
}

function yawQuat(yaw) { return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }; }
