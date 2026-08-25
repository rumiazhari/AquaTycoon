import type { BasinGeometry } from './Geometry';
import { defaultGeometryFor } from './Geometry';

/**
 * UnitBlueprint — the new core data model (Prompt §B/C).
 *
 * Six explicit layers replace the old mixed customParams blob:
 *   1. PROCESS FAMILY   — processType (template identity)
 *   2. PHYSICAL DESIGN  — geometry + construction material
 *   3. INSTALLED EQUIPMENT — blowers/diffusers/pumps selections + redundancy
 *   4. OPERATOR CONTROLS   — setpoints/commands (what the operator asks for)
 *   5. CURRENT STATE       — runtime (what physics actually produces)
 *   6. ASSET CONDITION     — wear/fouling/hours (evolves in operation)
 *
 * DESIGN ≠ CONTROL ≠ RUNTIME is enforced structurally: the simulator may never
 * copy a setpoint into runtime unless its physics can actually hold it.
 */

// ── Layer 2: physical design ─────────────────────────────────────────────────

export interface PhysicalDesign {
  geometry: BasinGeometry;
  materialId: string; // CONSTRUCTION_MATERIALS key
}

// ── Layer 3: installed equipment (per process family) ────────────────────────

export interface CASDesign {
  /** Aeration design parameters. */
  diffuserModelId: string;
  diffuserCount: number;
  blowerModelId: string;
  blowerRedundancyId: string;
  designMlssMgL: number;
  targetSRTDays: number;
}

export interface PumpingDesign {
  pumpModelId: string;
  redundancyId: string;
  staticLiftM: number;
}

export type EquipmentSpec = CASDesign | PumpingDesign;

// ── Layer 4: operator controls ───────────────────────────────────────────────

export interface OperatorControls {
  /** CAS */
  doSetpointMgL?: number;
  wasRateM3d?: number;      // sludge wasting rate
  rasRecyclePercent?: number;
  /** Equalization outflow control. */
  eqOutflowTargetM3h?: number;
  /** Pump speed command 0..1 (VFD pumps only; fixed-speed ignores). */
  pumpSpeedCommand?: number;
}

// ── Layer 6: asset condition ─────────────────────────────────────────────────

export interface AssetCondition {
  /** 1 = new, →0 = end of life. Generic wear index. */
  conditionIndex: number;
  operatingHours: number;
  diffuserFoulingFactor: number; // 1 clean → 0.7 fouled
  lastMaintenanceDay: number;
  nextServiceDay: number;
}

// ── Layer 5 placeholders (runtime lives on PlacedUnit.runtime) ───────────────

/** Commissioning progression for biological reactors (Prompt §H). */
export type CommissioningPhase =
  | 'empty'
  | 'fill'
  | 'seed'
  | 'startup'
  | 'developing'
  | 'nitrification_establishing'
  | 'stable';

export interface CommissioningState {
  phase: CommissioningPhase;
  daysInPhase: number;
  seededWithSludge: boolean;
}

export function freshCommissioning(): CommissioningState {
  return { phase: 'empty', daysInPhase: 0, seededWithSludge: false };
}

// ── The blueprint itself ─────────────────────────────────────────────────────

export interface UnitBlueprint {
  processType: string; // UnitTypeId of the source template
  label: string;
  design: PhysicalDesign;
  equipment: EquipmentSpec;
  controls: OperatorControls;
}

export const DEFAULT_CAS_DESIGN: CASDesign = {
  diffuserModelId: 'coarse_bubble',
  diffuserCount: 120,
  blowerModelId: 'rotary_lobe_1500',
  blowerRedundancyId: 'single_100',
  designMlssMgL: 3200,
  targetSRTDays: 12,
};

export const DEFAULT_PUMPING_DESIGN: PumpingDesign = {
  pumpModelId: 'sewage_wedge_400',
  redundancyId: 'single_100',
  staticLiftM: 3.5,
};

/** Blueprint factory from an existing template id (Prompt §C). */
export function blueprintFromTemplate(typeId: string): UnitBlueprint | null {
  const geometry = defaultGeometryFor(typeId);
  if (!geometry) return null;
  switch (typeId) {
    case 'activated_sludge_cas':
      return {
        processType: typeId, label: 'Conventional Activated Sludge — Municipal Default',
        design: { geometry, materialId: 'reinforced_concrete' },
        equipment: { ...DEFAULT_CAS_DESIGN }, controls: {
          doSetpointMgL: 2.0, wasRateM3d: 60, rasRecyclePercent: 75,
        },
      };
    case 'secondary_clarifier':
      return {
        processType: typeId, label: 'Secondary Clarifier — Standard',
        design: { geometry, materialId: 'reinforced_concrete' },
        equipment: { ...DEFAULT_PUMPING_DESIGN, staticLiftM: 1.2 },
        controls: { rasRecyclePercent: 75, wasRateM3d: 60 },
      };
    case 'equalization_basin':
      return {
        processType: typeId, label: 'Equalization Basin — Municipal',
        design: { geometry, materialId: 'reinforced_concrete' },
        equipment: { ...DEFAULT_PUMPING_DESIGN, staticLiftM: 2.5 },
        controls: { eqOutflowTargetM3h: 160 },
      };
    case 'pump_station':
      return {
        processType: typeId, label: 'Pump Station — Sewage Duty',
        design: { geometry, materialId: 'reinforced_concrete' },
        equipment: { ...DEFAULT_PUMPING_DESIGN },
        controls: { pumpSpeedCommand: 1.0 },
      };
    default:
      return null;
  }
}
