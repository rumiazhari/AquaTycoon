/**
 * Pumping (Prompt §M) — equipment-based pump stations.
 *
 * The station finds its ACTUAL duty point from the pump curve intersected
 * with a system curve built from static lift + downstream pipe headloss.
 * Undersized pumps cannot deliver peak flow; oversized pumps waste energy
 * operating far from BEP; VFDs reshape the pump curve by affinity laws.
 */

import type { PlacedUnit } from '../../types/simulation';
import { PUMP_MODELS, REDUNDANCY_CONFIGS } from '../../design/catalogs/Equipment';
import { findPumpDutyPoint, systemCurveK } from '../hydraulics/PipeHydraulics';

export interface PumpStationResult {
  /** Flow actually delivered through the station (m³/d averaged). */
  deliveredFlowM3d: number;
  /** Requested flow (what upstream sends). */
  demandedFlowM3d: number;
  electricalPowerKw: number;
  dutyFlowM3h: number;
  dutyHeadM: number;
  bepFraction: number; // duty flow / rated flow — near 1 is efficient
  cavitating: boolean;
  failedUnitCount: number;
  status: 'ok' | 'undersized' | 'oversized' | 'no_duty_point' | 'failed_unit';
}

/**
 * Evaluate one tick of pump-station operation.
 *
 * @param unit placed pump_station with blueprint + pumping design
 * @param demandedFlowM3d incoming flow rate
 * @param pipeHeadlossAtDemandM friction/minor loss of the discharge run at
 *        the demanded flow (0 when no sized pipe installed)
 */
export function stepPumpStation(
  unit: PlacedUnit,
  demandedFlowM3d: number,
  pipeHeadlossAtDemandM: number,
  speedCommand: number = 1.0
): PumpStationResult {
  const bp = unit.blueprint;
  const design = bp?.equipment as import('../../design/UnitBlueprint').PumpingDesign | undefined;
  const model = PUMP_MODELS[design?.pumpModelId ?? 'sewage_wedge_400'];
  const red = REDUNDANCY_CONFIGS[design?.redundancyId ?? 'single_100'];
  const staticLift = design?.staticLiftM ?? 3.5;

  const demandedM3h = Math.max(0, demandedFlowM3d) / 24;

  // Seeded deterministic failure state (reliability layer §O): condition index
  // below threshold disables one unit (the first).
  const cond = unit.condition?.conditionIndex ?? 1;
  const failedUnits = cond < 0.15 ? Math.min(1, red.unitCount - (red.capacityWithOneDown > 0 ? 1 : 0)) : 0;
  const availableCapacityFrac =
    failedUnits > 0 ? red.capacityWithOneDown / red.unitCount : 1;

  // System curve anchored at the demanded flow's pipe losses.
  const Ksys = systemCurveK(Math.max(0.2, pipeHeadlossAtDemandM), Math.max(1, demandedM3h));

  const duty = findPumpDutyPoint(model, staticLift, Ksys, speedCommand);

  if (!duty.ok) {
    return {
      deliveredFlowM3d: 0,
      demandedFlowM3d,
      electricalPowerKw: duty.electricalPowerKw,
      dutyFlowM3h: 0, dutyHeadM: duty.headM, bepFraction: 0,
      cavitating: false, failedUnitCount: failedUnits,
      status: 'no_duty_point',
    };
  }

  // Capacity limit: rated flow × available units × failure derate. The duty
  // point is what the pump WOULD deliver; the station delivers min(duty,
  // capacity, demand).
  const maxDeliverableM3h = model.ratedFlowM3h * red.unitCount * availableCapacityFrac;
  const finalM3h = Math.max(0, Math.min(maxDeliverableM3h, duty.flowM3h, demandedM3h));

  const bepFraction = finalM3h / model.ratedFlowM3h;
  // Power scales with the flow actually pumped across running units.
  const electricalKw =
    duty.electricalPowerKw *
    (finalM3h / Math.max(1e-6, duty.flowM3h)) *
    ((red.unitCount - failedUnits) / red.unitCount);

  // Suction risk: high flow → high NPSH required vs typical 6 m available.
  const cavitating = bepFraction > 1.25 || (bepFraction > 1.1 && model.npshRequiredM > 5.5);

  let status: PumpStationResult['status'] = 'ok';
  if (failedUnits > 0) status = 'failed_unit';
  else if (maxDeliverableM3h < demandedM3h * 0.98) status = 'undersized';
  else if (bepFraction < 0.4 && demandedM3h > 0) status = 'oversized';

  return {
    deliveredFlowM3d: finalM3h * 24,
    demandedFlowM3d,
    electricalPowerKw: electricalKw,
    dutyFlowM3h: finalM3h,
    dutyHeadM: duty.headM,
    bepFraction,
    cavitating,
    failedUnitCount: failedUnits,
    status,
  };
}
