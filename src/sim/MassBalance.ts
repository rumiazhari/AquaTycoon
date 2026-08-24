import { WaterQuality } from '../types/simulation';

/**
 * Pollutant mass/load utilities.
 *
 * Concentrations are mg/L; flows are m³/day. Since 1 mg/L × 1 m³ = 1 g,
 * load in kg/day is simply:
 *
 *     load [kg/d] = Q [m³/d] × C [mg/L] / 1000
 */

/** kg/day of a constituent for a stream (Q × C with explicit conversion). */
export function loadKgDay(flowM3Day: number, concMgL: number): number {
  if (!Number.isFinite(flowM3Day) || !Number.isFinite(concMgL)) return 0;
  return Math.max(0, flowM3Day) * Math.max(0, concMgL) / 1000;
}

export interface LoadBreakdown {
  bod: number;   // kg/d
  cod: number;
  tss: number;
  tn: number;
  nh4: number;   // NH4-N
  no3: number;   // NO3-N
  tp: number;
}

/** Full pollutant load breakdown of a stream. */
export function streamLoads(w: WaterQuality): LoadBreakdown {
  const q = Math.max(0, w?.flowRate ?? 0);
  return {
    bod: loadKgDay(q, w.bod),
    cod: loadKgDay(q, w.cod),
    tss: loadKgDay(q, w.tss),
    tn: loadKgDay(q, w.tn),
    nh4: loadKgDay(q, w.nh4),
    no3: loadKgDay(q, w.no3),
    tp: loadKgDay(q, w.tp)
  };
}

/**
 * Relative mass-balance closure error: |Σout − in| / max(in, ε).
 * Tolerance guidance for this game simulation: ≤2% for non-reactive splits
 * (numeric noise only), ≤15% for reactive units where unmodeled side streams
 * (biomass storage, gaseous intermediates) are acceptable abstractions.
 */
export function closureError(massIn: number, massOutTotal: number): number {
  const denom = Math.max(Math.abs(massIn), 1e-6);
  return Math.abs(massOutTotal - massIn) / denom;
}
