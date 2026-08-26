/**
 * PeakFlow — MISSION §AK Phase-1 items 5/6 closure: ONE authoritative
 * peak-flow design basis shared by validators, templates, and tests.
 *
 * Before this module every subsystem guessed its own peak factor: the
 * clarifier model hardcoded 1.8, the CAS audit compared blower capacity
 * against average-day demand only, and equalization sizing had no diurnal
 * storage criterion at all. With the municipal influent curve now running at
 * full strength (DIURNAL_DEFAULT_STRENGTH = 1.0, landed alongside this
 * module), designs are judged against the loads they will actually see:
 *
 *   - Flow swings with the full diurnal curve:   Q_peak = Q̄ · PEAK_FLOW_FACTOR      (≈1.45×)
 *   - Pollutant MASS rides the damped curve:     L_peak = L̄ · PEAK_LOAD_FACTOR      (≈1.25×)
 *
 * All factors derive from InfluentProfile's anchors — change the curve there
 * and every design check follows automatically. Pure functions only.
 */

import {
  DIURNAL_MAX_FACTOR,
  DIURNAL_LOAD_DAMPING,
  diurnalFlowFactor,
} from '../sim/InfluentProfile';

/** Plant-flow peak factor at full diurnal strength (hourly Q vs daily mean). */
export const PEAK_FLOW_FACTOR = DIURNAL_MAX_FACTOR;

/** Pollutant mass-load peak factor at full strength (sewer routing damping). */
export const PEAK_LOAD_FACTOR = 1 + DIURNAL_LOAD_DAMPING * (DIURNAL_MAX_FACTOR - 1);

/** Flow peak factor for an arbitrary strength blend (0 = flat, 1 = municipal). */
export function peakFlowFactorForStrength(strength: number): number {
  return 1 + Math.max(0, strength) * (PEAK_FLOW_FACTOR - 1);
}

/** Mass-load peak factor for an arbitrary strength blend. */
export function peakLoadFactorForStrength(strength: number): number {
  return 1 + Math.max(0, strength) * (PEAK_LOAD_FACTOR - 1);
}

/** Instantaneous peak-hour design flow (m³/d equivalent) from an average day. */
export function peakDesignFlowM3d(avgFlowM3d: number, strength: number = 1): number {
  return avgFlowM3d * peakFlowFactorForStrength(strength);
}

/** Instantaneous peak-hour mass-load-equivalent flow (m³/d of average-strength load). */
export function peakLoadBasisM3d(avgFlowM3d: number, strength: number = 1): number {
  return avgFlowM3d * peakLoadFactorForStrength(strength);
}

/**
 * Storage volume (m³) a perfectly-mixed basin needs to shave the diurnal
 * peaks of an average inflow `avgInM3h` down to a constant pump-out of
 * `outflowTargetM3h`, at the given curve strength. Minute-step deterministic
 * integral of the running surplus max(outflow target − inflow accumulated):
 * the fill-side excursion between trough-drain and morning peak.
 */
export function requiredBalancingVolumeM3(
  avgInM3h: number,
  outflowTargetM3h: number,
  strength: number = 1
): number {
  if (!(avgInM3h > 0) || !(outflowTargetM3h >= 0)) return 0;
  let acc = 0;
  let maxAcc = 0;
  for (let i = 0; i < 1440; i++) {
    const h = i / 60;
    const qIn = avgInM3h * (1 + strength * (diurnalFlowFactor(h) - 1));
    acc += (qIn - outflowTargetM3h) / 60;
    if (acc > maxAcc) maxAcc = acc;
  }
  return Math.max(0, maxAcc);
}
