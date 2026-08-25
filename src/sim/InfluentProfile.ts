import type { WaterQuality } from '../types/simulation';
import { cloneWater } from './WaterStream';

/**
 * InfluentProfile — MISSION §AK PHASE-1 item 14: DYNAMIC INFLUENT.
 *
 * A real treatment plant never receives a constant wastewater flow. Municipal
 * sewers show a classic diurnal pattern (Metcalf & Eddy): a night trough around
 * 04:00–05:00 (~0.55 × average), a sharp morning peak around 09:30–10:30
 * (~1.4–1.5 ×), and a softer evening bump around 19:00–21:00 (~1.2 ×).
 *
 * This module is the ONE authoritative generator of that curve:
 *   - purely deterministic (same game clock ⇒ same influent; no RNG),
 *   - normalized so the 24-h MEAN flow equals the base spec exactly — long-run
 *     treated-volume economics are unchanged; only the intra-day dynamics are
 *     added (§AL: no regression of existing balance),
 *   - pollutant MASS LOADS swing less than flow (sewer routing damps solids/
 *     organics swings), so night sewage reads "stronger" (higher mg/L) and
 *     peak-flow sewage slightly diluted — matching real operator experience.
 *
 * Applied at the game-loop boundary (GameManager.tick); SimulationEngine stays
 * untouched, so every existing suite keeps its exact behavior.
 */

/** [hourOfDay, rawFlowFactor] control points of the municipal diurnal curve. */
const RAW_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.85],
  [4.5, 0.55],   // night trough
  [9.75, 1.50],  // morning peak
  [14.0, 1.02],  // midday lull
  [20.0, 1.25],  // evening bump
  [24.0, 0.85],  // wraps to midnight anchor
];

/**
 * Raised-cosine interpolation between anchors — C¹ continuous, derivative 0 at
 * every anchor (no kinks), trivially deterministic and unit-testable.
 */
function rawFlowFactor(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 0; i < RAW_ANCHORS.length - 1; i++) {
    const [h0, y0] = RAW_ANCHORS[i];
    const [h1, y1] = RAW_ANCHORS[i + 1];
    if (h >= h0 && h <= h1) {
      if (h1 === h0) return y1;
      const t = (h - h0) / (h1 - h0);
      return y0 + (y1 - y0) * (1 - Math.cos(Math.PI * t)) / 2;
    }
  }
  return RAW_ANCHORS[RAW_ANCHORS.length - 1][1];
}

/** Trapezoid mean of the raw curve over one day — used for normalization. */
export const DIURNAL_MEAN_FACTOR: number = (() => {
  const steps = 96;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const w = i === 0 || i === steps ? 0.5 : 1;
    sum += w * rawFlowFactor((i * 24) / steps);
  }
  return sum / steps;
})();

/** Normalized flow factor (24-h mean == 1) — hoisted helper used below. */
function normalizedFlowFactor(hour: number): number {
  return rawFlowFactor(hour) / DIURNAL_MEAN_FACTOR;
}

/** Lowest point of the normalized curve (night trough depth). */
export const DIURNAL_MIN_FACTOR = (() => {
  let m = Infinity;
  for (let i = 0; i <= 96; i++) m = Math.min(m, normalizedFlowFactor(i * 0.25));
  return m;
})();

/** Highest point of the normalized curve (morning peak height). */
export const DIURNAL_MAX_FACTOR = (() => {
  let m = -Infinity;
  for (let i = 0; i <= 96; i++) m = Math.max(m, normalizedFlowFactor(i * 0.25));
  return m;
})();

/** Fraction (0..1) of the flow swing that also shows up in pollutant LOADS. */
export const DIURNAL_LOAD_DAMPING = 0.55;

/** Simulated clock → hour of day [0, 24). gameTimeDays is fractional days. */
export function hourOfDay(gameTimeDays: number): number {
  const h = (gameTimeDays % 1) * 24;
  return h < 0 ? h + 24 : h;
}

/**
 * The authoritative public flow factor for a given hour of day.
 * Guaranteed: min ≈ 0.53 (≈04:30) ≤ f(h) ≤ max ≈ 1.44 (≈10:00), mean(f) = 1.
 */
export function diurnalFlowFactor(hourOfDayValue: number): number {
  return rawFlowFactor(hourOfDayValue) / DIURNAL_MEAN_FACTOR;
}

/** Pollutant load factor paired with a given flow factor. */
export function diurnalLoadFactor(hourOfDayValue: number): number {
  const f = diurnalFlowFactor(hourOfDayValue);
  return 1 + DIURNAL_LOAD_DAMPING * (f - 1);
}

/** Default strength for new games — template trains are average-day designs. */
export const DIURNAL_DEFAULT_STRENGTH = 0.4;

/** Concentration fields that ride the diurnal mass-load/flow ratio. */
const CONCENTRATION_KEYS = [
  'bod', 'cod', 'tss', 'tn', 'nh4', 'no3', 'tp', 'pathogens', 'turbidity',
] as const;

/**
 * Apply the diurnal variation to a base influent spec for the given clock.
 * Returns a NEW object; the input spec is never mutated.
 * DO/pH/temp/toxicity are held at spec values (raw-sewage chemistry is not
 * meaningfully diurnal at this model's resolution; permit criteria stay clean).
 */
export function applyDiurnalInfluent(
  spec: WaterQuality,
  gameTimeDays: number,
  strength: number = 1 // 0 = legacy constant spec, 1 = full municipal curve
): WaterQuality {
  if (!Number.isFinite(gameTimeDays) || strength <= 0) return cloneWater(spec);
  const h = hourOfDay(gameTimeDays);
  const fFull = diurnalFlowFactor(h);
  // Blend toward the identity as strength → 0 (mean stays 1 at any strength).
  const f = 1 + strength * (fFull - 1);
  const m = 1 + strength * DIURNAL_LOAD_DAMPING * (fFull - 1);
  const out = cloneWater(spec);
  out.flowRate = spec.flowRate * f;
  const cRatio = m / f; // concentration scaling (load ÷ flow)
  for (const k of CONCENTRATION_KEYS) {
    out[k] = spec[k] * cRatio;
  }
  return out;
}
