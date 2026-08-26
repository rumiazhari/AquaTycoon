/**
 * Equalization as REAL dynamic mixed-storage (Prompt §J), replacing the old
 * toxicity-dampening no-op.
 *
 *   V_next = V + (Qin − Qout)·dt
 *   M_next = M + Qin·Cin·dt − Qout·Ctank·dt ,  Ctank = M/V
 *
 * A 1,000 m³ basin buffers far less than an 8,000 m³ one — emergent from the
 * balance, not from arbitrary damping factors. Overflow spills at capacity.
 */

import type { PlacedUnit, WaterQuality } from '../../types/simulation';
import { workingVolumeM3 } from '../../design/Geometry';

const CONSTITUENT_KEYS: Array<keyof WaterQuality> = [
  'bod', 'cod', 'tss', 'tn', 'nh4', 'no3', 'tp', 'pathogens',
  'do', 'ph', 'turbidity', 'toxicIndex',
];

/** Fraction of working volume kept as permanent minimum operating pool
 *  (water below the pump intake). Gives every slug something to blend with,
 *  even when the basin is otherwise empty. 8% ≈ typical dead storage. */
export const EQ_MIN_POOL_FRACTION = 0.08;

export interface EqStepResult {
  /** Mixed-tank discharge for this step (m³/d averaged over dt). */
  outflowM3d: number;
  /** Inflow accepted by the basin this step (m³/d averaged over dt). */
  inflowM3d: number;
  /** Tank effluent concentration = fully-mixed tank contents. */
  effluent: WaterQuality;
  overflowed: boolean;
  overflowM3d: number;
  storedVolumeM3: number;
  levelFraction: number;
  /** Post-step snapshot of stored constituent masses (kg), cloned from tank
   *  state so callers can persist/observe without sharing mutation
   *  (backlog #4). Same keys as WaterQuality minus flowRate; ph is the
   *  blended storage pH, not a mass. */
  constituentMassKg: Record<string, number>;
}

function cloneConstituents(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of CONSTITUENT_KEYS) out[k] = m[k] ?? 0;
  return out;
}

export function initEqStorage(): { storedVolumeM3: number; constituentMassKg: Record<string, number> } {
  return { storedVolumeM3: 0, constituentMassKg: cloneConstituents({}) };
}

/**
 * One storage step. dtDays is the simulation delta; inflow/outflow are m³/d
 * rates held constant across the step (gameplay lumping).
 */
export function stepEqualization(
  unit: PlacedUnit,
  inlet: WaterQuality,
  dtDays: number,
  outflowTargetM3h?: number
): EqStepResult {
  const bp = unit.blueprint!;
  const capacityM3 = workingVolumeM3(bp.design.geometry);
  let storage = unit.eqStorage ?? initEqStorage();

  const qIn = Math.max(0, inlet.flowRate);
  // Pump-controlled outflow: target rate, limited by what is actually
  // available ABOVE the minimum pool (the intake cannot draw the pool itself).
  const poolM3 = capacityM3 * EQ_MIN_POOL_FRACTION;
  const usableAbovePool = Math.max(0, storage.storedVolumeM3 - poolM3);
  const maxOut = (outflowTargetM3h ?? 160) * 24;
  let qOut = Math.min(maxOut, qIn + usableAbovePool / Math.max(dtDays, 1e-6));

  let overflowM3d = 0;

  // Minimum operating pool: a real EQ basin's pump intake sits above the
  // floor, so the basin NEVER pumps bone-dry. This residual volume is always
  // available for blending — a slug entering an "empty" basin still mixes
  // into the pool instead of passing straight through (that raw passthrough
  // was the old mass-balance gap: zero attenuation even for spiked loads).

  // Volume integration with overflow clamp.
  const rawNextV = storage.storedVolumeM3 + (qIn - qOut) * dtDays;
  if (rawNextV > capacityM3) {
    overflowM3d = (rawNextV - capacityM3) / Math.max(dtDays, 1e-6);
    // Spill forces extra outflow (weir overflow carries tank concentrate).
    qOut += overflowM3d;
    storage.storedVolumeM3 = capacityM3;
  } else if (rawNextV < 0) {
    storage.storedVolumeM3 = 0;
    qOut = qIn; // cannot withdraw what never arrived
  } else {
    storage.storedVolumeM3 = rawNextV;
  }

  // Mass balance per constituent — EXACT CSTR integration over the step
  // (dM/dt = qIn·Cin − qOut·M/mixV solved analytically; unconditionally
  // stable, no transient overshoot even when dt exceeds the pool residence
  // time). Concentrations live in mixV = max(stored volume, minimum pool):
  // the pool is real water below the pump intake and dilutes every slug.
  const mixV = Math.max(storage.storedVolumeM3, poolM3);
  const M = storage.constituentMassKg;
  for (const key of CONSTITUENT_KEYS) {
    if (key === 'ph') continue;
    const cin = Number(inlet[key]) || 0;
    const massInKgDay = (qIn * cin) / 1000; // mg/L × m³ → kg via /1000
    if (qOut <= 1e-9 || dtDays <= 1e-9) {
      M[key] = Math.max(0, (M[key] ?? 0) + massInKgDay * dtDays);
    } else {
      const tauDays = mixV / qOut;              // residence time of mixed volume
      const mEquilibriumKg = massInKgDay * tauDays;
      const m0 = Math.max(0, M[key] ?? 0);
      M[key] = Math.max(0, mEquilibriumKg + (m0 - mEquilibriumKg) * Math.exp(-dtDays / tauDays));
    }
  }

  // Tank concentrations for output stream.
  const eff: WaterQuality = { ...inlet };
  for (const key of CONSTITUENT_KEYS) {
    if (key === 'ph' || key === 'flowRate') continue;
    (eff as any)[key] = (M[key] / mixV) * 1000;
  }
  // pH blends toward tank history (weak buffering); DO decays in storage.
  const prevPhStored = M['ph'] ?? 7.2;
  const inletPh = Number.isFinite(inlet.ph) ? inlet.ph : 7.2;
  const blendedPh = prevPhStored * 0.7 + inletPh * 0.3;
  M['ph'] = blendedPh;
  eff.ph = blendedPh;
  eff.do = Math.max(0.2, (eff.do ?? 0) - 0.4);
  eff.flowRate = qOut;

  return {
    outflowM3d: qOut,
    inflowM3d: qIn,
    effluent: eff,
    overflowed: overflowM3d > 0.01,
    overflowM3d,
    storedVolumeM3: storage.storedVolumeM3,
    levelFraction: storage.storedVolumeM3 / Math.max(1, capacityM3),
    // Snapshot (clone) so callers can persist or observe tank load without
    // aliasing the live storage object (backlog #4).
    constituentMassKg: cloneConstituents(storage.constituentMassKg),
  };
}
