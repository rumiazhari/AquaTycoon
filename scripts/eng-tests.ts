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
  estimateSeedSludgeCAPEX,
  SEED_SLUDGE_USD_PER_M3,
  SEED_FILL_FRACTION,
  SEED_MIN_CHARGE_USD,
} from '../src/design/CostEstimator';
import { PIPE_MATERIALS, BLOWER_MODELS, PUMP_MODELS } from '../src/design/catalogs/Equipment';
import { resolveTrainTopology } from '../src/ui/TrainTopology';
import { GameManager } from '../src/gameplay/GameManager';
import type { PlacedUnit, WaterQuality } from '../src/types/simulation';
import { UNIT_DEFINITIONS } from '../src/sim/UnitProcessModels';
import { evaluatePermitCriteria } from '../src/sim/PermitEngine';
import type { TreatmentStandard } from '../src/types/simulation';
import {
  applyDiurnalInfluent,
  diurnalFlowFactor,
  hourOfDay,
  DIURNAL_MEAN_FACTOR,
  DIURNAL_MIN_FACTOR,
  DIURNAL_MAX_FACTOR,
} from '../src/sim/InfluentProfile';
import { createInfluentWater } from '../src/sim/WaterStream';

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
  let firstSpikeBod = 0;
  for (let i = 0; i < 24; i++) {
    // 12 h low (BOD 100), 12 h spike (BOD 800) — hourly steps (dt in days).
    const inletBod = i < 12 ? 100 : 800;
    const r = stepEqualization(u2, wq({ flowRate: 5000, bod: inletBod }), 1 / 24, 5000 / 24);
    if (i === 12) firstSpikeBod = r.effluent.bod;
    outBod = r.effluent.bod;
    // NOTE: do NOT rebuild eqStorage from r.effluent here — those are
    // CONCENTRATIONS (mg/L), while constituentMassKg holds MASSES (kg).
    // stepEqualization mutates u2.eqStorage in place (same as the live sim),
    // so carrying real state across steps is both correct and required.
  }
  // Mass-conserving mix: the slug blends into the basin's minimum operating
  // pool, so the FIRST spike hour is already damped below the raw 800 load,
  // and the outlet never leaves the [100, 800] envelope.
  assert(firstSpikeBod > 100 && firstSpikeBod < 800, `EQ. spike hour 1 attenuated by min-pool mixing (${firstSpikeBod.toFixed(0)} strictly inside 100..800)`);
  assert(outBod > 100 && outBod <= 800, `EQ. outlet stays in load envelope after 12 h spike (${outBod.toFixed(0)} in 100..800]`);
  // Overflow at capacity
  const u3 = mkBlueprintUnit('equalization_basin');
  u3.blueprint!.design.geometry.lengthM = 6; u3.blueprint!.design.geometry.widthM = 4; u3.blueprint!.design.geometry.waterDepthM = 2;
  u3.eqStorage = initEqStorage();
  let overflowed = false;
  for (let i = 0; i < 48; i++) {
    const r = stepEqualization(u3, wq({ flowRate: 20000, bod: 300 }), 1, 1000 / 24);
    if (r.overflowed) overflowed = true;
    // same in-place mutation as above — no concentration→mass feedback
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
  // longer pipe → more headloss (300 m run vs a 30 m run, same D/material/Q)
  const hLong = evaluatePipeHydraulics(0.3, 'ductile_iron', 300, 1000);
  const hShort = evaluatePipeHydraulics(0.3, 'ductile_iron', 30, 1000);
  assert(hLong.totalHeadlossM > hShort.totalHeadlossM && hLong.frictionHeadlossM > hShort.frictionHeadlossM, `PIPE. longer pipe → more headloss (${hLong.totalHeadlossM.toExponential(2)} > ${hShort.totalHeadlossM.toExponential(2)} m)`);
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
  // Power must sit in the physically possible wire-to-water envelope:
  // electrical ≥ hydraulic (η<1 always) and ≤ hydraulic/0.55 (worst realistic
  // combined pump×motor efficiency for a wastewater duty). The old constant
  // "<50 kW" ignored that the free-running duty point here is 759 m³/h @
  // 16.5 m → ρgQH = ~34.2 kW hydraulic, so ~50 kW at η=0.68 is CORRECT.
  const hydraulicKw = (1000 * 9.81 * (dp.flowM3h / 3600) * dp.headM) / 1000;
  assert(
    dp.electricalPowerKw > hydraulicKw && dp.electricalPowerKw < hydraulicKw / 0.55,
    `PUMP. electrical power in wire-to-water envelope (${dp.electricalPowerKw.toFixed(1)} kW ∈ (${hydraulicKw.toFixed(1)}, ${(hydraulicKw / 0.55).toFixed(1)}) for η∈(0.55,1))`
  );
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
  // A single pH value cannot violate BOTH bounds at once — on this too-LOW
  // sample (pH 5 < min 6) exactly `ph_high` survives and every other
  // criterion must fail. Asserting the exact surviving set is stronger than
  // a bare count.
  assert(
    b.every(c => c.pass === (c.key === 'ph_high')),
    `PERMIT. bad effluent fails all criteria except ph_low-side survivor (${b.filter(c => !c.pass).length}/${b.length} failing; only ph_high passes)`
  );
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

// ═══════════════════════════════════════════════════════════════════════════
// INFLUENT — dynamic municipal diurnal curve (MISSION §AK Phase-1 item 14)
// ‐══════════════════════════════════════════════════════════════════════════
{
  // Curve shape: deterministic, bounded, classic trough/peak/evening-bump.
  assert(DIURNAL_MEAN_FACTOR > 0 && DIURNAL_MEAN_FACTOR < 2,
    `INFLUENT. raw curve mean is a sensible positive number (mean=${DIURNAL_MEAN_FACTOR.toFixed(4)})`);
  assert(Math.abs(DIURNAL_MEAN_FACTOR - 1.0373) < 0.001,
    'INFLUENT. raw curve mean matches the deterministic trapezoid integral');
  const fTrough = diurnalFlowFactor(4.5);
  const fPeak = diurnalFlowFactor(10.0);
  assert(fTrough < 0.7 && fPeak > 1.3,
    `INFLUENT. trough ≈04:30 well below average and morning peak ≈10:00 well above (${fTrough.toFixed(2)} / ${fPeak.toFixed(2)})`);
  let minF = Infinity, maxF = -Infinity;
  for (let h = 0; h < 24; h += 0.25) {
    const f = diurnalFlowFactor(h);
    if (f < minF) minF = f;
    if (f > maxF) maxF = f;
    assert(f > 0 && Number.isFinite(f), `INFLUENT. factor positive+finite at h=${h}`);
  }
  assert(Math.abs(minF - DIURNAL_MIN_FACTOR) < 1e-9 && Math.abs(maxF - DIURNAL_MAX_FACTOR) < 1e-9,
    'INFLUENT. exported MIN/MAX constants match a fine scan of the curve');
  let sum24 = 0;
  for (let h = 0; h < 24; h++) sum24 += diurnalFlowFactor(h);
  assert(Math.abs(sum24 / 24 - 1) < 0.005,
    `INFLUENT. 24-h mean flow factor is exactly ~1 so long-run economics hold (${(sum24 / 24).toFixed(4)})`);

  // Determinism: same clock ⇒ identical result.
  assert(diurnalFlowFactor(hourOfDay(3.5 / 24)) === diurnalFlowFactor(hourOfDay(3.5 / 24)),
    'INFLUENT. purely deterministic in the simulated clock');

  // Spec application: flow rides the curve; concentrations ride load/flow.
  // NOTE: gameTimeDays is FRACTIONAL DAYS — divide the target hour by 24.
  const baseSpec: WaterQuality = { ...createInfluentWater(), flowRate: 10000 };
  const night = applyDiurnalInfluent(baseSpec, 4.5 / 24);   // day 0, ≈04:30 trough
  const peak = applyDiurnalInfluent(baseSpec, 10 / 24);     // day 0, ≈10:00 peak
  const fN = diurnalFlowFactor(4.5), fP = diurnalFlowFactor(10);
  assert(Math.abs(night.flowRate - baseSpec.flowRate * fN) < 1e-6,
    'INFLUENT. applied flow equals spec × curve factor at the trough');
  assert(night.bod > peak.bod,
    `INFLUENT. night sewage reads stronger than peak-flow sewage (BOD ${night.bod.toFixed(0)} > ${peak.bod.toFixed(0)} mg/L)`);
  // Mass-load character: loads swing LESS than flow (damped by sewer routing).
  const loadNight = night.bod * night.flowRate;
  const loadBase = baseSpec.bod * baseSpec.flowRate;
  const loadPeak = peak.bod * peak.flowRate;
  const dFlowNight = Math.abs(night.flowRate / baseSpec.flowRate - 1);
  const dLoadNight = Math.abs(loadNight / loadBase - 1);
  assert(dLoadNight < dFlowNight,
    'INFLUENT. pollutant mass load swings less than flow (sewer damping)');
  assert(loadPeak > loadBase * 1.05,
    'INFLUENT. morning peak carries a genuinely higher pollutant load');
  // Mean-preserving over the clock wrap: same hour on different days agrees.
  const d1 = applyDiurnalInfluent(baseSpec, 1 + 20 / 24);
  const d2 = applyDiurnalInfluent(baseSpec, 7 + 20 / 24);
  assert(Math.abs(d1.flowRate - d2.flowRate) < 1e-9 && Math.abs(d1.bod - d2.bod) < 1e-9,
    'INFLUENT. same hour on any two days yields identical influent');

  // Legacy escape hatch: strength 0 returns the spec unchanged (§AL).
  const off = applyDiurnalInfluent(baseSpec, 0.42, 0);
  assert(off.flowRate === baseSpec.flowRate && off.bod === baseSpec.bod,
    'INFLUENT. strength=0 reproduces the legacy constant spec exactly');
  // Input spec is never mutated.
  const before = baseSpec.flowRate;
  applyDiurnalInfluent(baseSpec, 0.5);
  assert(baseSpec.flowRate === before, 'INFLUENT. input spec object never mutated');
}

// ── SEED: seed-sludge haul-in economics (backlog #1) ────────────────────────
{
  // Pricing math: volume-proportional with a mobilization floor.
  assert(estimateSeedSludgeCAPEX(1000) === Math.round(1000 * SEED_FILL_FRACTION * SEED_SLUDGE_USD_PER_M3),
    'SEED. quote = working volume × fill fraction × delivered $/m³');
  assert(estimateSeedSludgeCAPEX(0) === SEED_MIN_CHARGE_USD && estimateSeedSludgeCAPEX(-5) === SEED_MIN_CHARGE_USD,
    'SEED. zero/negative volumes clamp to the tanker mobilization floor');

  const gsSeed = GameManager.createInitialState(0, false);
  const casU = mkBlueprintUnit('activated_sludge_cas', 16, 20);
  const startCash = 500000;
  const unseededComm = { phase: 'developing' as const, daysInPhase: 6, seededWithSludge: false };
  let sS: any = {
    ...gsSeed,
    units: [{ ...casU, commissioning: { ...unseededComm } }],
    financials: { ...gsSeed.financials, cash: startCash },
    simSpeed: 1 as const,
  };
  const wantOn = { phase: 'developing' as const, daysInPhase: 6, seededWithSludge: true };
  const expectedCharge = estimateSeedSludgeCAPEX(casU.volume);

  // OFF→ON: exactly one haul-in charge, cash debited, commissioning written.
  const rOn = GameManager.setUnitCommissioning(sS, casU.instanceId, wantOn);
  assert(rOn.success && rOn.seedCapexCharged === expectedCharge,
    `SEED. unseeded→seeded charges exactly the quote ($${expectedCharge.toLocaleString()})`);
  assert(rOn.success && rOn.newState.financials.cash === startCash - expectedCharge,
    'SEED. haul-in charge is debited from cash exactly once');
  assert(rOn.newState.units[0].commissioning?.seededWithSludge === true,
    'SEED. accepted toggle writes seeded=true on the placed unit');

  // ON→OFF: no refund — the purchased culture is spent.
  const rOff = GameManager.setUnitCommissioning(rOn.newState, casU.instanceId, unseededComm);
  assert(rOff.success && rOff.seedCapexCharged === undefined &&
    rOff.newState.financials.cash === startCash - expectedCharge,
    'SEED. seeded→unseeded never refunds the haul-in');

  // Second OFF→ON: a fresh truckload is bought at full price again.
  const rOn2 = GameManager.setUnitCommissioning(rOff.newState, casU.instanceId, wantOn);
  assert(rOn2.success && rOn2.seedCapexCharged === expectedCharge &&
    rOn2.newState.financials.cash === startCash - 2 * expectedCharge,
    'SEED. every fresh unseeded→seeded transition buys a new truckload');

  // Insufficient funds: rejected atomically — no partial writes.
  const brokeCash = Math.floor(expectedCharge / 2);
  const broke: any = {
    ...sS,
    units: [{ ...casU, commissioning: { ...unseededComm } }],
    financials: { ...sS.financials, cash: brokeCash },
  };
  const rBroke = GameManager.setUnitCommissioning(broke, casU.instanceId, wantOn);
  assert(!rBroke.success && !!rBroke.reason && rBroke.reason.includes('Insufficient funds'),
    'SEED. unaffordable seeding is rejected with an insufficient-funds reason');
  assert(rBroke.newState.units[0].commissioning?.seededWithSludge === false &&
    rBroke.newState.financials.cash === brokeCash,
    'SEED. rejected toggle leaves both commissioning and cash untouched');

  // Sandbox bypasses money gates like every other charge.
  const sbx: any = { ...broke, gameMode: 'sandbox' as const };
  const rSbx = GameManager.setUnitCommissioning(sbx, casU.instanceId, wantOn);
  assert(rSbx.success && rSbx.seedCapexCharged === undefined &&
    rSbx.newState.financials.cash === brokeCash &&
    rSbx.newState.units[0].commissioning?.seededWithSludge === true,
    'SEED. sandbox seeds for free while still writing the commissioning state');

  // Unknown unit id fails cleanly.
  const rGhost = GameManager.setUnitCommissioning(sS, 'ghost_unit', wantOn);
  assert(!rGhost.success && rGhost.reason === 'Unknown unit',
    'SEED. unknown unit id rejected without touching state');

  // Placement regression guard (§AL): initial contractor seeding stays bundled
  // into construction CAPEX — placement debits ONLY def.capex and seeds by default.
  const gsP = GameManager.createInitialState(0, false);
  const rP = GameManager.placeUnit(gsP, 'activated_sludge_cas', 5, 20);
  const placedCas = rP.success ? rP.newState.units[rP.newState.units.length - 1] : null;
  assert(rP.success && placedCas !== null && placedCas!.commissioning?.seededWithSludge === true,
    'SEED. placement still hands over a contractor-seeded reactor');
  assert(rP.success && rP.newState.financials.cash === gsP.financials.cash - UNIT_DEFINITIONS['activated_sludge_cas'].capex,
    'SEED. placement debits exactly def.capex — no hidden seed surcharge (§AL)');
}

// ── SEED II: direct unseeded placement (backlog #1 follow-up) ───────────────
{
  const capex = UNIT_DEFINITIONS['activated_sludge_cas'].capex;
  const bpCas = blueprintFromTemplate('activated_sludge_cas');
  const credit = estimateSeedSludgeCAPEX(bpCas ? workingVolumeM3(bpCas.design.geometry) : 0);
  const unseededPrice = capex - credit;

  // U1. Option places an unseeded reactor and debits capex − haul-in credit.
  const gsU = GameManager.createInitialState(0, false);
  const rU = GameManager.placeUnit(gsU, 'activated_sludge_cas', 5, 20, 0, { seededWithSludge: false });
  const uU = rU.success ? rU.newState.units[rU.newState.units.length - 1] : null;
  assert(rU.success && uU !== null && uU!.commissioning?.seededWithSludge === false,
    'SEED. unseeded placement option hands over an unseeded reactor');
  assert(rU.success && rU.newState.financials.cash === gsU.financials.cash - unseededPrice,
    'SEED. unseeded placement debits def.capex minus the seed haul-in credit');
  assert(unseededPrice > 0 && unseededPrice < capex,
    'SEED. unseeded net price strictly between $0 and def.capex');

  // U2. The discount is real: a wallet sized to the unseeded price builds
  //     UNSEEDED but can no longer afford the contractor-seeded default.
  const gsT = GameManager.createInitialState(0, false);
  gsT.financials.cash = unseededPrice;
  const rTSeeded = GameManager.placeUnit(gsT, 'activated_sludge_cas', 5, 20);
  assert(!rTSeeded.success,
    'SEED. seeded placement rejected when cash covers only the unseeded price');
  const rTUnseeded = GameManager.placeUnit(gsT, 'activated_sludge_cas', 5, 20, 0, { seededWithSludge: false });
  assert(rTUnseeded.success && rTUnseeded.newState.financials.cash === 0,
    'SEED. unseeded placement succeeds exactly at the discounted price');

  // U3. One dollar short of the discounted price rejects atomically.
  const gsT2 = GameManager.createInitialState(0, false);
  gsT2.financials.cash = unseededPrice - 1;
  const rT2 = GameManager.placeUnit(gsT2, 'activated_sludge_cas', 5, 20, 0, { seededWithSludge: false });
  assert(!rT2.success && !!rT2.reason && rT2.reason.includes('Insufficient funds'),
    'SEED. unseeded placement rejects atomically below the discounted price');

  // U4. Sandbox honors the choice free of charge.
  const gsS = GameManager.createInitialState(0, true);
  const cashBefore = gsS.financials.cash;
  const rS = GameManager.placeUnit(gsS, 'activated_sludge_cas', 5, 20, 0, { seededWithSludge: false });
  const uS = rS.success ? rS.newState.units[rS.newState.units.length - 1] : null;
  assert(rS.success && uS !== null && uS!.commissioning?.seededWithSludge === false &&
    rS.newState.financials.cash === cashBefore,
    'SEED. sandbox honors unseeded placement free of charge');

  // U5. Non-CAS engineerable families ignore the flag — no phantom discount.
  const gsC = GameManager.createInitialState(0, true);
  const rC = GameManager.placeUnit(gsC, 'secondary_clarifier', 8, 18, 0, { seededWithSludge: false });
  const uC = rC.success ? rC.newState.units[rC.newState.units.length - 1] : null;
  assert(rC.success && uC !== null && uC!.commissioning?.seededWithSludge === true,
    'SEED. non-CAS engineerable ignores the unseeded flag (stays contractor-seeded)');

  // U6. Chained: unseeded start → later manual re-seed bills a fresh truckload.
  let u6ok = false;
  if (uU && uU.commissioning) {
    const cashAfterPlace = rU.newState.financials.cash;
    const rReseed = GameManager.setUnitCommissioning(rU.newState, uU.instanceId, {
      phase: uU.commissioning.phase,
      daysInPhase: uU.commissioning.daysInPhase,
      seededWithSludge: true,
    });
    u6ok = rReseed.success && rReseed.newState.financials.cash === cashAfterPlace - credit;
  }
  assert(u6ok, 'SEED. later manual re-seed after unseeded start buys a fresh truckload');
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? 'ALL ENGINEERING TESTS PASSED' : 'ENGINEERING TESTS FAILED'} (${passed} passed, ${failed} failed)`);
if (failed > 0) {
  console.error('\nFailures:\n' + failures.map(f => ' - ' + f).join('\n'));
  process.exit(1);
}
