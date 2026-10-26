// jolt-towing.js - a towable trailer for a WheeledVehicle (jolt-vehicle.js) on Jolt 1.0.0 wasm-compat.
//
// The trailer is its own dynamic body (compound boxes + a jockey-wheel sphere it stands on while
// parked, COM low and ahead of the axle) with a VehicleConstraint of unpowered, unsteered wheels on
// EXPLICIT springs. attach() slides it onto the tow ball and joins the two bodies with a
// SwingTwistConstraint in world space (yaw / pitch-roll limits), drops the jockey sphere and
// releases the parking brake; detach() reverses that. A teleport guard detaches when ball and
// coupler drift apart (the tractor was moved), an overrun brake stops a heavy trailer folding the
// tractor under braking, and the pair sleeps together when parked.
//
// Usage: const tow = new TowHitch(world, car, { mass: 300, ... });  tow.place(x, z, yaw, heightAt)
//   per fixed step, after car.update and before the world steps: tow.update(dt, env)
//   per render frame: tow.applyPoseTo(group, [axleObject], alpha)
// Trailer frame: origin on the ground under the body, +Z toward the drawbar, metres.

import * as THREE from 'three';

const DEG = Math.PI / 180;

export const TRAILER_DEFAULTS = {
  mass: 300,                  // kg
  loadShare: 0.91,            // share of the weight on the road wheels (the rest on the drawbar)
  halfExtents: null,          // [hx, hy, hz]: shorthand for one body box centred at boxCenter
  boxCenter: [0, 0.5, -0.49],
  boxes: [[0, 0.50, -0.49, 0.85, 0.28, 1.20], [0, 0.30, 1.15, 0.07, 0.05, 0.80]], // bed, drawbar
  com: [0, -0.15, 0.10],      // COM offset: low and ahead of the axle
  jockey: { x: 0, y: 0.05, z: 1.60, r: 0.07 }, // the sphere it stands on while unhitched (null = none)
  angularDamping: 0.3,
  // wheels (unpowered, unsteered)
  wheels: null,               // [{ x, z }] (null = a pair at +-wheelX, axleZ)
  wheelRadius: 0.27, wheelWidth: 0.19, wheelX: 0.97, axleZ: -0.54, axleY: 0.24,
  suspMin: 0.06, suspMax: 0.22, sag: 0.09, // m; spring k = wheel load / sag
  dampingRatio: 0.9,
  antiRoll: 300,              // N/m
  brakeTorque: 1200,          // Nm; also the parking brake while unhitched
  overrun: false,             // brake with the tractor's deceleration (heavy trailers)
  overrunStart: 0.8, overrunRange: 4, // m/s^2: deceleration where it starts / reaches full brake
  // coupling
  hitchLocalOnTrailer: [0, 0.38, 1.90], // the coupler
  hitchLocalOnTractor: null,  // the ball; null = (0, coupler y - tractorRide, box rear - ballBehind)
  tractorRide: null,          // tractor origin above ground at rest (null = its restHeight)
  ballBehind: 0.10,           // m behind the tractor's collision box
  constraint: { type: 'swingTwist', yaw: 70 * DEG, tilt: 25 * DEG },
  reach: 0.9,                 // m ball <-> coupler to attach
  attachMaxSpeed: 1.5, detachMaxSpeed: 3, // m/s of the tractor
  attachYawFrac: 0.9,         // attach only inside this share of the yaw limit
  teleportGap: 1.0,           // m ball <-> coupler: the tractor was moved, let go
  sleepAfterSteps: 45,        // still steps before the hitched trailer sleeps with the tractor
  parkClearance: 0.25,        // m dropped from when placed
  brakeEase: 0.3,             // per-step ease of the overrun brake
  pendingAttachSteps: 1500,   // restore(): keep trying to re-attach this many updates (25 s at 60 Hz)
};

export class TowHitch {
  constructor(world, tractor, trailerOptions = {}) {
    const o = this.o = { ...TRAILER_DEFAULTS, ...trailerOptions, constraint: { ...TRAILER_DEFAULTS.constraint, ...trailerOptions.constraint } };
    if (o.halfExtents && !trailerOptions.boxes) o.boxes = [[...o.boxCenter, ...o.halfExtents]];
    this.world = world; this.tractor = tractor; this.Jolt = world.Jolt; this.bi = world.bodyInterface;
    const wheelLoad = o.mass * 9.81 * o.loadShare / 2;
    this.springK = wheelLoad / o.sag;
    this.springC = 2 * o.dampingRatio * Math.sqrt(this.springK * wheelLoad / 9.81);
    this.suspRest = o.suspMax - o.sag;
    this.coupler = new THREE.Vector3(...o.hitchLocalOnTrailer);
    const ride = o.tractorRide ?? tractor.o.restHeight;
    this.ballY = o.hitchLocalOnTrailer[1] - ride;
    this.wheelDefs = o.wheels ?? [{ x: o.wheelX, z: o.axleZ }, { x: -o.wheelX, z: o.axleZ }];
    this.joint = null; this._frozen = true; this._still = 0; this._brake = 0; this._tractorV = 0; this._pending = 0;
    this._prevPos = new THREE.Vector3(); this._prevQuat = new THREE.Quaternion();
    this._pos = new THREE.Vector3(); this._quat = new THREE.Quaternion(); this._tq = new THREE.Quaternion();
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._c = new THREE.Vector3(); this._d = new THREE.Vector3();
    this._prevSusp = this.wheelDefs.map(() => this.suspRest); this._prevSpin = 0; this._spin = 0;
    this._v = new this.Jolt.Vec3(0, 0, 0);
    this.body = world.createDynamicShape(this.#shape(true), {
      position: { x: 0, y: 0, z: 0 }, mass: o.mass, friction: 0.8, restitution: 0.1,
      angularDamping: o.angularDamping, allowSleeping: true, activate: false,
    });
    this.bodyId = this.body.GetID();
    this.#createConstraint();
  }

  #shape(withJockey) {
    const J = this.o.jockey;
    return this.world.compoundShape(this.o.boxes, withJockey && J ? [[J.x, J.y, J.z, J.r]] : [], this.o.com);
  }

  #createConstraint() {
    const { Jolt, o } = this;
    const settings = new Jolt.VehicleConstraintSettings();
    settings.mWheels.clear();
    for (const w of this.wheelDefs) {
      const s = new Jolt.WheelSettingsWV();
      s.mPosition = new Jolt.Vec3(w.x, o.axleY + this.suspRest, w.z);
      s.mSuspensionDirection = new Jolt.Vec3(0, -1, 0);
      s.mSteeringAxis = new Jolt.Vec3(0, 1, 0);
      s.mWheelUp = new Jolt.Vec3(0, 1, 0);
      s.mWheelForward = new Jolt.Vec3(0, 0, 1);
      s.mRadius = o.wheelRadius; s.mWidth = o.wheelWidth;
      s.mSuspensionMinLength = o.suspMin; s.mSuspensionMaxLength = o.suspMax;
      // Explicit k/c: frequency mode sizes the spring from the effective mass at the wheel (mostly
      // roll inertia on a light trailer) and sits it on the bump stops.
      s.mSuspensionSpring.mMode = Jolt.ESpringMode_StiffnessAndDamping;
      s.mSuspensionSpring.mStiffness = this.springK;
      s.mSuspensionSpring.mDamping = this.springC;
      s.mMaxSteerAngle = 0;
      s.mMaxBrakeTorque = o.brakeTorque;
      s.mMaxHandBrakeTorque = o.brakeTorque; // parking brake: holds on a grade, the tractor can still shove it
      settings.mWheels.push_back(s);
    }
    const c = new Jolt.WheeledVehicleControllerSettings();
    c.mEngine.mMaxTorque = 0;
    c.mDifferentials.clear();
    settings.mController = c;
    settings.mAntiRollBars.clear();
    if (this.wheelDefs.length >= 2) {
      const bar = new Jolt.VehicleAntiRollBar();
      bar.mLeftWheel = 0; bar.mRightWheel = 1; bar.mStiffness = o.antiRoll;
      settings.mAntiRollBars.push_back(bar);
    }
    this.constraint = new Jolt.VehicleConstraint(this.body, settings);
    this.constraint.SetVehicleCollisionTester(new Jolt.VehicleCollisionTesterCastSphere(this.world.layers.MOVING, o.wheelRadius * 0.5));
    this.world.physicsSystem.AddConstraint(this.constraint);
    this.stepListener = new Jolt.VehicleConstraintStepListener(this.constraint);
    this.world.physicsSystem.AddStepListener(this.stepListener);
    this.controller = Jolt.castObject(this.constraint.GetController(), Jolt.WheeledVehicleController);
  }

  get attached() { return !!this.joint; }
  get x() { return this.body.GetPosition().GetX(); }
  get z() { return this.body.GetPosition().GetZ(); }

  #readPose(pos, quat) {
    const p = this.body.GetPosition(), q = this.body.GetRotation();
    pos.set(p.GetX(), p.GetY(), p.GetZ()); quat.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
  }
  /** Tow ball in world space (also leaves the tractor's rotation in _tq). */
  #ball(out) {
    const t = this.tractor, p = t.body.GetPosition(), q = t.body.GetRotation();
    this._tq.set(q.GetX(), q.GetY(), q.GetZ(), q.GetW());
    const local = this.o.hitchLocalOnTractor
      ? out.set(...this.o.hitchLocalOnTractor)
      : out.set(0, this.ballY, t.box.zc - t.box.hz - this.o.ballBehind);
    return local.applyQuaternion(this._tq).add(this._d.set(p.GetX(), p.GetY(), p.GetZ()));
  }
  #couplerWorld(out) {
    this.#readPose(this._pos, this._quat);
    return out.copy(this.coupler).applyQuaternion(this._quat).add(this._pos);
  }

  /** Put it down at (x, z) facing yaw, dropped from parkClearance, at rest, detached. */
  place(x, z, yaw = 0, heightAt = null) {
    const { Jolt, bi } = this;
    this.detach();
    const p = new Jolt.RVec3(x, (heightAt ? heightAt(x, z) : 0) + this.o.parkClearance, z);
    const q = new Jolt.Quat(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    bi.SetPositionAndRotation(this.bodyId, p, q, Jolt.EActivation_Activate);
    this._v.Set(0, 0, 0); bi.SetLinearAndAngularVelocity(this.bodyId, this._v, this._v);
    Jolt.destroy(p); Jolt.destroy(q);
    this._frozen = false;
    this.#readPose(this._prevPos, this._prevQuat);
  }

  /** Close enough, slow enough, and not folded past the joint's yaw reach? */
  canAttach() {
    if (this.joint || this._frozen || Math.abs(this.tractor.fwdSpeed || 0) > this.o.attachMaxSpeed) return false;
    if (this.#ball(this._a).distanceTo(this.#couplerWorld(this._b)) > this.o.reach) return false;
    const tf = this._c.set(0, 0, 1).applyQuaternion(this._tq), mf = this._b.set(0, 0, 1).applyQuaternion(this._quat);
    return Math.abs(Math.atan2(tf.x * mf.z - tf.z * mf.x, tf.x * mf.x + tf.z * mf.z)) < this.o.constraint.yaw * this.o.attachYawFrac;
  }
  canDetach() { return !!this.joint && Math.abs(this.tractor.fwdSpeed || 0) < this.o.detachMaxSpeed; }

  attach() {
    if (!this.canAttach()) return false;
    const { Jolt, o } = this;
    const ball = this.#ball(new THREE.Vector3()), cup = this.#couplerWorld(new THREE.Vector3());
    const np = new Jolt.RVec3(this._pos.x + ball.x - cup.x, this._pos.y + ball.y - cup.y, this._pos.z + ball.z - cup.z);
    this.bi.SetPosition(this.bodyId, np, Jolt.EActivation_Activate); // slide the last centimetres onto the ball
    Jolt.destroy(np);
    const at = new Jolt.RVec3(ball.x, ball.y, ball.z);
    let s;
    if (o.constraint.type === 'point') {
      s = new Jolt.PointConstraintSettings();
      s.mSpace = Jolt.EConstraintSpace_WorldSpace;
      s.mPoint1 = at; s.mPoint2 = at;
    } else {
      s = new Jolt.SwingTwistConstraintSettings();
      s.mSpace = Jolt.EConstraintSpace_WorldSpace;
      s.mPosition1 = at; s.mPosition2 = at;
      // Twist axis = each body's OWN up, plane axis its own forward: zero = straight behind,
      // whatever angle they coupled at. Twist = yaw; the cones = pitch / roll.
      const axis = (x, y, z, q) => { const w = new THREE.Vector3(x, y, z).applyQuaternion(q); return new Jolt.Vec3(w.x, w.y, w.z); };
      s.mTwistAxis1 = axis(0, 1, 0, this._tq); s.mPlaneAxis1 = axis(0, 0, 1, this._tq);
      s.mTwistAxis2 = axis(0, 1, 0, this._quat); s.mPlaneAxis2 = axis(0, 0, 1, this._quat);
      s.mTwistMinAngle = -o.constraint.yaw; s.mTwistMaxAngle = o.constraint.yaw;
      s.mNormalHalfConeAngle = o.constraint.tilt; s.mPlaneHalfConeAngle = o.constraint.tilt;
    }
    this.joint = s.Create(this.tractor.body, this.body);
    this.world.physicsSystem.AddConstraint(this.joint);
    Jolt.destroy(at);
    this.tractor.towing = true; // its park pin must not ratchet the suspension down under the drawbar
    this.bi.SetShape(this.bodyId, this.#shape(false), false, Jolt.EActivation_Activate); // fresh shape per swap
    this._frozen = false; this._still = 0; this._pending = 0;
    this.#readPose(this._prevPos, this._prevQuat);
    return true;
  }

  detach() {
    if (!this.joint) return false;
    this.world.physicsSystem.RemoveConstraint(this.joint);
    this.joint = null;
    this.tractor.towing = false;
    this.bi.SetShape(this.bodyId, this.#shape(true), false, this.Jolt.EActivation_Activate);
    return true;
  }

  /** Once per fixed step, before the world steps. env: { groundSolidAt(x, z) -> bool } (a
   *  detached trailer is held asleep where no collider exists, or it falls through). */
  update(dt, env = {}) {
    const { o, bi } = this, t = this.tractor;
    this.#readPose(this._prevPos, this._prevQuat);
    this._prevSpin = this._spin;
    for (let i = 0; i < this.wheelDefs.length; i++) this._prevSusp[i] = this.constraint.GetWheel(i).GetSuspensionLength();

    const solid = env.groundSolidAt ? env.groundSolidAt(this._prevPos.x, this._prevPos.z) : true;
    if (!this.joint) {
      if (!solid) {
        if (!this._frozen || this.body.IsActive()) {
          this._v.Set(0, 0, 0); bi.SetLinearAndAngularVelocity(this.bodyId, this._v, this._v);
          bi.DeactivateBody(this.bodyId); this._frozen = true;
        }
      } else if (this._frozen) { this._frozen = false; bi.ActivateBody(this.bodyId); } // settle once, then it sleeps
    }
    if (this._pending > 0 && !this.joint) { this._pending--; if (this.attach()) this._pending = 0; }

    if (this.joint && this.#ball(this._a).distanceTo(this.#couplerWorld(this._b)) > o.teleportGap) this.detach();
    if (this.joint) {
      // Sleep with the parked tractor after N still steps (at once freezes it mid-settle), wake with it.
      const lv = this.body.GetLinearVelocity();
      const still = !t.body.IsActive() && Math.hypot(lv.GetX(), lv.GetY(), lv.GetZ()) < 0.05;
      this._still = still ? this._still + 1 : 0;
      if (still) { if (this.body.IsActive() && this._still > o.sleepAfterSteps) bi.DeactivateBody(this.bodyId); }
      else if (t.body.IsActive() && !this.body.IsActive()) bi.ActivateBody(this.bodyId);
    }
    let brake = 0;
    const v = t.fwdSpeed || 0;
    if (this.joint && o.overrun) {
      const a = (v - this._tractorV) / dt;
      if (v > 1) brake = Math.min(1, Math.max(0, (-a - o.overrunStart) / o.overrunRange));
    }
    this._tractorV = v;
    this._brake += (brake - this._brake) * o.brakeEase;
    // Attached: free-rolling (but for the overrun brake). Detached: parking brake on, no wake-up.
    this.controller.SetDriverInput(0, 0, this._brake > 0.01 ? this._brake : 0, this.joint ? 0 : 1);
  }

  /** Render pose: object3D = blended body pose; wheels = [axle] (one pivot for the pair: rides the
   *  mean suspension, tilts with the difference, spins with the mean angle) or one object per wheel. */
  applyPoseTo(object3D, wheels = [], alpha = 1) {
    this.#readPose(this._pos, this._quat);
    if (object3D) {
      object3D.position.lerpVectors(this._prevPos, this._pos, alpha);
      object3D.quaternion.slerpQuaternions(this._prevQuat, this._quat, alpha);
    }
    if (!wheels.length) return;
    const lerp = (a, b) => a + (b - a) * alpha;
    const n = this.wheelDefs.length, s = [];
    let angle = 0;
    for (let i = 0; i < n; i++) {
      const jw = this.constraint.GetWheel(i);
      s.push(lerp(this._prevSusp[i], jw.GetSuspensionLength()));
      angle += jw.GetRotationAngle() / n;
    }
    this._spin = angle;
    let d = this._spin - this._prevSpin; // Jolt wraps the angle at 2 pi: blend the short way
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    const spin = this._prevSpin + d * alpha;
    if (wheels.length === 1 && n >= 2) { // axle pivot, in the trailer's local frame
      const mean = s.reduce((x, y) => x + y, 0) / n;
      wheels[0].position.set(0, this.o.axleY + (this.suspRest - mean), this.wheelDefs[0].z);
      wheels[0].rotation.set(spin, 0, Math.atan2(s[1] - s[0], this.wheelDefs[0].x - this.wheelDefs[1].x), 'ZXY');
      return;
    }
    for (let i = 0; i < n && i < wheels.length; i++) { // per wheel, local frame
      const w = this.wheelDefs[i];
      wheels[i].position.set(w.x, this.o.axleY + (this.suspRest - s[i]), w.z);
      wheels[i].rotation.set(spin, 0, 0);
    }
  }

  /** Plain object for a save file. */
  save() {
    this.#readPose(this._pos, this._quat);
    const r = (v, d) => +v.toFixed(d);
    return { x: r(this._pos.x, 3), y: r(this._pos.y, 3), z: r(this._pos.z, 3), qx: r(this._quat.x, 5), qy: r(this._quat.y, 5), qz: r(this._quat.z, 5), qw: r(this._quat.w, 5), attached: this.attached };
  }

  /** Back to a saved pose, held asleep until its ground is solid; re-seated if the ground moved.
   *  attached: true keeps trying attach() for pendingAttachSteps updates (the tractor's terrain
   *  may still be streaming). false on a malformed state. */
  restore(state, heightAt = null) {
    if (![state?.x, state?.y, state?.z, state?.qx, state?.qy, state?.qz, state?.qw].every(Number.isFinite)) return false;
    const { Jolt, bi } = this;
    this.detach();
    const g = heightAt ? heightAt(state.x, state.z) : state.y;
    const y = (state.y < g - 0.3 || state.y > g + 6) ? g + this.o.parkClearance : state.y;
    const p = new Jolt.RVec3(state.x, y, state.z), q = new Jolt.Quat(state.qx, state.qy, state.qz, state.qw);
    bi.SetPositionAndRotation(this.bodyId, p, q, Jolt.EActivation_DontActivate);
    this._v.Set(0, 0, 0); bi.SetLinearAndAngularVelocity(this.bodyId, this._v, this._v);
    Jolt.destroy(p); Jolt.destroy(q);
    this._frozen = true;
    this._pending = state.attached ? this.o.pendingAttachSteps : 0;
    this.#readPose(this._prevPos, this._prevQuat);
    return true;
  }

  dispose() {
    this.detach();
    this.world.physicsSystem.RemoveStepListener(this.stepListener);
    this.world.physicsSystem.RemoveConstraint(this.constraint);
    this.world.removeBody(this.body);
    this.Jolt.destroy(this._v);
  }
}
