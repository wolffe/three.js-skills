// First-person look and third-person orbit for a walking character.
// Three.js 0.186.1 / WebGPU. Depends on an input object with consumeMouseDelta().
import * as THREE from 'three/webgpu';

/** @param {THREE.PerspectiveCamera} camera @param {{ fov?: number }} [opts] */
export const createCameraManager = (camera, opts = {}) => {
  if (opts.fov != null) camera.fov = opts.fov;
  camera.updateProjectionMatrix();
  /** @type {((camera: THREE.PerspectiveCamera, dt: number) => void) | null} */
  let controller = null;
  return {
    setController(fn) { controller = fn ?? null; },
    update(dt) { controller?.(camera, dt); },
    setFov(fov) {
      if (camera.fov === fov) return;
      camera.fov = fov;
      camera.updateProjectionMatrix();
    },
  };
};

/**
 * Yaw/pitch look. Position is set by the caller from the body.
 * @param {{ sensitivity?: number }} [opts]
 */
export const createFirstPersonCamera = (opts = {}) => {
  const sensitivity = opts.sensitivity ?? 0.002;
  const rotation = { yaw: 0, pitch: 0 };
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  return {
    rotation,
    /** @param {{ consumeMouseDelta: () => { dx: number, dy: number } }} input */
    bind(input, getOpts = () => ({})) {
      return (camera) => {
        const o = getOpts();
        const sens = o.sensitivity ?? sensitivity;
        const { dx, dy } = input.consumeMouseDelta();
        rotation.yaw -= dx * sens;
        rotation.pitch += dy * sens * (o.invertMouse ? 1 : -1);
        rotation.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, rotation.pitch));
        euler.set(rotation.pitch, rotation.yaw, 0);
        camera.quaternion.setFromEuler(euler);
      };
    },
    /** Camera forward on the ground plane, as a model heading (+Z faces this at yaw 0). */
    forwardHeading: () => Math.atan2(-Math.sin(rotation.yaw), -Math.cos(rotation.yaw)),
  };
};

/**
 * Orbit around a smoothed anchor.
 * @param {{ distance?: number, height?: number, sensitivity?: number }} [opts]
 */
export const createThirdPersonCamera = (opts = {}) => {
  const distance = opts.distance ?? 3;
  const height = opts.height ?? 0.5;
  const sensitivity = opts.sensitivity ?? 0.002;
  const orbit = { yaw: 0, pitch: 0.3 };
  const offset = new THREE.Vector3();
  const target = new THREE.Vector3();
  let hasTarget = false;
  return {
    orbit,
    limits: { min: 1.2, max: 14, step: 0.45 },
    /**
     * @param {{ consumeMouseDelta: () => { dx: number, dy: number } }} input
     * @param {() => { x: number, y: number, z: number }} getAnchor  chest-height point on the body
     */
    bind(input, getAnchor, getOpts = () => ({})) {
      hasTarget = false;
      return (camera, dt) => {
        const o = getOpts();
        const dist = o.distance ?? distance;
        const h = o.height ?? height;
        const sens = o.sensitivity ?? sensitivity;
        const { dx, dy } = input.consumeMouseDelta();
        orbit.yaw -= dx * sens;
        orbit.pitch += dy * sens * (o.invertMouse ? -1 : 1);
        orbit.pitch = Math.max(0.1, Math.min(Math.PI / 2 - 0.05, orbit.pitch));

        const a = getAnchor();
        const desiredY = a.y + h;
        if (!hasTarget) { target.set(a.x, desiredY, a.z); hasTarget = true; }
        else {
          const follow = 1 - Math.exp(-16 * dt); // hides physics jitter without felt lag
          target.x += (a.x - target.x) * follow;
          target.y += (desiredY - target.y) * follow;
          target.z += (a.z - target.z) * follow;
        }
        offset.set(
          Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * dist,
          Math.sin(orbit.pitch) * dist,
          Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * dist);
        camera.up.set(0, 1, 0);
        camera.position.copy(target).add(offset);
        camera.lookAt(target);
      };
    },
    /** Put the orbit behind a subject (vehicle, cutscene) looking along its heading. */
    aimBehind(subjectYaw) { orbit.yaw = subjectYaw + Math.PI; orbit.pitch = 0.32; },
    /** Scroll zoom: steps of 0.45 m within 1.2–14 m. Returns the new distance. */
    zoom(current, steps) {
      const { min, max, step } = this.limits;
      return Math.max(min, Math.min(max, current + steps * step));
    },
  };
};

/**
 * Carry the yaw across a view switch so the player keeps their direction.
 * Returns the model heading to use in third person.
 */
export const switchView = (toThirdPerson, fp, tp) => {
  if (toThirdPerson) { tp.orbit.yaw = fp.rotation.yaw; return fp.forwardHeading(); }
  fp.rotation.yaw = tp.orbit.yaw;
  return null;
};
