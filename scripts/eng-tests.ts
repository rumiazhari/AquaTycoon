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
  defaultGeometryFor,
} from '../src/design/Geometry';
import {
  validateUnitDesign,
  validateStructuralGeometry,
  evaluatePumpStationDesign,
  validateEqualizationDesign,
  casPeakHeadroomIssue,
  clarifierPeakExposureIssues,
  eqDiurnalSizingIssue,
} from '../src/design/DesignValidator';
import { blueprintFromTemplate } from '../src/design/UnitBlueprint';
import { casDesignPoint, stepCasRuntime } from '../src/sim/processes/ActivatedSludge';
import { evaluateClarifierLoad } from '../src/sim/processes/Clarifier';
import { SimulationEngine } from '../src/sim/SimulationEngine';
import { calculateUnitProcess } from '../src/sim/UnitProcessModels';
import { stepEqualization, initEqStorage, EQ_MIN_POOL_FRACTION } from '../src/sim/processes/Equalization';
import {
  pathLengthM,
  evaluatePipeHydraulics,
  findPumpDutyPoint,
} from '../src/sim/hydraulics/PipeHydraulics';
import {
  recommendDiameterM,
  refreshPipeHydraulics,
  defaultMaterialForPipeType,
  STANDARD_DIAMETERS_M,
  AUTO_TARGET_VELOCITY_MS,
} from '../src/design/PipeSizing';
import {
  estimateStructureCAPEX,
  estimateBlowerCAPEX,
  estimateSeedSludgeCAPEX,
  estimatePipeCAPEX,
  SEED_SLUDGE_USD_PER_M3,
  SEED_FILL_FRACTION,
  SEED_MIN_CHARGE_USD,
} from '../src/design/CostEstimator';
import { PIPE_MATERIALS, BLOWER_MODELS, PUMP_MODELS } from '../src/design/catalogs/Equipment';
import { resolveTrainTopology } from '../src/ui/TrainTopology';
import { GameManager } from '../src/gameplay/GameManager';
import type { PlacedUnit, WaterQuality, PipeConnection } from '../src/types/simulation';
import type { GameFinancials } from '../src/types/game';
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
  DIURNAL_DEFAULT_STRENGTH,
} from '../src/sim/InfluentProfile';
import { createInfluentWater } from '../src/sim/WaterStream';
import {
  PEAK_FLOW_FACTOR,
  PEAK_LOAD_FACTOR,
  VALIDATOR_REFERENCE_FLOW_M3D,
  peakFlowFactorForStrength,
  peakLoadFactorForStrength,
  peakDesignFlowM3d,
  requiredBalancingVolumeM3,
} from '../src/design/PeakFlow';

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
// CLARIFIER WIRING — designed geometry reaches lastOutletQuality (backlog #1)
// The solver must carry the ENGINEERED escape TSS + blanket into the unit's
// lastOutletQuality (what the PFD probe reads). Regression guard: the wired
// result used to be recomputed from the hardcoded qForward/144 ladder,
// discarding the design — every clarifier settled at the same TSS.
// ‐══════════════════════════════════════════════════════════════════════════
{
  const std = GameManager.createInitialState(0, true).currentLevel.standards;
  const fin: GameFinancials = {
    cash: 1e6, dailyRevenue: 0, dailyOpex: 0, dailyPowerCost: 0, dailyChemicalCost: 0,
    dailySludgeDisposalCost: 0, dailyBiogasRevenue: 0, dailyFines: 0,
    totalTreatedM3: 0, netDailyProfit: 0,
  };
  // Deliberate contrast (areas are PER-TRAIN — planAreaM2 semantics shared
  // with the CLAR section above): Ø30 m tank = 707 m² stays BELOW the solids-
  // loading limit at this feed, Ø8 m tank = 50 m² is far OVER it. Same
  // hydraulics, wildly different settling duty.
  const feed = wq({ flowRate: 4550, tss: 850, bod: 220, cod: 480, tn: 42, nh4: 26, tp: 8, pathogens: 1e7 });

  const mkPlain = (id: string, typeId: string): PlacedUnit => ({
    instanceId: id, typeId, gridX: 0, gridY: 0, rotation: 0, volume: 0,
    customParams: {}, active: true, efficiencyRating: 100,
    lastInletQuality: emptyWater(), lastOutletQuality: emptyWater(),
    lastPowerKwActual: 0, lastOpexActual: 0,
  });

  const runNet = (clar: PlacedUnit, steps: number): PlacedUnit => {
    let units: PlacedUnit[] = [
      mkPlain('inf', 'influent_inlet'), clar, mkPlain('out', 'effluent_outfall'), mkPlain('sink', 'effluent_outfall'),
    ];
    const pipes = [
      { id: 'p1', fromUnitId: 'inf', fromPortId: 'outlet', toUnitId: clar.instanceId, toPortId: 'inlet', pathPoints: [] as number[][], flowRate: 0, quality: emptyWater(), pipeType: 'liquid' as const },
      { id: 'p2', fromUnitId: clar.instanceId, fromPortId: 'outlet', toUnitId: 'out', toPortId: 'inlet', pathPoints: [] as number[][], flowRate: 0, quality: emptyWater(), pipeType: 'liquid' as const },
      { id: 'p3', fromUnitId: clar.instanceId, fromPortId: 'sludge_outlet', toUnitId: 'sink', toPortId: 'inlet', pathPoints: [] as number[][], flowRate: 0, quality: emptyWater(), pipeType: 'liquid' as const },
    ];
    let res = SimulationEngine.stepSimulation(units, pipes as any, feed, std, fin, 0.5);
    for (let i = 1; i < steps; i++) {
      res = SimulationEngine.stepSimulation(res.updatedUnits, pipes as any, feed, std, fin, 0.5);
    }
    return res.updatedUnits.find(u => u.instanceId === clar.instanceId)!;
  };

  // 1+2. Outlet-quality propagation: the PFD/UI probe field is populated with
  //      real solved values after the network converges (no more zeros).
  const bigDef = mkBlueprintUnit('secondary_clarifier', 9, 0);
  bigDef.blueprint!.design.geometry.diameterM = 30;
  const big = runNet(bigDef, 4);
  assert(!!big && big.lastOutletQuality.flowRate > 100,
    `CLARW. clarifier lastOutletQuality carries real flow (${big.lastOutletQuality.flowRate.toFixed(0)} m³/d) — UI probe no longer zeros`);
  assert(Number.isFinite(big.lastOutletQuality.tss) && big.lastOutletQuality.tss > 0,
    `CLARW. outlet TSS populated (${big.lastOutletQuality.tss.toFixed(1)} mg/L), not zero/NaN`);

  // 3. Engineered sizing actually discriminates effluent quality now.
  const smallDef = mkBlueprintUnit('secondary_clarifier', 9, 6);
  smallDef.blueprint!.design.geometry.diameterM = 8;
  smallDef.blueprint!.design.geometry.numberOfParallelTrains = 1;
  const small = runNet(smallDef, 4);
  assert(small.lastOutletQuality.tss > big.lastOutletQuality.tss * 1.5,
    `CLARW. undersized clarifier escapes far more solids (${small.lastOutletQuality.tss.toFixed(1)} vs ${big.lastOutletQuality.tss.toFixed(1)} mg/L) — design reaches the effluent`);

  // 4. Hydraulics are geometry-independent at equal RAS settings.
  const flowGap = Math.abs(small.lastOutletQuality.flowRate - big.lastOutletQuality.flowRate)
    / Math.max(1, big.lastOutletQuality.flowRate);
  assert(flowGap < 0.02, `CLARW. same forward flow either way (Δ=${(flowGap * 100).toFixed(2)}%)`);

  // 5. Blanket follows the design too (overloaded tank → rising blanket).
  assert(
    typeof small.sludgeBlanketHeightPercent === 'number'
    && typeof big.sludgeBlanketHeightPercent === 'number'
    && (small.sludgeBlanketHeightPercent as number) > (big.sludgeBlanketHeightPercent as number) + 20,
    `CLARW. blanket tracks load (${small.sludgeBlanketHeightPercent}% vs ${big.sludgeBlanketHeightPercent}%)`
  );

  // 6. Legacy saves without a blueprint keep the hardcoded 144 m² ladder
  //    exactly (qForward = 4550/1.75 = 2600 → SOR ≈18 → second-rung 8 mg/L).
  const legacy = runNet(mkPlain('clg', 'secondary_clarifier'), 4);
  assert(Math.abs(legacy.lastOutletQuality.tss - 8) < 1e-6,
    `CLARW. blueprint-less legacy clarifier still settles via 144 m² ladder (${legacy.lastOutletQuality.tss.toFixed(1)} mg/L)`);
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

  // ── Result API: mass snapshot + inflow report (backlog #4) ─────────────────
  const u4 = mkBlueprintUnit('equalization_basin');
  u4.blueprint!.design.geometry.lengthM = 20; u4.blueprint!.design.geometry.widthM = 10; u4.blueprint!.design.geometry.waterDepthM = 5;
  u4.eqStorage = initEqStorage();
  const eqCap = workingVolumeM3(u4.blueprint!.design.geometry);
  const snap1 = stepEqualization(u4, wq({ flowRate: 5000, bod: 400 }), 1 / 24, 100);
  assert(
    typeof snap1.constituentMassKg['bod'] === 'number' && snap1.constituentMassKg['bod'] > 0,
    `EQ. result exposes constituentMassKg snapshot (bod=${snap1.constituentMassKg['bod'].toFixed(1)} kg)`
  );
  assert(Math.abs(snap1.inflowM3d - 5000) < 1e-9, `EQ. result reports inflowM3d (${snap1.inflowM3d} m³/d)`);
  // Snapshot is a COPY: mutating it must not corrupt the live tank state.
  snap1.constituentMassKg['bod'] = -999;
  const snap2 = stepEqualization(u4, wq({ flowRate: 5000, bod: 400 }), 1 / 24, 100);
  assert(
    snap2.constituentMassKg['bod'] > 0 && snap2.constituentMassKg['bod'] !== -999,
    `EQ. snapshot is isolated from tank state after caller mutation (${snap2.constituentMassKg['bod'].toFixed(1)} kg)`
  );
  // Effluent concentration is exactly tank mass ÷ mixed volume (CSTR coherence).
  const mixV2 = Math.max(snap2.storedVolumeM3, eqCap * EQ_MIN_POOL_FRACTION);
  const concFromMass = ((snap2.constituentMassKg['bod'] ?? 0) / mixV2) * 1000;
  assert(
    Math.abs(concFromMass - snap2.effluent.bod) < 1e-6,
    `EQ. effluent BOD = stored mass ÷ mixed volume (${snap2.effluent.bod.toFixed(2)} ≈ ${concFromMass.toFixed(2)} mg/L)`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// EQUALIZATION — design audit (§AK item 10 telemetry warnings)
// ═══════════════════════════════════════════════════════════════════════════
{
  // Fresh placement with no telemetry and a sane outflow target stays clean.
  const fresh = mkBlueprintUnit('equalization_basin');
  const freshIssues = validateEqualizationDesign(fresh);
  assert(freshIssues.length === 0, `EQV. fresh basin with default controls passes clean (${freshIssues.map((i) => i.code).join(',') || 'none'})`);

  // Zero outflow target can never drain — critical, unconditional.
  const dead = mkBlueprintUnit('equalization_basin');
  dead.blueprint!.controls.eqOutflowTargetM3h = 0;
  assert(
    validateEqualizationDesign(dead).some((i) => i.code === 'eq_no_outflow' && i.severity === 'critical'),
    'EQV. zero outflow target → critical eq_no_outflow'
  );

  // Telemetry: target below observed average inflow warns (0.5×–0.95×) or goes critical (<0.5×).
  const creeping = mkBlueprintUnit('equalization_basin');
  creeping.lastInletQuality = wq({ flowRate: 5000 }); // avg 208 m³/h vs target 160 → 77%
  assert(
    validateEqualizationDesign(creeping).some((i) => i.code === 'eq_target_below_inflow' && i.severity === 'warning'),
    'EQV. target at 77% of observed inflow → warning'
  );
  const doomed = mkBlueprintUnit('equalization_basin');
  doomed.lastInletQuality = wq({ flowRate: 5000 });
  doomed.blueprint!.controls.eqOutflowTargetM3h = 80; // 38% of average
  assert(
    validateEqualizationDesign(doomed).some((i) => i.code === 'eq_target_below_inflow' && i.severity === 'critical'),
    'EQV. target below half of observed inflow → critical'
  );

  // Live level audit reads eqStorage (works even before flow telemetry exists).
  const nearlyFull = mkBlueprintUnit('equalization_basin');
  const capNF = workingVolumeM3(nearlyFull.blueprint!.design.geometry);
  nearlyFull.eqStorage = { storedVolumeM3: capNF * 0.95, constituentMassKg: {} };
  assert(
    validateEqualizationDesign(nearlyFull).some((i) => i.code === 'eq_level_high' && i.severity === 'warning'),
    'EQV. storage at 95% capacity → eq_level_high warning'
  );
  const spilling = mkBlueprintUnit('equalization_basin');
  const capSP = workingVolumeM3(spilling.blueprint!.design.geometry);
  spilling.eqStorage = { storedVolumeM3: capSP, constituentMassKg: {} };
  assert(
    validateEqualizationDesign(spilling).some((i) => i.code === 'eq_overflowing_now' && i.severity === 'critical'),
    'EQV. storage at capacity → critical eq_overflowing_now'
  );
  // Full validator path routes EQ units through the same audit.
  assert(
    validateUnitDesign(spilling).some((i) => i.code === 'eq_overflowing_now'),
    'EQV. validateUnitDesign includes the EQ audit for equalization basins'
  );
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
  // combined pump×motor efficiency for a wastewater duty).
  const hydraulicKw = (1000 * 9.81 * (dp.flowM3h / 3600) * dp.headM) / 1000;
  assert(
    dp.electricalPowerKw > hydraulicKw && dp.electricalPowerKw < hydraulicKw / 0.55,
    `PUMP. electrical power in wire-to-water envelope (${dp.electricalPowerKw.toFixed(1)} kW ∈ (${hydraulicKw.toFixed(1)}, ${(hydraulicKw / 0.55).toFixed(1)}) for η∈(0.55,1))`
  );

  // ── Runout / service-factor clamping (backlog #3, §AM PUMP) ────────────────
  // Nearly frictionless system: analytic intersection sqrt(17/1.95e-5) ≈
  // 934 m³/h lies far beyond the 500 m³/h curve end (1.25 × BEP) → clamped.
  const runaway = findPumpDutyPoint(pump, 5, 0.00001, 1.0);
  assert(
    runaway.ok && runaway.atRunout === true && runaway.reason === 'clamped_at_runout',
    `PUMP. easy-system intersection clamps at runout (${runaway.flowM3h.toFixed(0)} m³/h, reason=${runaway.reason})`
  );
  assert(Math.abs(runaway.flowM3h - 500) < 1e-6, `PUMP. clamped flow equals 1.25×BEP runout (${runaway.flowM3h})`);
  // Head at the clamp sits ON THE PUMP CURVE, above static lift but below
  // shutoff: H = 22 − 9.5e−6·500² = 19.63 m.
  assert(Math.abs(runaway.headM - (22 - 9.5e-6 * 500 * 500)) < 1e-9 && runaway.headM > 5,
    `PUMP. clamped head follows the pump curve (${runaway.headM.toFixed(2)} m)`);

  // Well-matched system stays untouched by the clamp.
  const normal = findPumpDutyPoint(pump, 12, 0.0004, 1.0);
  const analyticNormal = Math.sqrt((22 - 12) / (9.5e-6 + 0.0004));
  assert(
    normal.ok && !normal.atRunout && Math.abs(normal.flowM3h - analyticNormal) < 1e-9,
    `PUMP. moderate-system duty unaffected by clamp (${normal.flowM3h.toFixed(1)} = analytic ${analyticNormal.toFixed(1)} m³/h)`
  );

  // VFD scales the runout cap with speed under affinity laws: s=0.7 → 350.
  const vfd = findPumpDutyPoint(pump, 5, 0.00001, 0.7);
  assert(
    vfd.ok && vfd.atRunout === true && Math.abs(vfd.flowM3h - 350) < 1e-6,
    `PUMP. VFD speed scales the runout cap (${vfd.flowM3h.toFixed(0)} = 0.7 × 500 m³/h)`
  );

  // Design audit surfaces the mismatch as a live warning…
  const easyStation = evaluatePumpStationDesign(PUMP_MODELS.sewage_wedge_400, 'single_100', 3, 4, 300);
  assert(
    easyStation.some((i) => i.code === 'pump_at_runout'),
    `PUMP. validator warns pump_at_runout on an easy-system station (${easyStation.map((i) => i.code).join(',')})`
  );
  // …and stays silent for a well-matched station.
  const hardStation = evaluatePumpStationDesign(PUMP_MODELS.sewage_wedge_400, 'single_100', 15, 4, 200);
  assert(
    !hardStation.some((i) => i.code === 'pump_at_runout'),
    `PUMP. validator silent about runout on a well-matched station (${hardStation.map((i) => i.code).join(',')})`
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PUMP_RUNTIME — calculateUnitProcess wiring for pump_station (§AK item 9 runtime)
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const psUnit = mkBlueprintUnit('pump_station');
      // Demand 3500 m³/d = 145.8 m³/h, well within 400 m³/h BEP
      const demand = wq({ flowRate: 3500, tss: 120, bod: 200 });
      const rNormal = calculateUnitProcess(psUnit, demand, undefined, undefined, { pumpDischargeHeadlossM: 2.0 });
      assert(
        rNormal.effluent.flowRate > 3400 && rNormal.effluent.flowRate < 3600,
        `PUMP_RT. normal demand → full delivery (${rNormal.effluent.flowRate.toFixed(0)} ≈ 3500 m³/d)`
      );
      assert(
        rNormal.powerKw > 0 && rNormal.powerKw < 15,
        `PUMP_RT. normal power in range (${rNormal.powerKw.toFixed(1)} kW)`
      );
      assert(
              rNormal.pumpRuntime && (rNormal.pumpRuntime.status === 'ok' || rNormal.pumpRuntime.status === 'oversized'),
              `PUMP_RT. normal status ok or oversized (${rNormal.pumpRuntime?.status})`
            );
      assert(
        rNormal.pumpRuntime && rNormal.pumpRuntime.bepFraction > 0.3 && rNormal.pumpRuntime.bepFraction < 0.5,
        `PUMP_RT. normal BEP fraction ~36% (${(rNormal.pumpRuntime?.bepFraction * 100).toFixed(0)}%)`
      );

      // Undersized: demand 12000 m³/d (500 m³/h) > 400 m³/h rated single pump
      const rUnder = calculateUnitProcess(psUnit, wq({ flowRate: 12000 }), undefined, undefined, { pumpDischargeHeadlossM: 1.0 });
      assert(
        rUnder.effluent.flowRate < 11000 && rUnder.effluent.flowRate > 9000,
        `PUMP_RT. undersized → clamped delivery (${rUnder.effluent.flowRate.toFixed(0)} m³/d < demand)`
      );
      assert(
        rUnder.pumpRuntime && rUnder.pumpRuntime.status === 'undersized',
        `PUMP_RT. undersized status (${rUnder.pumpRuntime?.status})`
      );

      // VFD speed command reduces duty flow and power when demand exceeds VFD-limited capacity
            const demandVFD = wq({ flowRate: 12000, tss: 120 }); // 500 m³/h > 0.6×400 = 240 m³/h
            const psVFD = mkBlueprintUnit('pump_station');
            psVFD.blueprint!.controls.pumpSpeedCommand = 0.6;
            const rVFD = calculateUnitProcess(psVFD, demandVFD, undefined, undefined, { pumpDischargeHeadlossM: 1.0 });
            const rVFDNormal = calculateUnitProcess(mkBlueprintUnit('pump_station'), demandVFD, undefined, undefined, { pumpDischargeHeadlossM: 1.0 });
            assert(
              rVFD.pumpRuntime && rVFD.pumpRuntime.dutyFlowM3h < rVFDNormal.pumpRuntime!.dutyFlowM3h,
              `PUMP_RT. VFD 0.6× reduces duty flow (${rVFD.pumpRuntime?.dutyFlowM3h.toFixed(0)} < ${rVFDNormal.pumpRuntime!.dutyFlowM3h.toFixed(0)} m³/h)`
            );
            assert(
              rVFD.powerKw < rVFDNormal.powerKw,
              `PUMP_RT. VFD reduces power (${rVFD.powerKw.toFixed(1)} < ${rVFDNormal.powerKw.toFixed(1)} kW)`
            );

      // Clog penalty (tss > 350) stacks on duty-point power/opex
      const rClog = calculateUnitProcess(psUnit, wq({ flowRate: 3500, tss: 420 }), undefined, undefined, { pumpDischargeHeadlossM: 2.0 });
      assert(
        Math.abs(rClog.powerKw / rNormal.powerKw - 1.35) < 0.01,
        `PUMP_RT. clog multiplies power 1.35× (${(rClog.powerKw / rNormal.powerKw).toFixed(2)})`
      );
      assert(
        Math.abs(rClog.opexDay / rNormal.opexDay - 2.2) < 0.01,
        `PUMP_RT. clog multiplies opex 2.2× (${(rClog.opexDay / rNormal.opexDay).toFixed(2)})`
      );
      assert(
        rClog.efficiency === 70,
        `PUMP_RT. clog drops efficiency to 70 (${rClog.efficiency})`
      );

      // No blueprint (legacy save) → defaults still solve
      const legacyUnit: PlacedUnit = {
        instanceId: 'legacy_ps', typeId: 'pump_station', gridX: 0, gridY: 0, rotation: 0,
        volume: 10, customParams: {}, active: true, efficiencyRating: 100,
        lastInletQuality: emptyWater(), lastOutletQuality: emptyWater(),
        lastPowerKwActual: 0, lastOpexActual: 0,
      };
      const rLegacy = calculateUnitProcess(legacyUnit, wq({ flowRate: 2000 }), undefined, undefined, { pumpDischargeHeadlossM: 1.5 });
      assert(
        rLegacy.effluent.flowRate > 1900 && rLegacy.effluent.flowRate < 2100,
        `PUMP_RT. legacy unit delivers (${rLegacy.effluent.flowRate.toFixed(0)} m³/d)`
      );
      assert(
        rLegacy.powerKw > 0,
        `PUMP_RT. legacy power computed (${rLegacy.powerKw.toFixed(1)} kW)`
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

// ── WARN: engineering warnings phase 2 (§AK item 15 / §AM) ──────────────────
{
  console.log('\n── WARN: engineering warnings — pump stations & structural sanity ──');

  // W1. All template defaults are structurally sane — no critical spam.
  for (const id of ['activated_sludge_cas', 'secondary_clarifier', 'equalization_basin', 'pump_station']) {
    const g = defaultGeometryFor(id)!;
    const crits = validateStructuralGeometry(g).filter(i => i.severity === 'critical');
    assert(crits.length === 0, `WARN. template defaults for ${id} raise no critical structural issue`);
  }

  // W2. Unrealistic wall thickness is a critical.
  const thinWalls = { ...defaultGeometryFor('activated_sludge_cas')!, wallThicknessM: 0.05 };
  assert(
    validateStructuralGeometry(thinWalls).some(i => i.code === 'wall_too_thin' && i.severity === 'critical'),
    'WARN. unrealistic wall thickness flagged critical'
  );

  // W3. §AM "insufficient freeboard" fires generically on any basin.
  const lowFb = { ...defaultGeometryFor('equalization_basin')!, freeboardM: 0.1 };
  assert(
    validateStructuralGeometry(lowFb).some(i => i.code === 'freeboard_low_generic'),
    'WARN. insufficient freeboard produces generic warning'
  );

  // W4. Absurd proportions get an informational note.
  const longBasin = { ...defaultGeometryFor('equalization_basin')!, lengthM: 90, widthM: 4 };
  assert(
    validateStructuralGeometry(longBasin).some(i => i.code === 'aspect_unusual'),
    'WARN. extreme basin aspect ratio surfaces an informational note'
  );

  // W5. Default pump station: missing-standby warning, nothing critical.
  const psIssues = validateUnitDesign(mkBlueprintUnit('pump_station'));
  assert(psIssues.some(i => i.code === 'no_standby_pump'),
    'WARN. single-pump default raises missing-standby warning');
  assert(!psIssues.some(i => i.severity === 'critical'),
    'WARN. default pump-station design has no critical issues');

  // W6. Static lift above shutoff head → no valid duty point (critical).
  const wedge = PUMP_MODELS.sewage_wedge_400;
  assert(
    evaluatePumpStationDesign(wedge, 'duty_standby', 30, 4, 200)
      .some(i => i.code === 'no_duty_point' && i.severity === 'critical'),
    'WARN. impossible static lift reports no valid duty point'
  );

  // W7. Demand far above installed capacity → critical undersizing.
  assert(
    evaluatePumpStationDesign(wedge, 'single_100', 3.5, 4, 3000)
      .some(i => i.code === 'pump_undersized' && i.severity === 'critical'),
    'WARN. demand far above installed capacity flags critical undersizing'
  );

  // W8. Tiny demand vs big pump → far-from-BEP efficiency note.
  assert(
    evaluatePumpStationDesign(wedge, 'single_100', 3.5, 4, 80)
      .some(i => i.code === 'pump_far_from_bep'),
    'WARN. design flow far below BEP surfaces efficiency note'
  );

  // W9. NPSH available below requirement → cavitation is critical.
  const hungry = { ...wedge, id: 'hungry_test', npshRequiredM: 14 };
  assert(
    evaluatePumpStationDesign(hungry, 'single_100', 2, 0.5, 200)
      .some(i => i.code === 'npsh_insufficient' && i.severity === 'critical'),
    'WARN. NPSH unavailable below pump requirement is critical'
  );

  // W10. Thin-but-passing NPSH margin warns before it becomes critical.
  //      NPSHa = 10.33 + 3 − 0.45 − 1.0 ≈ 11.9 m vs required 11 → <1.25× margin.
  const marginal = { ...wedge, npshRequiredM: 11 };
  assert(
    evaluatePumpStationDesign(marginal, 'single_100', 2, 3, 400)
      .some(i => i.code === 'npsh_margin_thin'),
    'WARN. thin NPSH design margin warned before it becomes critical'
  );

  // W11. No-standby multi-unit bank that loses design flow with one unit down.
  assert(
    evaluatePumpStationDesign(wedge, 'two_duty', 3.5, 4, 700)
      .some(i => i.code === 'no_margin_one_down'),
    'WARN. losing a unit below design flow warned for no-standby banks'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PIPE SIZING — §AK items 7/8: engineered pipes end-to-end
// ═══════════════════════════════════════════════════════════════════════════
{
  const mkPipe = (flowRateM3d: number, over: Partial<PipeConnection> = {}): PipeConnection => ({
    id: 'pipe_t', fromUnitId: 'a', fromPortId: 'outlet',
    toUnitId: 'b', toPortId: 'inlet',
    pathPoints: [[0, 0, 0], [10, 0, 0]],
    flowRate: flowRateM3d, quality: emptyWater(), pipeType: 'liquid',
    autoSized: true, ...over,
  });

  // PS1. Recommended DN is monotone in flow; tiny flows stay unsized.
  assert(recommendDiameterM(5) === undefined, 'PIPE2. sub-noise flow stays unsized');
  assert(recommendDiameterM(2000)! <= recommendDiameterM(9000)!, 'PIPE2. recommended DN grows with flow');

  // PS2. Mean velocity at the recommended DN respects the auto-sizing target,
  //      and one ladder step down would overshoot it (tight ladder fit).
  for (const q of [500, 2000, 6000, 12000]) {
    const d = recommendDiameterM(q)!;
    const v = evaluatePipeHydraulics(d, 'pvc', 50, q).velocityMs;
    assert(v <= AUTO_TARGET_VELOCITY_MS + 0.01, `PIPE2. v=${v.toFixed(2)} m/s ≤ target at ${q} m³/d`);
    const idx = STANDARD_DIAMETERS_M.indexOf(d);
    if (idx > 0) {
      const dSmaller = STANDARD_DIAMETERS_M[idx - 1];
      assert(
        evaluatePipeHydraulics(dSmaller, 'pvc', 50, q).velocityMs > AUTO_TARGET_VELOCITY_MS,
        `PIPE2. DN${Math.round(dSmaller * 1000)} overshoots target at ${q} m³/d`
      );
    }
  }

  // PS3–PS5. Headloss grows as diameter shrinks / length grows / roughness rises.
  assert(
    evaluatePipeHydraulics(0.15, 'pvc', 100, 8000).totalHeadlossM >
    evaluatePipeHydraulics(0.4, 'pvc', 100, 8000).totalHeadlossM,
    'PIPE2. smaller DN → larger headloss'
  );
  assert(
    evaluatePipeHydraulics(0.3, 'pvc', 400, 8000).totalHeadlossM >
    evaluatePipeHydraulics(0.3, 'pvc', 20, 8000).totalHeadlossM,
    'PIPE2. longer run → larger headloss'
  );
  assert(
    evaluatePipeHydraulics(0.3, 'ductile_iron', 100, 8000).totalHeadlossM >
    evaluatePipeHydraulics(0.3, 'pvc', 100, 8000).totalHeadlossM,
    'PIPE2. rougher material → larger headloss'
  );

  // PS6. refreshPipeHydraulics sizes + caches hydraulics from the path.
  const cached = mkPipe(8000);
  refreshPipeHydraulics([cached]);
  assert(cached.diameterM !== undefined && cached.cachedHydraulics !== undefined,
    'PIPE2. auto pipe sized+cached after refresh');
  assert(Math.abs(cached.cachedHydraulics!.lengthM - 60) < 1e-6,
    'PIPE2. cached length = path cells × 6 m/cell');
  assert(cached.cachedHydraulics!.velocityMs > 0 && cached.cachedHydraulics!.headlossM > 0,
    'PIPE2. cached velocity/headloss positive');

  // PS7. Auto-sized pipes track flow; player-locked diameters never move.
  const auto = mkPipe(2000);
  refreshPipeHydraulics([auto]);
  const dLow = auto.diameterM!;
  auto.flowRate = 12000;
  refreshPipeHydraulics([auto]);
  assert(auto.diameterM! > dLow, `PIPE2. auto re-size grows with flow (${dLow}→${auto.diameterM})`);

  const locked = mkPipe(2000, { diameterM: 0.6, autoSized: false });
  locked.flowRate = 12000;
  refreshPipeHydraulics([locked]);
  assert(locked.diameterM === 0.6, 'PIPE2. player-locked DN survives flow changes');
  assert(locked.cachedHydraulics !== undefined && locked.cachedHydraulics.velocityMs < AUTO_TARGET_VELOCITY_MS,
    'PIPE2. locked oversize DN still gets fresh cache (low velocity)');

  // PS8. Default materials match service (§AK item 7).
  assert(defaultMaterialForPipeType('liquid') === 'pvc', 'PIPE2. liquid default PVC');
  assert(defaultMaterialForPipeType('sludge') === 'hdpe', 'PIPE2. sludge default HDPE');
  assert(defaultMaterialForPipeType('ras') === 'hdpe', 'PIPE2. RAS default HDPE');
  assert(defaultMaterialForPipeType('gas') === 'carbon_steel', 'PIPE2. gas default carbon steel');

  // PS9. CAPEX scales with diameter and material (§AM CAPEX row).
  assert(estimatePipeCAPEX(0.5, 'pvc', 10) > estimatePipeCAPEX(0.1, 'pvc', 10),
    'PIPE2. bigger DN costs more');
  assert(estimatePipeCAPEX(0.1, 'ductile_iron', 10) > estimatePipeCAPEX(0.1, 'pvc', 10),
    'PIPE2. stronger material costs more');

  // PS10. Legacy unsized pipes are untouched by the refresh — old saves stay valid.
  const legacy = mkPipe(9000);
  delete legacy.autoSized;
  delete legacy.materialId;
  refreshPipeHydraulics([legacy]);
  assert(legacy.diameterM === undefined && legacy.cachedHydraulics === undefined,
    'PIPE2. unsized legacy pipes stay untouched');
}

// ── PBILL: quantity-based pipe CAPEX billing (§AK item 11) ──────────────────
{
  // Path waypoints are in WORLD CELLS: pathLengthM = hypot(cells) × 6 m/cell.
  const mkDraft = (lenCells: number, dn?: number, materialId?: string): PipeConnection => ({
    id: `pbill_${Math.random().toString(36).slice(2, 8)}`,
    fromUnitId: 'u_src', fromPortId: 'outlet',
    toUnitId: 'u_dst', toPortId: 'inlet',
    pathPoints: [[0, 0, 0], [0, 0, lenCells]],
    flowRate: 0,
    quality: emptyWater(),
    pipeType: 'liquid',
    ...(dn !== undefined ? { diameterM: dn } : {}),
    ...(materialId !== undefined ? { materialId } : {}),
    autoSized: true,
  });
  /** Quote exactly as GameManager prices it (incl. the DN80 floor). */
  const quoteOf = (dn: number | undefined, mat: string | undefined, p: PipeConnection) =>
    estimatePipeCAPEX(dn ?? 0.1, mat ?? 'pvc', pathLengthM(p.pathPoints));

  const gsB = GameManager.createInitialState(0, false);
  const cashStart = 500000;
  const base: any = {
    ...gsB,
    financials: { ...gsB.financials, cash: cashStart },
    simSpeed: 1 as const,
  };

  // Bundle quote = sum of the per-pipe estimates the PFD panel displays (§AM CAPEX).
  const d1 = mkDraft(7, 0.1, 'pvc');           // 42 m run
  const d2 = mkDraft(20, 0.3, 'ductile_iron'); // 120 m run
  const expectTotal = quoteOf(0.1, 'pvc', d1) + quoteOf(0.3, 'ductile_iron', d2);

  const rBuy = GameManager.purchasePipes(base, [d1, d2]);
  assert(rBuy.success && rBuy.charged === expectTotal,
    `PBILL. bundle charge equals the sum of per-pipe estimates ($${expectTotal.toLocaleString()})`);
  assert(rBuy.success && rBuy.newState.financials.cash === cashStart - expectTotal,
    'PBILL. purchase debits cash exactly once');
  assert(rBuy.newState.pipes.length === 2 &&
    rBuy.newState.pipes.every(p => p.capexPaid !== undefined),
    'PBILL. purchased pipes carry their capexPaid basis');

  // §AM: pipe length alters CAPEX through the billing path too.
  const longOnly = GameManager.purchasePipes(base, [mkDraft(67, 0.1, 'pvc')]);
  const shortOnly = GameManager.purchasePipes(base, [mkDraft(2, 0.1, 'pvc')]);
  assert((longOnly.charged ?? 0) > (shortOnly.charged ?? 0),
    'PBILL. longer runs bill more at equal DN/material');

  // Unaffordable bundle rejected atomically — no pipes, no partial debit.
  const broke: any = { ...base, financials: { ...gsB.financials, cash: 50 } };
  const rBroke = GameManager.purchasePipes(broke, [d1]);
  assert(!rBroke.success && (rBroke.reason ?? '').includes('Insufficient funds') &&
    rBroke.newState.pipes.length === 0 && rBroke.newState.financials.cash === 50,
    'PBILL. unaffordable bundle rejected atomically');

  // Sandbox builds free but still records a basis for later change orders.
  const sbx: any = { ...base, gameMode: 'sandbox' };
  const rSbx = GameManager.purchasePipes(sbx, [d1]);
  assert(rSbx.success && rSbx.charged === undefined &&
    rSbx.newState.financials.cash === cashStart && rSbx.newState.pipes[0].capexPaid === 0,
    'PBILL. sandbox piping is free yet tags capexPaid=0');

  // Change order: DN upsize bills only the delta vs what was paid.
  const bought = rBuy.newState;
  const target = bought.pipes[0];
  const oldPaid = target.capexPaid!;
  const newQuote = quoteOf(0.3, target.materialId, target);
  const rUp = GameManager.updatePipeEngineering(bought, target.id, { diameterM: 0.3, autoSized: false });
  assert(rUp.success && rUp.charged === newQuote - oldPaid &&
    rUp.newState.pipes[0].diameterM === 0.3 && rUp.newState.pipes[0].autoSized === false &&
    rUp.newState.pipes[0].capexPaid === newQuote,
    'PBILL. DN upsize bills the exact delta, writes the pick, locks autoSized=false');
  assert(rUp.newState.financials.cash === bought.financials.cash - (newQuote - oldPaid),
    'PBILL. change-order delta debited once');

  // Downsizing refunds nothing and keeps the paid high-water mark.
  const rDown = GameManager.updatePipeEngineering(rUp.newState, target.id, { diameterM: 0.1 });
  assert(rDown.success && rDown.charged === undefined &&
    rDown.newState.pipes[0].capexPaid === newQuote &&
    rDown.newState.financials.cash === rUp.newState.financials.cash,
    'PBILL. downsize refunds nothing, basis stays at the high-water mark');

  // Legacy save (no capexPaid): first edit bills delta vs the DN80-floor estimate.
  const legacyPipe: PipeConnection = { ...mkDraft(10), diameterM: undefined, autoSized: undefined };
  delete legacyPipe.materialId;
  const gsLegacy: any = { ...base, pipes: [legacyPipe] };
  const legacyEst = quoteOf(undefined, undefined, legacyPipe);
  const rLeg = GameManager.updatePipeEngineering(gsLegacy, legacyPipe.id, { diameterM: 0.2 });
  assert(rLeg.success && rLeg.charged === quoteOf(0.2, undefined, legacyPipe) - legacyEst,
    'PBILL. legacy unsized pipe first edit bills delta vs its DN80-floor estimate');

  // Removal pays 70% salvage of billed pipes, nothing for legacy.
  const rRem = GameManager.removePipes(bought, new Set([target.id]));
  assert(rRem.refunded === Math.round(target.capexPaid! * GameManager.PIPE_SALVAGE_RATE) &&
    rRem.newState.pipes.length === 1,
    'PBILL. removal refunds 70% salvage of the billed CAPEX');
  const rRemLegacy = GameManager.removePipes(gsLegacy, new Set([legacyPipe.id]));
  assert(rRemLegacy.refunded === 0 && rRemLegacy.newState.pipes.length === 0,
    'PBILL. never-billed legacy pipes salvage $0');

  // Demolishing a unit folds its attached pipes' salvage into the payout.
  const casU = mkBlueprintUnit('activated_sludge_cas', 16, 20);
  const gsDemo: any = {
    ...bought,
    units: [{ ...casU }],
    selectedUnitId: casU.instanceId,
  };
  gsDemo.pipes = gsDemo.pipes.map((p: PipeConnection) => ({ ...p, fromUnitId: casU.instanceId }));
  const paidSum = gsDemo.pipes.reduce((s: number, p: PipeConnection) => s + (p.capexPaid ?? 0), 0);
  const afterNoPipes = GameManager.demolishUnit({ ...gsDemo, pipes: [] }, casU.instanceId);
  const afterWithPipes = GameManager.demolishUnit(gsDemo, casU.instanceId);
  assert(afterWithPipes.pipes.length === 0 &&
    afterWithPipes.financials.cash - afterNoPipes.financials.cash === Math.round(paidSum * GameManager.PIPE_SALVAGE_RATE),
    'PBILL. demolish pays attached-pipe salvage on top of the unit refund');

  // Tutorial training grant mirrors placeUnit: free build, zero refund.
  const tut: any = { ...base, tutorialActive: true };
  const rTutBuy = GameManager.purchasePipes(tut, [d1]);
  const rTutRem = GameManager.removePipes(rTutBuy.newState, new Set([rTutBuy.newState.pipes[0].id]));
  assert(rTutBuy.success && rTutBuy.charged === undefined &&
    rTutBuy.newState.financials.cash === cashStart && rTutRem.refunded === 0,
    'PBILL. tutorial grant builds free and refunds nothing on removal');
}

// ═══════════════════════════════════════════════════════════════════════════
// PEAK-FLOW DESIGN BASIS (§AK items 5/6) — full-strength diurnal readiness
// ═══════════════════════════════════════════════════════════════════════════
{
  const L1_AVG = 3500; // Level-1 municipal contract flow (m³/d)
  const avgH = L1_AVG / 24;

  // Factor math: derived from the influent anchors, municipal magnitudes.
  assert(Math.abs(PEAK_FLOW_FACTOR - DIURNAL_MAX_FACTOR) < 1e-12 &&
    Math.abs(PEAK_LOAD_FACTOR - (1 + 0.55 * (DIURNAL_MAX_FACTOR - 1))) < 1e-12,
    'PF1. peak factors derive from the diurnal anchors');
  assert(PEAK_FLOW_FACTOR > 1.4 && PEAK_FLOW_FACTOR < 1.5 &&
    PEAK_LOAD_FACTOR > 1.2 && PEAK_LOAD_FACTOR < 1.3,
    `PF2. municipal magnitudes sane (flow ×${PEAK_FLOW_FACTOR.toFixed(3)}, load ×${PEAK_LOAD_FACTOR.toFixed(3)})`);
  assert(peakFlowFactorForStrength(0) === 1 && peakLoadFactorForStrength(0) === 1,
    'PF3a. strength 0 = flat average day');
  assert(peakFlowFactorForStrength(-5) === 1, 'PF3b. negative strength clamps to flat');
  assert(peakFlowFactorForStrength(0.5) > 1 && peakFlowFactorForStrength(0.5) < peakFlowFactorForStrength(1),
    'PF3c. strength blend monotone toward the full curve');
  assert(Math.abs(peakDesignFlowM3d(L1_AVG, 1) - L1_AVG * DIURNAL_MAX_FACTOR) < 1e-9,
    'PF4. peakDesignFlow = avg × flow factor at full strength');

  // Balancing-volume integral: zero when flat, shrinks with faster drawdown.
  assert(requiredBalancingVolumeM3(avgH, avgH, 0) === 0, 'PF5a. flat curve needs no balancing storage');
  const vAvgOut = requiredBalancingVolumeM3(avgH, avgH, 1);
  const vFastOut = requiredBalancingVolumeM3(avgH, avgH * 1.2, 1);
  assert(vAvgOut > vFastOut,
    `PF5b. faster drawdown shrinks storage need (${vAvgOut.toFixed(0)} → ${vFastOut.toFixed(0)} m³)`);
  assert(vAvgOut > 10 && vAvgOut < 120, `PF5c. L1-scale balancing volume plausible (${vAvgOut.toFixed(0)} m³)`);

  // ── Template peak-readiness pins @ L1 (items 5/6 acceptance) ──
  const dpL1 = casDesignPoint(mkBlueprintUnit('activated_sludge_cas'), 210, 25, L1_AVG)!;
  assert(dpL1.capacityMarginRatio >= PEAK_LOAD_FACTOR,
    `PF6. CAS template covers the mass-load peak (margin ×${dpL1.capacityMarginRatio.toFixed(2)} ≥ ×${PEAK_LOAD_FACTOR.toFixed(3)})`);

  const clarGeo = defaultGeometryFor('secondary_clarifier')!;
  const loadL1 = evaluateClarifierLoad(clarGeo, L1_AVG, 3200, L1_AVG * 1.75, 0.25);
  assert(loadL1.sorM3M2Day * PEAK_FLOW_FACTOR < 24,
    `PF7. clarifier template peak-hour SOR ${(loadL1.sorM3M2Day * PEAK_FLOW_FACTOR).toFixed(1)} m/d below the 24 warning limit`);

  const eqCap = workingVolumeM3(defaultGeometryFor('equalization_basin')!);
  const balNeed = requiredBalancingVolumeM3(avgH, 160, 1); // template outflow target
  assert(balNeed <= eqCap * (1 - EQ_MIN_POOL_FRACTION),
    `PF8. EQ template holds the diurnal excursion (need ${balNeed.toFixed(0)} ≤ usable ${((eqCap) * (1 - EQ_MIN_POOL_FRACTION)).toFixed(0)} m³)`);

  assert(PUMP_MODELS.sewage_wedge_400.ratedFlowM3h >= peakDesignFlowM3d(L1_AVG, 1) / 24,
    'PF9. template pump delivers the peak hourly inflow');

  // ── Validator peak checks (pure helpers) ──
  assert(casPeakHeadroomIssue(dpL1) === null, 'PF10. healthy template raises no peak-headroom warning');
  const peakShortDp = { ...dpL1, fieldTransferCapacityKgDay: dpL1.netDemandKgDay * 1.1 };
  assert(casPeakHeadroomIssue(peakShortDp)?.code === 'blower_no_peak_headroom',
    'PF11. avg-ok/peak-short aeration warns blower_no_peak_headroom');
  const avgShortDp = { ...dpL1, fieldTransferCapacityKgDay: dpL1.netDemandKgDay * 0.9 };
  assert(casPeakHeadroomIssue(avgShortDp) === null,
    'PF12. avg-day undersized defers to blower_undersized');

  assert(clarifierPeakExposureIssues(19).length === 0, 'PF13a. SOR 19 m/d carries no peak exposure');
  assert(clarifierPeakExposureIssues(23.5)[0]?.code === 'sor_peak_exposure',
    'PF13b. SOR 23.5 m/d crosses the 33 m/d threshold at peak (≈34)');
  assert(clarifierPeakExposureIssues(30).length === 0, 'PF13c. SOR > 24 owned by sor_excessive');

  assert(eqDiurnalSizingIssue(20, avgH, avgH)?.code === 'eq_undersized_for_diurnal',
    'PF14a. basin too small for the fill-side excursion warns eq_undersized_for_diurnal');
  assert(eqDiurnalSizingIssue(eqCap, avgH, 160) === null, 'PF14b. template EQ passes the diurnal sizing check');

  // ── Full-strength flip ──
  assert(DIURNAL_DEFAULT_STRENGTH === 1.0, 'PF15. new games default to full municipal strength');
  const gsFresh = GameManager.createInitialState(0, false);
  assert(gsFresh.diurnalInfluentStrength === 1.0, 'PF16. createInitialState carries strength 1.0');
  const specL1 = createInfluentWater({ flowRate: L1_AVG, bod: 210 });
  const peakHour = applyDiurnalInfluent(specL1, 9.75 / 24, gsFresh.diurnalInfluentStrength);
  assert(Math.abs(peakHour.flowRate - L1_AVG * DIURNAL_MAX_FACTOR) < 1e-6,
    `PF17. morning peak delivers ×${(peakHour.flowRate / L1_AVG).toFixed(3)} influent flow`);
  let sumFlow = 0;
  for (let i = 0; i < 96; i++) sumFlow += applyDiurnalInfluent(specL1, (i * 0.25) / 24, 1).flowRate;
  assert(Math.abs(sumFlow / 96 - L1_AVG) < L1_AVG * 0.01,
    `PF18. full-strength day preserves the daily mean (${(sumFlow / 96).toFixed(0)} vs ${L1_AVG} m³/d)`);

  // ── Single-source coherence (iter 17): one basis, no private factors ──
  assert(VALIDATOR_REFERENCE_FLOW_M3D === L1_AVG,
    'PF19. validator sizing basis = L1 contract flow (one shared source)');
  const casFreshCodes = validateUnitDesign(mkBlueprintUnit('activated_sludge_cas')).map(i => i.code);
  assert(!casFreshCodes.includes('blower_undersized') &&
    !casFreshCodes.includes('blower_no_peak_headroom'),
    `PF20. fresh CAS template validates clean at the shared basis [${casFreshCodes.join(',') || 'none'}]`);
  const clarFreshCodes = validateUnitDesign(mkBlueprintUnit('secondary_clarifier')).map(i => i.code);
  assert(!clarFreshCodes.includes('sor_excessive') &&
    !clarFreshCodes.includes('sor_peak_exposure'),
    `PF21. fresh clarifier template carries no SOR warnings [${clarFreshCodes.join(',') || 'none'}]`);
  const loadCo = evaluateClarifierLoad(
    defaultGeometryFor('secondary_clarifier')!, L1_AVG, 3200, L1_AVG * 1.75, 0.25);
  assert(Math.abs(loadCo.peakSorM3M2Day - loadCo.sorM3M2Day * PEAK_FLOW_FACTOR) < 1e-9 &&
    Math.abs(loadCo.sorM3M2Day * 1.8 - loadCo.peakSorM3M2Day) > 1e-6,
    `PF22. clarifier peakSOR rides the shared factor ×${PEAK_FLOW_FACTOR.toFixed(3)}, not legacy ×1.8 ` +
      `(${loadCo.peakSorM3M2Day.toFixed(1)} vs ${(loadCo.sorM3M2Day * 1.8).toFixed(1)} m/d)`);

  // ── Per-contract design flow wired through placement context (iter 20) ──
  // When the player's contract carries a design flow, the validator must size
  // against THAT basis, not the Phase-1 shared heuristic. This retires the
  // VALIDATOR_REFERENCE_FLOW_M3D heuristic's stated exit condition.
  const nestedCas = mkBlueprintUnit('activated_sludge_cas');
  nestedCas.blueprint!.controls.designFlowM3d = 8000; // oversized contract
  const codes8000 = validateUnitDesign(nestedCas).map(i => i.code);
  assert(codes8000.includes('blower_undersized'),
    `PF23. per-contract design flow (8000) overrides heuristic — CAS now reports blower_undersized [${codes8000.join(',')}]`);
  const neonested = mkBlueprintUnit('activated_sludge_cas');
  const codesDefault = validateUnitDesign(neonested).map(i => i.code);
  assert(!codesDefault.includes('blower_undersized'),
    `PF23b. absent contract flow still falls back to the shared basis (clean) [${codesDefault.join(',') || 'none'}]`);
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? 'ALL ENGINEERING TESTS PASSED' : 'ENGINEERING TESTS FAILED'} (${passed} passed, ${failed} failed)`);
if (failed > 0) {
  console.error('\nFailures:\n' + failures.map(f => ' - ' + f).join('\n'));
  process.exit(1);
}
