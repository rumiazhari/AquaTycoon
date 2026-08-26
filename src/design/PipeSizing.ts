/**
 * Pipe sizing (Mission §AK items 7/8) — turns raw PipeConnection payloads into
 * ENGINEERED pipes: a standard nominal-diameter ladder, per-service default
 * materials, and a per-tick hydraulics refresh that keeps cachedHydraulics and
 * auto-sized diameters honest against OBSERVED flow.
 *
 * Design rules:
 *  - AUTO sizing picks the smallest standard DN whose MEAN velocity at the
 *    observed daily volume stays ≤ AUTO_TARGET_VELOCITY_MS (1.2 m/s).
 *  - Player-picked diameters flip autoSized=false and are NEVER overridden.
 *  - Gas lines carry no liquid hydraulics and are skipped entirely.
 *
 * All functions here are PURE except refreshPipeHydraulics, which mutates the
 * pipe array it is given — mirroring how SimulationEngine already updates
 * pipe.flowRate in place each tick.
 */

import type { PipeConnection } from '../types/simulation';
import { pathLengthM, evaluatePipeHydraulics } from '../sim/hydraulics/PipeHydraulics';

/** Standard nominal diameters (m), DN80 … DN1200. */
export const STANDARD_DIAMETERS_M: readonly number[] = [
  0.08, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2,
];

/** Mean-velocity target for automatic sizing (m/s). */
export const AUTO_TARGET_VELOCITY_MS = 1.2;

/** Below this observed flow (m³/d) auto-sizing stays idle — noise guard. */
export const AUTOSIZE_MIN_FLOW_M3D = 20;

/**
 * Smallest standard diameter whose mean velocity at `qM3Day` stays within the
 * auto-sizing target. Undefined below the noise floor; clamps to the largest
 * ladder entry beyond DN1200 rather than inventing fantasy diameters.
 */
export function recommendDiameterM(qM3Day: number): number | undefined {
  if (!Number.isFinite(qM3Day) || qM3Day <= AUTOSIZE_MIN_FLOW_M3D) return undefined;
  const qM3s = qM3Day / 86400;
  const dMin = Math.sqrt((4 * qM3s) / (Math.PI * AUTO_TARGET_VELOCITY_MS));
  for (const d of STANDARD_DIAMETERS_M) {
    if (d >= dMin) return d;
  }
  return STANDARD_DIAMETERS_M[STANDARD_DIAMETERS_M.length - 1];
}

/** Sensible construction material per service (PIPE_MATERIALS keys). */
export function defaultMaterialForPipeType(pipeType: PipeConnection['pipeType']): string {
  switch (pipeType) {
    case 'sludge':
    case 'ras':
      return 'hdpe'; // abrasion + corrosion resistance for sludge duty
    case 'gas':
      return 'carbon_steel'; // pressurised air/biogas service
    case 'chemical':
      return 'pvc';
    default:
      return 'pvc'; // liquid / recycle process water
  }
}

/**
 * Per-tick refresh, called by SimulationEngine AFTER the relaxation loop so it
 * sees converged flows:
 *  1. auto-sized pipes re-pick their DN from the ladder if observed flow moved
 *     them into a different band (discrete ladder ⇒ changes are rare/stable);
 *  2. every sized pipe gets cachedHydraulics recomputed (length, velocity,
 *     headloss) so UI + validators never read stale numbers.
 * Legacy unsized pipes (no diameterM/autoSized) are left completely alone —
 * backward compatibility with existing saves and tests is preserved.
 */
export function refreshPipeHydraulics(pipes: PipeConnection[]): void {
  for (const pipe of pipes) {
    if (pipe.pipeType === 'gas') continue;
    const q = Number.isFinite(pipe.flowRate) && pipe.flowRate > 0 ? pipe.flowRate : 0;

    if (pipe.autoSized) {
      const want = recommendDiameterM(q);
      if (want !== undefined && want !== pipe.diameterM) pipe.diameterM = want;
    }

    if (pipe.diameterM === undefined) continue;
    const lengthM = pathLengthM(pipe.pathPoints);
    const h = evaluatePipeHydraulics(pipe.diameterM, pipe.materialId, lengthM, q);
    pipe.cachedHydraulics = {
      lengthM,
      velocityMs: h.velocityMs,
      headlossM: h.totalHeadlossM,
    };
  }
}
