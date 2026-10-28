// Procedural blocky humanoid: boxes with hip, knee and shoulder joints and a
// three-number animation (speed, grounded, crouch). Three.js 0.186.1 / WebGPU.
import * as THREE from 'three/webgpu';

const STUD = 0.3;
const LIMB_SWING = 0.85;   // rad at run speed
const LIMB_CYCLE = 1.55;   // phase per metre travelled
const TORSO = { w: 2 * STUD, h: 2 * STUD, d: STUD };
const LIMB_W = STUD, LIMB_D = STUD, THIGH_H = STUD, SHIN_H = STUD, HEAD = 1.25 * STUD;
const HIP_Y = THIGH_H + SHIN_H;
const SHOULDER_Y = HIP_Y + TORSO.h;
export const MODEL_HEIGHT = SHOULDER_Y + HEAD;

const flatMat = (hex) => new THREE.MeshStandardNodeMaterial({
  color: hex, flatShading: true, roughness: 1, metalness: 0, fog: true });

/**
 * @param {{ shirt?: number, skin?: number, pants?: number, materials?: { shirt: THREE.Material, skin: THREE.Material, pants: THREE.Material } }} [opts]
 *   Pass `materials` to share one set across many figures (one pipeline).
 */
export const createCharacterModel = (opts = {}) => {
  const mats = opts.materials ?? {
    shirt: flatMat(opts.shirt ?? 0xc45c2a),
    skin: flatMat(opts.skin ?? 0xe8c4a0),
    pants: flatMat(opts.pants ?? 0x2f4f7a),
  };
  const group = new THREE.Group();
  /** @type {Array<{ joint: THREE.Group, restY: number }>} */
  const uppers = [];

  const box = (w, h, d, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  const addUpper = (w, h, d, mat, jx, jy, offsetY) => {
    const joint = new THREE.Group();
    joint.position.set(jx, jy, 0);
    group.add(joint);
    const mesh = box(w, h, d, mat);
    mesh.position.y = offsetY;
    joint.add(mesh);
    const part = { joint, restY: jy };
    uppers.push(part);
    return part;
  };
  const addLeg = (x) => {
    const hip = new THREE.Group();
    hip.position.set(x, HIP_Y, 0);
    group.add(hip);
    const thigh = box(LIMB_W, THIGH_H, LIMB_D, mats.pants);
    thigh.position.y = -THIGH_H / 2;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -THIGH_H;
    hip.add(knee);
    const shin = box(LIMB_W, SHIN_H, LIMB_D, mats.pants);
    shin.position.y = -SHIN_H / 2;
    knee.add(shin);
    return { hip, knee };
  };

  const torso = addUpper(TORSO.w, TORSO.h, TORSO.d, mats.shirt, 0, SHOULDER_Y, -TORSO.h / 2);
  addUpper(HEAD, HEAD, HEAD, mats.skin, 0, SHOULDER_Y, HEAD / 2);
  const armLen = THIGH_H + SHIN_H;
  const armL = addUpper(LIMB_W, armLen, LIMB_D, mats.skin, -(TORSO.w + LIMB_W) / 2, SHOULDER_Y, -armLen / 2);
  const armR = addUpper(LIMB_W, armLen, LIMB_D, mats.skin, (TORSO.w + LIMB_W) / 2, SHOULDER_Y, -armLen / 2);
  const legs = [{ ...addLeg(-LIMB_W / 2), sign: -1 }, { ...addLeg(LIMB_W / 2), sign: 1 }];
  const arms = [{ part: armL, sign: 1 }, { part: armR, sign: -1 }];

  let phase = 0, amp = 0, lift = 0, crouchT = 0;

  const animate = (dt, speed, grounded, runSpeed) => {
    const ease = 1 - Math.exp(-14 * dt);
    amp += ((grounded ? Math.min(1, speed / runSpeed) * LIMB_SWING : 0) - amp) * ease;
    lift += ((grounded ? 0 : -1.1) - lift) * ease;
    phase += speed * LIMB_CYCLE * dt;

    // Crouch pose keeps the feet planted: the body drops by the folded-leg geometry.
    const thighA = -crouchT * 0.62;
    const kneeA = crouchT * 1.15;
    const plantedY = THIGH_H * Math.cos(thighA) + SHIN_H * Math.cos(thighA + kneeA);
    const drop = HIP_Y - plantedY;
    const swing = Math.sin(phase) * amp * (1 - crouchT * 0.3);

    for (const part of uppers) part.joint.position.y = part.restY - drop;
    torso.joint.rotation.x = crouchT * 0.14;
    for (const { part, sign } of arms) part.joint.rotation.x = lift + crouchT * 0.18 + swing * sign;
    for (const { hip, knee, sign } of legs) {
      hip.position.y = plantedY;
      hip.rotation.x = thighA + swing * sign;
      knee.rotation.x = kneeA + Math.max(0, -swing * sign) * 0.45; // trailing foot clears the ground
    }
  };

  return {
    root: group,
    height: MODEL_HEIGHT,
    /** Orbit/look anchor above the feet (chest). */
    anchorHeight: MODEL_HEIGHT * 0.45,
    materials: mats,
    setVisible(v) { group.visible = v; },
    /** Feet on the ground at (x, feetY, z), facing `heading` (radians about +Y). */
    setTransform(feetY, x, z, heading, crouch = 0) {
      group.position.set(x, feetY, z);
      group.rotation.y = heading;
      crouchT = crouch;
    },
    /** @param {number} dt @param {{ speed: number, grounded: boolean, runSpeed: number }} state */
    update(dt, state) { animate(dt, state.speed, state.grounded, state.runSpeed); },
    setColors({ shirt, skin, pants } = {}) {
      if (shirt != null) mats.shirt.color.set(shirt);
      if (skin != null) mats.skin.color.set(skin);
      if (pants != null) mats.pants.color.set(pants);
    },
  };
};
