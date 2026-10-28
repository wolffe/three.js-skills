// Keyboard actions + pointer look for a character controller. Browser DOM only.
// Edge presses persist until endFrame(), so every system sees the same press.

export const defaultActions = () => ({
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC'],
  interact: ['KeyE'],
  secondary: ['KeyF'],
  tertiary: ['KeyG'],
});

/** @param {string} code */
export const codeLabel = (code) =>
  code.startsWith('Key') ? code.slice(3) : code.startsWith('Digit') ? code.slice(5)
    : code.startsWith('Shift') ? 'Shift' : code;

/**
 * @param {HTMLElement | null} canvas  element that receives pointer events (null = keyboard only)
 * @param {{ actions?: Record<string, string[]>, onLateUpdate?: (fn: () => void) => void }} [opts]
 *   onLateUpdate: optional host hook that runs after all frame updates; otherwise call endFrame().
 */
export const createCharacterInput = (canvas = null, opts = {}) => {
  const actions = opts.actions ?? defaultActions();
  const keysDown = new Set();
  const pressed = new Set();
  const buttons = new Set();
  const look = { dx: 0, dy: 0 };
  const turn = { dx: 0, dy: 0 };
  let dragging = false, lastX = 0, lastY = 0, pointerLocked = false, wheel = 0;
  /** @type {'drag' | 'capture'} */
  let lookMode = 'drag';

  const cursor = () => {
    if (!canvas) return;
    canvas.classList.remove('look-drag', 'look-capture');
    if (lookMode === 'drag') canvas.classList.add('look-drag');
    else if (pointerLocked) canvas.classList.add('look-capture');
  };
  const requestCapture = () => {
    if (!canvas || lookMode !== 'capture') return;
    const r = canvas.requestPointerLock?.();
    if (r?.catch) r.catch(() => {}); // refusal is fine; drag still works
  };
  const addDelta = (target, e) => {
    if (pointerLocked) { target.dx += e.movementX; target.dy += e.movementY; return; }
    target.dx += e.clientX - lastX; target.dy += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
  };

  const onKeyDown = (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    pressed.add(e.code);
    keysDown.add(e.code);
  };
  const onKeyUp = (e) => keysDown.delete(e.code);
  const onPointerDown = (e) => {
    buttons.add(e.button);
    lastX = e.clientX; lastY = e.clientY;
    if (e.button === 0) { if (lookMode === 'capture') requestCapture(); else dragging = true; }
  };
  const onPointerUp = (e) => { buttons.delete(e.button); if (e.button === 0) dragging = false; };
  const onPointerMove = (e) => {
    if (buttons.has(2)) { addDelta(turn, e); return; }
    if (lookMode === 'capture' && pointerLocked) { addDelta(look, e); return; }
    if (lookMode === 'drag' && dragging) addDelta(look, e);
  };
  const onLockChange = () => {
    pointerLocked = document.pointerLockElement === canvas;
    if (!pointerLocked) dragging = false;
    cursor();
  };
  const onWheel = (e) => { wheel += Math.sign(e.deltaY); };
  const onContextMenu = (e) => e.preventDefault();
  const reset = () => {
    keysDown.clear(); pressed.clear(); buttons.clear();
    dragging = false; wheel = 0;
    look.dx = look.dy = turn.dx = turn.dy = 0;
  };

  window.addEventListener('blur', reset);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('pointerlockchange', onLockChange);
  if (canvas) {
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('contextmenu', onContextMenu);
    cursor();
  }

  const any = (set, action) => {
    const codes = actions[action];
    if (!codes) return false;
    for (const c of codes) if (set.has(c)) return true;
    return false;
  };
  const lookOut = { dx: 0, dy: 0 }, turnOut = { dx: 0, dy: 0 }, move = { x: 0, z: 0 };
  const consume = (pair, out) => { out.dx = pair.dx; out.dy = pair.dy; pair.dx = pair.dy = 0; return out; };
  const endFrame = () => { pressed.clear(); wheel = 0; };
  opts.onLateUpdate?.(endFrame);

  return {
    actions,
    isAction: (a) => any(keysDown, a),
    wasPressed: (a) => any(pressed, a),
    wasCodePressed: (code) => pressed.has(code),
    isMouseDown: (b) => buttons.has(b),
    /** -1/0/1 axes, x right, z back (forward is -z). Shared object. */
    getMove() {
      move.x = (any(keysDown, 'moveRight') ? 1 : 0) - (any(keysDown, 'moveLeft') ? 1 : 0);
      move.z = (any(keysDown, 'moveBack') ? 1 : 0) - (any(keysDown, 'moveForward') ? 1 : 0);
      return move;
    },
    consumeMouseDelta: () => consume(look, lookOut),
    consumeTurnDelta: () => consume(turn, turnOut),
    consumeWheel() { const w = wheel; wheel = 0; return w; },
    get lookMode() { return lookMode; },
    get dragging() { return dragging; },
    setLookMode(mode) {
      lookMode = mode === 'capture' ? 'capture' : 'drag';
      dragging = false; buttons.clear();
      look.dx = look.dy = turn.dx = turn.dy = 0;
      if (lookMode === 'drag') document.exitPointerLock?.();
      cursor();
    },
    /** Call after all updates each frame unless onLateUpdate was supplied. */
    endFrame,
    dispose() {
      reset();
      if (canvas && document.pointerLockElement === canvas) document.exitPointerLock?.();
      canvas?.classList.remove('look-drag', 'look-capture');
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('wheel', onWheel);
      document.removeEventListener('pointerlockchange', onLockChange);
      canvas?.removeEventListener('pointerdown', onPointerDown);
      canvas?.removeEventListener('contextmenu', onContextMenu);
    },
  };
};
