// weather-spells.js — CPU weather scheduler: spells, cloud gate, rain OR snow, wetness, ground gusts.
//
// No rendering, no three import. One `snowing` scalar (sky storminess 0..1) eased toward a spell
// target through a cloud gate (the deck closes before the fall starts, opens after it ends); the
// caller's `winter` 0..1 (climate at the viewer) decides whether that spell falls as snow or rain,
// through a thin crossfade, never both. Readouts feed the snow field (snowFieldInput), the sky
// (cloud, bright), wet materials (rainWet) and a ground powder system (powderOpacity, gust).
//
// Usage:
//   import { WeatherSpells } from './weather-spells.js';
//   const spells = new WeatherSpells({ onSpell: (mode) => console.log(mode?.name ?? 'clear') });
//   spells.update(dt, { winter: climateAt(viewer) });   // per frame, before the systems that read it
//   snow.update(dt, camera, spells.snowFieldInput(snow.count));

// Spell characters. intensity = snowing target range, fall = descent m/s, wind = m/s, gust = slow
// wind oscillation amplitude m/s, count = live-flake target, turb = per-flake turbulence 0..~6,
// swing = storm heading wander (rad), bright = may be a high-key whiteout spell.
export const SPELL_MODES = [
  { name: 'calm',   weight: 3, intensity: [0.28, 0.42], fall: 3.0,  wind: 0.5,  gust: 0.4, count: 16_000, turb: 0.0, bright: true },
  { name: 'steady', weight: 3, intensity: [0.50, 0.68], fall: 6.0,  wind: 1.8,  gust: 1.0, count: 32_000, turb: 0.4, bright: true },
  { name: 'storm',  weight: 1, intensity: [0.90, 1.00], fall: 14.0, wind: 16.0, gust: 7.0, count: 64_000, turb: 5.5, swing: 1.4 },
];

export const SPELL_DEFAULTS = {
  modes: SPELL_MODES,
  firstSpell: [25, 70],       // s of calm before the first spell
  spellLength: [90, 270],     // s; long on purpose: the sky must not flip every few minutes
  clearLength: [140, 420],    // s of clear sky between spells
  cloudIn: 30,                // s time constant: the deck closes ~30 s ahead of the fall
  cloudOut: 45,               // s: and opens ~45 s after
  cloudGate: [0.4, 0.85],     // snowing starts at 40 % cover, full by 85 %
  fallRate: 0.12,             // 1/s ease of `snowing` (and `bright`) toward the gated target
  shareBand: [0.45, 0.55],    // winter crossfade rain -> snow; keep it thin
  wetIn: 20,                  // s time constant while rain > rainWet
  dryOut: 45,                 // s drying (180 s left wet ground under a clear sky)
  brightChance: 0.4,          // share of bright-capable spells that are high-key
  powderFloor: 0.32,          // powder opacity with no spell (gusts blow under clear skies)
  powderGain: 0.2,            // + snowing x this
  powderCap: 0.5,
  gustStrength: [6, 14],      // m/s at ground level
  gustLength: [2.5, 5.5],     // s; envelope sin(pi t / dur)
  gustLull: [16, 52],         // s between gusts
  firstGust: [6, 16],
  gustSpread: 1.2,            // rad of heading scatter around the wind
  onSpell: null,              // (mode | null, spells) on spell start / clear
  onEvent: null,              // (phaseName | null, spells) on event phase entry / end
};

const pick = ([a, b]) => a + Math.random() * (b - a);
const ease = (v, target, dt, tau) => v + (target - v) * (1 - Math.exp(-dt / tau));
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class WeatherSpells {
  constructor(options = {}) {
    const o = this.options = { ...SPELL_DEFAULTS, ...options };
    this._total = o.modes.reduce((s, m) => s + m.weight, 0);
    // readouts
    this.snowing = 0;      // sky storminess 0..1 (every climate)
    this.cloud = 0;        // eased deck 0..1, leads snowing
    this.snowShare = 1;    // flakes' share of the spell
    this.rain = 0;         // snowing x (1 - snowShare)
    this.rainWet = 0;      // integrated wetness 0..1
    this.bright = 0;       // eased 0..1 high-key flag
    this.powderOpacity = 0;
    this.gust = null;      // { dir, strength, t, dur } while a ground gust runs
    this.gustEnvelope = 0; // 0..1 swell of the current gust
    this.winter = 1;
    this.mode = null;      // the active spell's mode, null when clear
    // spell character (calm until the first spell)
    const m0 = o.modes[0];
    this.fall = m0.fall; this.wind = m0.wind; this.gustAmp = m0.gust;
    this.turbulence = m0.turb ?? 0; this.count = m0.count;
    this._swing = 0;
    this._baseDir = Math.random() * Math.PI * 2;
    this.windDir = this._baseDir;
    this._phase = Math.random() * 100;
    this._target = 0;
    this._bright = 0;
    this._timer = pick(o.firstSpell);
    this._gustTimer = pick(o.firstGust);
    // generic event (see startEvent)
    this.event = null;
    this.ash = 0;
    this.eventWind = 0;
  }

  /** A storm-character spell is running (thunder, heavier audio beds). */
  get stormy() { return this._target > 0.1 && this.wind >= 8; }

  update(dt, { winter = this.winter } = {}) {
    const o = this.options;
    this.winter = winter;
    if ((this._timer -= dt) <= 0) {
      if (this._target > 0.1) { this._clear(); this._timer = pick(o.clearLength); }
      else { this._begin(this._pickMode()); this._timer = pick(o.spellLength); }
    }
    // Cloud deck first; snowing is gated on it. Never let precipitation lead the sky.
    const spell = this._target > 0.1 ? 1 : 0;
    this.cloud = ease(this.cloud, spell, dt, spell ? o.cloudIn : o.cloudOut);
    const gate = sstep(o.cloudGate[0], o.cloudGate[1], this.cloud);
    this.snowing = ease(this.snowing, this._target * gate, dt, 1 / o.fallRate);
    this.bright = ease(this.bright, this.snowing > 0.1 ? this._bright : 0, dt, 1 / o.fallRate);
    // Rain OR snow: thin crossfade. Never rain = snowing x (1 - winter): it drizzles through snowfall.
    this.snowShare = sstep(o.shareBand[0], o.shareBand[1], winter);
    this.rain = this.snowing * (1 - this.snowShare);
    this.rainWet = ease(this.rainWet, this.rain, dt, this.rain > this.rainWet ? o.wetIn : o.dryOut);
    // Powder has a FLOOR (do not gate on snowfall), capped, x winter (no ground snow, no powder).
    this.powderOpacity = Math.min(o.powderCap, o.powderFloor + this.snowing * o.powderGain) * winter;

    // Ground gusts tick whatever the sky does.
    if ((this._gustTimer -= dt) <= 0 && !this.gust) {
      this.gust = {
        dir: this.windDir + (Math.random() - 0.5) * o.gustSpread,
        strength: pick(o.gustStrength), t: 0, dur: pick(o.gustLength),
      };
      this._gustTimer = pick(o.gustLull);
    }
    this.gustEnvelope = 0;
    if (this.gust) {
      const g = this.gust;
      if ((g.t += dt) >= g.dur) this.gust = null;
      else this.gustEnvelope = Math.sin(Math.PI * g.t / g.dur);
    }
    // Storm heading wanders (two sines); calm/steady hold their heading.
    this._phase += dt;
    if (this._swing > 0) {
      this.windDir = this._baseDir + Math.sin(this._phase * 0.13) * this._swing
        + Math.sin(this._phase * 0.37 + 1.3) * this._swing * 0.5;
    }
    this._updateEvent(dt);
  }

  /** The snow field's per-frame input (blizzard.tsl.js SnowField.update). */
  snowFieldInput(fieldCount) {
    return {
      envelope: Math.min(1, this.snowing * 2.2) * this.snowShare,
      drive: {
        density: Math.min(1, (this.count / Math.max(1, fieldCount)) * Math.min(1, this.snowing * 1.5)),
        fall: this.fall,
        turbulence: Math.min(1, 0.1 + this.turbulence * 0.15),
      },
      wind: { speed: this.wind + this.eventWind, dir: this.windDir, gustAmp: this.gustAmp },
      gust: this.gust,
      ash: this.ash,
      winter: this.winter,
    };
  }

  /** Start a named mode now and hold it until release(). */
  setMode(name) {
    const mode = this.options.modes.find((m) => m.name === name) ?? this.options.modes[0];
    this._begin(mode);
    this._timer = Infinity;
    return mode.name;
  }

  /** Hold the spell target at a value (0 clears), keeping the current character; release() resumes. */
  force(target) {
    this._target = Math.max(0, Math.min(1, target));
    if (this._target <= 0.1) this.mode = null;
    this._timer = Infinity;
  }

  /** Resume the scheduler: the current state runs for `seconds` more. */
  release(seconds = 30) { this._timer = seconds; }

  /**
   * Generic scripted event: phases [{ name, dur, wind: [from, to], ash: [from, to], rate }] run in order.
   * wind (m/s added to the spell wind) and ash (0..1, dark flakes) ramp linearly over each phase and are
   * eased with `rate` (1/s, default 0.4). onEvent(name) fires on each phase entry, onEvent(null) at the end.
   */
  startEvent(phases) {
    this.event = { phases, i: 0, t: 0 };
    this.options.onEvent?.(phases[0].name, this);
  }

  _updateEvent(dt) {
    const e = this.event;
    let wind = 0, ash = 0, rate = 0.4;
    if (e) {
      let p = e.phases[e.i];
      if ((e.t += dt) >= p.dur) {
        e.t = 0;
        if (++e.i >= e.phases.length) { this.event = null; this.options.onEvent?.(null, this); p = null; }
        else { p = e.phases[e.i]; this.options.onEvent?.(p.name, this); }
      }
      if (p) {
        const f = e.t / p.dur, lerp = (r) => (r ? r[0] + (r[1] - r[0]) * f : 0);
        wind = lerp(p.wind); ash = lerp(p.ash); rate = p.rate ?? rate;
      }
    }
    this.eventWind += (wind - this.eventWind) * (1 - Math.exp(-dt * rate));
    this.ash += (ash - this.ash) * (1 - Math.exp(-dt * rate));
  }

  _pickMode() {
    let roll = Math.random() * this._total;
    for (const m of this.options.modes) { roll -= m.weight; if (roll <= 0) return m; }
    return this.options.modes[0];
  }

  _begin(mode) {
    this.mode = mode;
    this._target = pick(mode.intensity);
    this.fall = mode.fall; this.wind = mode.wind; this.gustAmp = mode.gust;
    this.turbulence = mode.turb ?? 0; this.count = mode.count;
    this._swing = mode.swing ?? 0;
    this._baseDir = Math.random() * Math.PI * 2;
    this.windDir = this._baseDir;
    this._bright = mode.bright && Math.random() < this.options.brightChance ? 1 : 0;
    this.options.onSpell?.(mode, this);
  }

  _clear() {
    this._target = 0;
    this.mode = null;
    this.options.onSpell?.(null, this);
  }
}
