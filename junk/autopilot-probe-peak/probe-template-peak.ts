/**
 * Probe: template train capacity vs L1 flows at diurnal strength 0.4 vs 1.0.
 * Read-only diagnostics — lives in junk/, never imported by src.
 */
import { blueprintFromTemplate } from '../../src/design/UnitBlueprint';
import { casDesignPoint } from '../../src/sim/processes/ActivatedSludge';
import { planAreaM2, workingVolumeM3 } from '../../src/design/Geometry';
import {
  diurnalFlowFactor, diurnalLoadFactor, DIURNAL_MAX_FACTOR, DIURNAL_MIN_FACTOR,
} from '../../src/sim/InfluentProfile';

// L1 municipal influent (LevelsData level 0)
const Q_AVG = 3500, BOD = 210, NH4 = 25;

const fMax = DIURNAL_MAX_FACTOR;
const fMin = DIURNAL_MIN_FACTOR;
const loadMax = diurnalLoadFactor(9.75); // morning peak hour
console.log(`flow factor max=${fMax.toFixed(3)} min=${fMin.toFixed(3)} | load factor @peak=${loadMax.toFixed(3)}`);

// ── CAS ──
const casBp = blueprintFromTemplate('activated_sludge_cas')!;
const fakeUnit = { blueprint: casBp } as any;
const dpAvg = casDesignPoint(fakeUnit, BOD, NH4, Q_AVG)!;
const dpPeak = casDesignPoint(fakeUnit, BOD, NH4, Q_AVG * loadMax)!; // demand ∝ mass load
console.log('\nCAS template (rotary_lobe_1500, coarse_bubble x120, V=' + workingVolumeM3(casBp.design.geometry) + ' m³):');
console.log(`  avg : fieldCap=${dpAvg.fieldTransferCapacityKgDay.toFixed(0)} netDemand=${dpAvg.netDemandKgDay.toFixed(0)} margin=${dpAvg.capacityMarginRatio.toFixed(2)} HRT=${dpAvg.hrtHoursAtDesignFlow.toFixed(1)}h F/M=${dpAvg.fmRatioDay.toFixed(3)}`);
console.log(`  peak: fieldCap=${dpPeak.fieldTransferCapacityKgDay.toFixed(0)} netDemand=${dpPeak.netDemandKgDay.toFixed(0)} margin=${dpPeak.capacityMarginRatio.toFixed(2)} (demand basis only)`);

// ── Clarifier ──
const clarBp = blueprintFromTemplate('secondary_clarifier')!;
const area = planAreaM2(clarBp.design.geometry);
console.log(`\nClarifier template Ø18x2 area=${area.toFixed(0)} m²: SORavg=${(Q_AVG / area).toFixed(1)} SORpeak=${((Q_AVG * fMax) / area).toFixed(1)} m/d (limits 24 warn / 33 hard)`);

// ── EQ: analytic balancing volume at strengths ──
function balancingVolume(avgM3h: number, strength: number): number {
  let acc = 0, maxAcc = 0;
  for (let i = 0; i <= 1440; i++) {
    const h = i / 60;
    const q = avgM3h * (1 + strength * (diurnalFlowFactor(h) - 1));
    const out = avgM3h; // perfect constant outflow = average
    acc += (q - out) / 60; // m3/h -> per-minute volume
    if (acc > maxAcc) maxAcc = acc;
    // symmetric: also track drawdown need
  }
  return maxAcc;
}
const eqBp = blueprintFromTemplate('equalization_basin')!;
const eqCap = workingVolumeM3(eqBp.design.geometry);
for (const s of [0.4, 1.0]) {
  const need = balancingVolume(Q_AVG / 24, s);
  console.log(`EQ template cap=${eqCap.toFixed(0)} m³: balancing volume @strength ${s} ≈ ${need.toFixed(0)} m³ (${need <= eqCap ? 'OK' : 'UNDERSIZED'})`);
}
