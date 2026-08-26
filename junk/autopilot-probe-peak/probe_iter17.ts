/**
 * Autopilot iter-17 probe — CAS/clarifier design points at the two competing
 * "reference flow" bases (validator magic 5000 vs L1 contract 3500).
 * Quarantine probe per file policy; not part of any suite.
 */
import { casDesignPoint } from '../../src/sim/processes/ActivatedSludge';
import { evaluateClarifierLoad } from '../../src/sim/processes/Clarifier';
import { defaultGeometryFor, workingVolumeM3 } from '../../src/design/Geometry';
import { blueprintFromTemplate } from '../../src/design/UnitBlueprint';
import { PEAK_FLOW_FACTOR, peakLoadFactorForStrength } from '../../src/design/PeakFlow';

function mk(typeId: string): any {
  const bp = blueprintFromTemplate(typeId)!;
  return {
    instanceId: 'u_' + typeId, typeId, gridX: 0, gridY: 0, rotation: 0,
    volume: workingVolumeM3(bp.design.geometry),
    customParams: {}, active: true, efficiencyRating: 100,
    lastInletQuality: {} as any, lastOutletQuality: {} as any,
    lastPowerKwActual: 0, lastOpexActual: 0,
    blueprint: bp,
  };
}

console.log('PEAK_FLOW_FACTOR =', PEAK_FLOW_FACTOR.toFixed(4),
  ' load factor =', peakLoadFactorForStrength(1).toFixed(4));

for (const flow of [3500, 5000]) {
  const dp = casDesignPoint(mk('activated_sludge_cas'), 250, 30, flow)!;
  console.log(
    `CAS @${flow} (BOD250/NH430): margin=${dp.capacityMarginRatio.toFixed(3)}` +
    ` cap=${dp.fieldTransferCapacityKgDay.toFixed(0)}` +
    ` net=${dp.netDemandKgDay.toFixed(0)}` +
    ` peakNeed=${(dp.netDemandKgDay * peakLoadFactorForStrength(1)).toFixed(0)}` +
    ` hrt=${dp.hrtHoursAtDesignFlow.toFixed(2)}h fm=${dp.fmRatioDay.toFixed(3)}/d`);
}

const geo = defaultGeometryFor('secondary_clarifier')!;
for (const flow of [3500, 5000]) {
  const load = evaluateClarifierLoad(geo, flow, 3200, flow * 1.75, 0.25);
  console.log(
    `CLAR @${flow}: area=${load.planAreaM2.toFixed(1)}m² sor=${load.sorM3M2Day.toFixed(2)}` +
    ` peakSor(field 1.8)=${load.peakSorM3M2Day.toFixed(2)}` +
    ` peakSor(shared)=${(load.sorM3M2Day * PEAK_FLOW_FACTOR).toFixed(2)}` +
    ` slr=${load.slrKgM2Day.toFixed(1)} overloaded=${load.overloaded}`);
}
