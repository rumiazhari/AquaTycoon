/**
 * Engineering test suite (Prompt §AM) — deterministic verification of the new
 * design/runtime architecture: freeform geometry, CAS O₂ demand vs blower
 * capacity, dynamic MLSS/SRT, clarifier SOR/SLR, equalization mass balance,
 * pipe hydraulics, pump duty points, quantity-based CAPEX, and the PFD branch
 * rendering.
 *
 * Run with: npm run test:eng   (see package.json)
 */

import { emptyWater } from '../src/sim/WaterStream';
import {
  workingVolumeM3,
  planAreaM2,
  footprintCells,
  localPortOffset,
  isEngineerable,
} from '../src/design/Geometry';
import { blueprintFromTemplate } from '../src/design/UnitBlueprint';
import { casDesignPoint, stepCasRuntime } from '../src/sim/processes/ActivatedSludge';
import { evaluateClarifierLoad } from '../src/sim/processes/Clarifier';
import { stepEqualization, initEqStorage } from '../src/sim/processes/Equalization';
import {
  pathLengthM,
  evaluatePipeHydraulics,
  findPumpDutyPoint,
} from '../src/sim/hydraulics/PipeHydraulics';
import {
  estimateStructureCAPEX,
  estimateBlowerCAPEX,
} from '../src/design/CostEstimator';
import { PIPE_MATERIALS, BLOWER_MODELS, PUMP_MODELS } from '../src/design/catalogs/Equipment';
import { resolveTrainTopology } from '../src/ui/TrainTopology';
import type { PlacedUnit, WaterQuality } from '../src/types/simulation';
import { UNIT_DEFINITIONS } from '../src/sim/UnitProcessModels';
import { evaluatePermitCriteria } from '../src/sim/PermitEngine';
import type { TreatmentStandard } from '../src/types/simulation';

// ── tiny assert harness ─────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log('PASS  ' + msg); }
  else { failed++; failures.push(msg); console.error('FAIL  ' + msg); }
}

function mkBlueprintUnit(typeId: string, gridX = 0, gridY = 0): PlacedUnit {
  const bp = blueprintFromTemplate(typeId)!;
  return {
    instanceId: 'u_' + typeId, typeId, gridX, gridY, rotation: 0,
    volume: workingVolumeM3(bp.design.geometry),
    customParams: {}, active: true, efficiencyRating: 100,
    lastInletQuality: emptyWater(), lastOutletQuality: emptyWater(),
    lastPowerKwActual: 0, lastOpexActual: 0,
    blueprint: bp,
  };
}

function wq(over: Partial<WaterQuality>): WaterQuality {
  return { ...emptyWater(), ...over };
}

// ═══════════════════════════════════════════════════════════════════════════
// GEOMETRY
// ═══════════════════════════════════════════════════════════════════════════
{
  const rect = { shape: 'rect' as const, lengthM: 30, widthM: 15, waterDepthM: 4.5, freeboardM: 0.6, wallThicknessM: 0.3, floorThicknessM: 0.25, numberOfParallelTrains: 1 };
  assert(Math.abs(workingVolumeM3(rect) - 30 * 15 * 4.5) < 1e-6, `GEO. rectangular volume = L·W·D = ${workingVolumeM3(rect)} m³`);
  const circ = { shape: 'circular' as const, diameterM: 20, sideWaterDepthM: 4, freeboardM: 0.5, wallThicknessM: 0.25, floorThicknessM: 0.2, numberOfParallelTrains: 1 };
  const expectA = Math.PI * 100;
  assert(Math.abs(planAreaM2(circ) - expectA) < 1e-3, `GEO. circular area = π·D²/4 = ${planAreaM2(circ).toFixed(1)} m²`);
  const circV = expectA * 4;
  assert(Math.abs(workingVolumeM3(circ) - circV) < 1e-3, `GEO. circular volume = A·D = ${workingVolumeM3(circ).toFixed(0)} m³`);
  // rotated footprint swaps dims
  const f0 = footprintCells(rect, 0);
  const f90 = footprintCells(rect, 90);
  assert(f0[0] !== f90[0] || f0[1] !== f90[1], `GEO. rotated footprint changes orientation (0°=[${f0}] 90°=[${f90}])`);
  // port offset lives inside the geometry bounds
  const inlet = localPortOffset(rect, 'inlet')!;
  assert(!!inlet && Math.abs(inlet[0]) < (30 / 6) / 2 + 0.01, `GEO. inlet port within half-length of center (x=${inlet[0].toFixed(2)})`);
  // engineerable set
  assert(isEngineerable('activated_sludge_cas') && !isEngineerable('bar_screen'), 'GEO. engineerable set is the vertical-slice families only');
}

// ═══════════════════════════════════════════════════════════════════════════
// CAS — O2 demand vs blower capacity, dynamic MLSS/SRT, commissioning
// ═══════════════════════════════════════════════════════════════════════════
{
  const u = mkBlueprintUnit('activated_sludge_cas');
  const dp = casDesignPoint(u, 250, 30, 5000)!;
  assert(dp.volumeM3 > 0, `CAS. design point computes volume ${dp.volumeM3.toFixed(0)} m³`);
  assert(dp.hrtHoursAtDesignFlow > 0, `CAS. HRT at design flow = ${dp.hrtHoursAtDesignFlow.toFixed(1)} h`);
  // Bigger tank → larger volume → longer HRT
  const uBig = mkBlueprintUnit('activated_sludge_cas');
  uBig.blueprint!.design.geometry.lengthM = 60;
  const dpBig = casDesignPoint(uBig, 250, 30, 5000)!;
  assert(dpBig.volumeM3 > dp.volumeM3 && dpBig.hrtHoursAtDesignFlow > dp.hrtHoursAtDesignFlow, `CAS. larger basin → larger volume & longer HRT (${dpBig.hrtHoursAtDesignFlow.toFixed(1)} > ${dp.hrtHoursAtDesignFlow.toFixed(1)} h)`);
  // F/M scales inversely with volume
  assert(dpBig.fmRatioDay < dp.fmRatioDay, `CAS. F/M drops with larger reactor (${dpBig.fmRatioDay.toFixed(3)} < ${dp.fmRatioDay.toFixed(3)} d⁻¹)`);

  // Undersized blowers → oxygen-limited at capacity; capacity is fixed by the
  // installed blowers, NOT the DO setpoint.
  const uWeak = mkBlueprintUnit('activated_sludge_cas');
  uWeak.blueprint!.equipment = {
    ...uWeak.blueprint!.equipment,
    blowerModelId: 'rotary_lobe_1500',
    blowerRedundancyId: 'single_100',
    diffuserModelId: 'coarse_bubble',
  } as any;
  // Force a very high demand by raising loading via a tiny basin + high flow.
  uWeak.blueprint!.design.geometry.lengthM = 12;
  uWeak.blueprint!.design.geometry.widthM = 6;
  const dpWeak = casDesignPoint(uWeak, 400, 60, 9000)!;
  assert(dpWeak.capacityMarginRatio < 1, `CAS. undersized aeration is oxygen-limited (margin ${(dpWeak.capacityMarginRatio * 100).toFixed(0)}% < 100%)`);

  // Stronger blowers restore margin → proves capacity (not setpoint) governs.
  const uStrong = mkBlueprintUnit('activated_sludge_cas');
  uStrong.blueprint!.design.geometry.lengthM = 12;
  uStrong.blueprint!.design.geometry.widthM = 6;
  uStrong.blueprint!.equipment = {
    ...uStrong.blueprint!.equipment,
    blowerModelId: 'turbo_6000_vfd',
    blowerRedundancyId: 'duty_standby',
    diffuserModelId: 'fine_bubble_panel',
  } as any;
  const dpStrong = casDesignPoint(uStrong, 400, 60, 9000)!;
  assert(dpStrong.capacityMarginRatio > dpWeak.capacityMarginRatio, `CAS. better blowers raise available O2 (margin ${(dpStrong.capacityMarginRatio * 100).toFixed(0)}% > ${(dpWeak.capacityMarginRatio * 100).toFixed(0)}%)`);

  // Actual DO must NEVER equal the setpoint unless physically possible.
  const uDyn = mkBlueprintUnit('activated_sludge_cas');
  const inlet = wq({ flowRate: 5000, bod: 250, nh4: 30, tss: 150, tn: 50, no3: 5, tp: 8, cod: 600, ph: 7.2, toxicIndex: 5 });
  let commissioning = uDyn.commissioning ?? { phase: 'empty' as const, daysInPhase: 0, seededWithSludge: false };
  let biomass = 0;
  let lastDo = 99;
  for (let i = 0; i < 40; i++) {
    const step = stepCasRuntime(uDyn, {
      inlet: { ...inlet },
      controls: { doSetpointMgL: 2.0, wasRateM3d: 60 },
      dtDays: 1, commissioning, biomassKg: biomass,
    });
    commissioning = step.commissioning;
    biomass = step.newBiomassKg;
    lastDo = step.actualDoMgL;
    // Fresh reactor (empty) must NOT instantly report stable performance.
    if (i < 8) assert(step.commissioning.phase !== 'stable', `CAS. reactor still commissioning at day ${i + 1} (phase=${step.commissioning.phase})`);
  }
  assert(lastDo <= 2.05, `CAS. actual DO (${lastDo.toFixed(2)}) never exceeds setpoint unless physics allows`);
  assert(biomass > 0, `CAS. biomass inventory evolves over time (${biomass.toFixed(0)} kg)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLARIFIER — SOR / SLR / blanket
// ═══════════════════════════════════════════════════════════════════════════
{
  const u = mkBlueprintUnit('secondary_clarifier');
  const load = evaluateClarifierLoad(u.blueprint!.design.geometry, 5000, 3200, 5000 * 1.75, 0.25);
  assert(load.sorM3M2Day > 0, `CLAR. SOR from Q/A = ${load.sorM3M2Day.toFixed(1)} m/d`);
  assert(load.slrKgM2Day > 0, `CLAR. SLR from solids/A = ${load.slrKgM2Day.toFixed(2)} kg/m²·d`);
  // Larger clarifier → lower SOR at same flow
  const uBig = mkBlueprintUnit('secondary_clarifier');
  uBig.blueprint!.design.geometry.diameterM = 30;
  const loadBig = evaluateClarifierLoad(uBig.blueprint!.design.geometry, 5000, 3200, 5000 * 1.75, 0.25);
  assert(loadBig.sorM3M2Day < load.sorM3M2Day, `CLAR. larger clarifier lowers SOR (${loadBig.sorM3M2Day.toFixed(1)} < ${load.sorM3M2Day.toFixed(1)} m/d)`);
  // Peak flow overloads a small clarifier
  const peak = evaluateClarifierLoad(u.blueprint!.design.geometry, 9000, 3200, 9000 * 1.75, 0.25);
  assert(peak.sorM3M2Day > load.sorM3M2Day && peak.overloaded, `CLAR. peak flow overloads small clarifier (SOR ${peak.sorM3M2Day.toFixed(1)}, overloaded=${peak.overloaded})`);
  assert(peak.blanketLevelFraction >= load.blanketLevelFraction, `CLAR. blanket rises under overload (${(peak.blanketLevelFraction * 100).toFixed(0)}% ≥ ${(load.blanketLevelFraction * 100).toFixed(0)}%)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// EQUALIZATION — dynamic mixed-storage mass balance
// ═══════════════════════════════════════════════════════════════════════════
{
  const u = mkBlueprintUnit('equalization_basin');
  // Volume conservation with steady in/out
  const eq1 = stepEqualization(u, wq({ flowRate: 1000, bod: 200 }), 1, 1000 / 24);
  assert(Math.abs(eq1.storedVolumeM3) < 1e-6, `EQ. steady flow keeps tank level ~0 (V=${eq1.storedVolumeM3.toFixed(3)})`);
  // Load spike with limited outflow → storage buffers it (downstream smoothed)
  const u2 = mkBlueprintUnit('equalization_basin');
  u2.blueprint!.design.geometry.lengthM = 20; u2.blueprint!.design.geometry.widthM = 10; u2.blueprint!.design.geometry.waterDepthM = 5;
  u2.eqStorage = initEqStorage();
  let outBod = 0;
  for (let i = 0; i < 24; i++) {
    // 12 h low (BOD 100), 12 h spike (BOD 800)
    const inletBod = i < 12 ? 100 : 800;
    const r = stepEqualization(u2, wq({ flowRate: 5000, bod: inletBod }), 1, 5000 / 24);
    outBod = r.effluent.bod;
    u2.eqStorage = { storedVolumeM3: r.storedVolumeM3, constituentMassKg: r.effluent as any };
  }
  // Mass-conserving mix: outlet BOD stays between the two extremes and inside capacity
  assert(outBod > 100 && outBod < 800, `EQ. load spike attenuated: outlet BOD ${outBod.toFixed(0)} between 100 and 800 (not the raw spike)`);
  // Overflow at capacity
  const u3 = mkBlueprintUnit('equalization_basin');
  u3.blueprint!.design.geometry.lengthM = 6; u3.blueprint!.design.geometry.widthM = 4; u3.blueprint!.design.geometry.waterDepthM = 2;
  u3.eqStorage = initEqStorage();
  let overflowed = false;
  for (let i = 0; i < 48; i++) {
    const r = stepEqualization(u3, wq({ flowRate: 20000, bod: 300 }), 1, 1000 / 24);
    if (r.overflowed) overflowed = true;
    u3.eqStorage = { storedVolumeM3: r.storedVolumeM3, constituentMassKg: r.effluent as any };
  }
  assert(overflowed, 'EQ. basin overflows when inflow exceeds capacity + pump rate');
}

// ═══════════════════════════════════════════════════════════════════════════
// PIPE HYDRAULICS
// ═══════════════════════════════════════════════════════════════════════════
{
  const path = [[0, 0, 0], [50, 0, 0]] as Array<[number, number, number]>; // 50 cells = 300 m
  assert(Math.abs(pathLengthM(path) - 300) < 1e-6, `PIPE. path length = 50 cells × 6 m = ${pathLengthM(path)} m`);
  const hSmall = evaluatePipeHydraulics(0.2, 'pvc', 300, 1000);
  const hLarge = evaluatePipeHydraulics(0.6, 'pvc', 300, 1000);
  assert(hSmall.totalHeadlossM > hLarge.totalHeadlossM, `PIPE. smaller diameter → higher headloss (${hSmall.totalHeadlossM.toFixed(1)} > ${hLarge.totalHeadlossM.toFixed(1)} m)`);
  // velocity rises as diameter shrinks
  assert(hSmall.velocityMs > hLarge.velocityMs, `PIPE. smaller diameter → higher velocity (${hSmall.velocityMs.toFixed(2)} > ${hLarge.velocityMs.toFixed(2)} m/s)`);
  // longer pipe → more headloss
  const hLong = evaluatePipeHydraulics(0.3, 'ductile_iron', 300, 1000);
  const hShort = evaluatePipeHydraulics(0.3, 'ductile_iron', 300, 1000);
  assert(hLong.totalHeadlossM > hShort.totalHeadlossM, `PIPE. longer pipe → more headloss (${hLong.totalHeadlossM.toFixed(1)} > ${hShort.totalHeadlossM.toFixed(1)} m)`);
  // rougher material → more headloss
  const hRough = evaluatePipeHydraulics(0.3, 'ductile_iron', 300, 1000);
  const hSmooth = evaluatePipeHydraulics(0.3, 'pvc', 300, 1000);
  assert(hRough.totalHeadlossM > hSmooth.totalHeadlossM, `PIPE. rougher material → more headloss (DI ${hRough.totalHeadlossM.toFixed(1)} > PVC ${hSmooth.totalHeadlossM.toFixed(1)} m)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PUMP — duty point / no-solution
// ═══════════════════════════════════════════════════════════════════════════
{
  const pump = PUMP_MODELS.sewage_wedge_400;
  const dp = findPumpDutyPoint(pump, 5, 0.00002, 1.0);
  assert(dp.ok && dp.flowM3h > 0, `PUMP. finds operating point (${dp.flowM3h.toFixed(0)} m³/h, ${dp.headM.toFixed(1)} m)`);
  // Static lift above shutoff head → no valid operating point
  const stuck = findPumpDutyPoint(pump, 50, 0.00002, 1.0);
  assert(!stuck.ok && stuck.reason === 'no_valid_operating_point', `PUMP. lift > shutoff head → no duty point (${stuck.reason})`);
  // Power scales with ρgQH / efficiency
  assert(dp.electricalPowerKw > 0 && dp.electricalPowerKw < 50, `PUMP. electrical power plausible (${dp.electricalPowerKw.toFixed(1)} kW)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPEX — quantity based
// ═══════════════════════════════════════════════════════════════════════════
{
  const small = { shape: 'rect' as const, lengthM: 12, widthM: 6, waterDepthM: 4, freeboardM: 0.5, wallThicknessM: 0.3, floorThicknessM: 0.25, numberOfParallelTrains: 1 };
  const big = { shape: 'rect' as const, lengthM: 40, widthM: 20, waterDepthM: 5, freeboardM: 0.6, wallThicknessM: 0.4, floorThicknessM: 0.3, numberOfParallelTrains: 1 };
  const cSmall = estimateStructureCAPEX(small, 'reinforced_concrete');
  const cBig = estimateStructureCAPEX(big, 'reinforced_concrete');
  assert(cBig.total > cSmall.total, `CAPEX. larger tank costs more (${cBig.total} > ${cSmall.total})`);
  // material upgrade raises structural cost
  const cSteel = estimateStructureCAPEX(small, 'ss316');
  assert(cSteel.total > cSmall.total, `CAPEX. stainless shell costs more than concrete (${cSteel.total} > ${cSmall.total})`);
  // redundancy adds installed cost
  const single = estimateBlowerCAPEX('turbo_3000_vfd', 'single_100');
  const duty = estimateBlowerCAPEX('turbo_3000_vfd', 'duty_standby');
  assert(duty > single, `CAPEX. duty+standby costs more than single (${duty} > ${single})`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PERMIT — single authoritative evaluator (no duplicated formulas)
// ═══════════════════════════════════════════════════════════════════════════
{
  const std: TreatmentStandard = {
    maxBod: 20, maxCod: 100, maxTss: 20, maxTn: 15, maxNh4: 3, maxTp: 1,
    maxPathogens: 0, minDo: 4, minPh: 6, maxPh: 9, maxTurbidity: 10,
  };
  const good = wq({ bod: 8, cod: 40, tss: 8, tn: 8, nh4: 1, tp: 0.4, pathogens: 0, do: 6, ph: 7.2, turbidity: 3 });
  const bad = wq({ bod: 60, cod: 300, tss: 80, tn: 40, nh4: 12, tp: 5, pathogens: 500, do: 1, ph: 5, turbidity: 40 });
  const g = evaluatePermitCriteria(good, std);
  const b = evaluatePermitCriteria(bad, std);
  assert(g.every(c => c.pass), `PERMIT. clean effluent passes all ${g.length} criteria`);
  assert(b.filter(c => !c.pass).length === b.length, `PERMIT. all ${b.length} criteria fail on bad effluent`);
  // true-zero pathogen limit honored literally
  const zeroPath = wq({ bod: 8, cod: 40, tss: 8, tn: 8, nh4: 1, tp: 0.4, pathogens: 30, do: 6, ph: 7.2, turbidity: 3 });
  const z = evaluatePermitCriteria(zeroPath, std);
  const pathCrit = z.find(c => c.key === 'pathogens')!;
  assert(!pathCrit.pass, `PERMIT. 30 CFU against a 0 limit FAILS (true-zero honored)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PFD — branching renders real edges, not a fake linear chain
// ‐══════════════════════════════════════════════════════════════════════════
{
  const inlet: PlacedUnit = { instanceId: 'inf', typeId: 'influent_inlet', gridX: 0, gridY: 0, rotation: 0, volume: 0, customParams: {}, active: true, efficiencyRating: 100, lastInletQuality: emptyWater(), lastOutletQuality: emptyWater(), lastPowerKwActual: 0, lastOpexActual: 0 };
  const cas: PlacedUnit = { ...mkBlueprintUnit('activated_sludge_cas'), instanceId: 'cas', gridX: 5, gridY: 0 };
  const cl1: PlacedUnit = { ...mkBlueprintUnit('secondary_clarifier'), instanceId: 'cl1', gridX: 9, gridY: 0 };
  const cl2: PlacedUnit = { ...mkBlueprintUnit('secondary_clarifier'), instanceId: 'cl2', gridX: 9, gridY: 6 };
  const mkPipe = (id: string, f: string, fp: string, t: string, tp: string) => ({
    id, fromUnitId: f, fromPortId: fp, toUnitId: t, toPortId: tp,
    pathPoints: [[0, 0, 0], [1, 0, 0]] as Array<[number, number, number]>,
    flowRate: 1000, quality: emptyWater(), pipeType: 'liquid' as const,
  });
  // Splitter: CAS outlet → TWO clarifiers (a fork, not a chain)
  const pipes = [
    mkPipe('p1', 'inf', 'outlet', 'cas', 'inlet'),
    mkPipe('p2', 'cas', 'outlet', 'cl1', 'inlet'),
    mkPipe('p3', 'cas', 'outlet', 'cl2', 'inlet'),
  ];
  const topo = resolveTrainTopology([inlet, cas, cl1, cl2], pipes as any);
  const casLinks = topo.links.filter(l => l.fromUnitId === 'cas' && l.kind === 'liquid');
  assert(casLinks.length === 2, `PFD. splitter produces 2 outgoing liquid edges (fan-out), not a single chain (${casLinks.length})`);
  assert(topo.mainTrainOrder.includes('cl1') && topo.mainTrainOrder.includes('cl2'), 'PFD. both branches appear on the active train');
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? 'ALL ENGINEERING TESTS PASSED' : 'ENGINEERING TESTS FAILED'} (${passed} passed, ${failed} failed)`);
if (failed > 0) {
  console.error('\nFailures:\n' + failures.map(f => ' - ' + f).join('\n'));
  process.exit(1);
}
