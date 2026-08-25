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

export interface EqStepResult {
  /** Mixed-tank discharge for this step (m³/d averaged over dt). */
  outflowM3d: number;
  /** Tank effluent concentration = fully-mixed tank contents. */
  effluent: WaterQuality;
  overflowed: boolean;
  overflowM3d: number;
  storedVolumeM3: number;
  levelFraction: number;
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
  // Pump-controlled outflow: target rate, limited by available storage.
  const maxOut = (outflowTargetM3h ?? 160) * 24;
  let qOut = Math.min(maxOut, qIn + storage.storedVolumeM3 / Math.max(dtDays, 1e-6));

  let overflowM3d = 0;

  if (storage.storedVolumeM3 < 1e-6 && qIn <= qOut) {
    // Empty tank passing through: still mix a slug (short-circuit ~ HRT≈0).
    storage = initEqStorage();
    return {
      outflowM3d: qIn,
      effluent: { ...inlet },
      overflowed: false,
      overflowM3d: 0,
      storedVolumeM3: 0,
      levelFraction: 0,
    };
  }

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

  // Mass balance per constituent. pH is NOT mass-conserving — blend toward
  // tank value weighted by flows; DO relaxes toward saturation in storage.
  const M = storage.constituentMassKg;
  for (const key of CONSTITUENT_KEYS) {
    if (key === 'ph') continue;
    const cin = Number(inlet[key]) || 0;
    const massInKgDay = (qIn * cin) / 1000; // mg/L × m³ → kg via /1000
    const ctank = storage.storedVolumeM3 > 0.01 ? (M[key] ?? 0) / storage.storedVolumeM3 * 1000 : 0;
    const massOutKgDay = (qOut * ctank) / 1000;
    M[key] = Math.max(0, (M[key] ?? 0) + (massInKgDay - massOutKgDay) * dtDays);
  }

  // Tank concentrations for output stream.
  const V = Math.max(1e-6, storage.storedVolumeM3);
  const eff: WaterQuality = { ...inlet };
  for (const key of CONSTITUENT_KEYS) {
    if (key === 'ph' || key === 'flowRate') continue;
    (eff as any)[key] = storage.storedVolumeM3 > 0.01 ? (M[key] / V) * 1000 : 0;
  }
  // pH blends toward tank history (weak buffering); DO decays in storage.
  const prevPhStored = M['ph'] ?? 7.2;
  const blendedPh = storage.storedVolumeM3 > 0.01
    ? prevPhStored * 0.7 + ((Number(inlet.ph)) * qIn * dtDays) / Math.max(1e-6, storage.storedVolumeM3) * 0.3
    : inlet.ph;
  M['ph'] = blendedPh;
  eff.ph = blendedPh;
  eff.do = Math.max(0.2, (eff.do ?? 0) - 0.4);
  eff.flowRate = qOut;

  return {
    outflowM3d: qOut,
    effluent: eff,
    overflowed: overflowM3d > 0.01,
    overflowM3d,
    storedVolumeM3: storage.storedVolumeM3,
    levelFraction: storage.storedVolumeM3 / Math.max(1, capacityM3),
  };
}
