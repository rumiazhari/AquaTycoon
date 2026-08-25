/**
 * ActivatedSludge (Prompts §F/G/H) — first full reference implementation of
 * the engineered process architecture.
 *
 * DESIGN  → geometry, diffusers, blowers, design MLSS, target SRT.
 * CONTROL → DO setpoint, WAS rate, RAS ratio (what the operator asks).
 * RUNTIME → actual DO from the O2 balance; MLSS from a dynamic biomass
 *           balance; SRT DERIVED from inventory/wasting. Setpoints are never
 *           copied into runtime — the physics decides what is achievable.
 *
 * Key equations (Metcalf & Eddy style, gameplay-lumped):
 *   F/M          = Q·S0 / (V·X)
 *   O2 demand    = Q·(S0−S)/(f·860) ... converted to kgO2/d below, plus
 *                  nitrification demand 4.57 kgO2/kgNH4-N, minus
 *                  denitrification credit 2.86 kgO2/kgNO3-N reduced.
 *   OTR (supply) = airflow · (depth·ε) · 24   [kgO2/d]
 *   dX/dt        = Y·r_S − k_d·X − X_wasted/V − X_carriedOut/V
 *   SRT          = V·X / (Qwas·Xwas + Qeff·Xeff)
 */

import type { PlacedUnit } from '../../types/simulation';
import { workingVolumeM3 } from '../../design/Geometry';
import {
  BLOWER_MODELS,
  installedBlowerCapacity,
  diffuserTransferEfficiency,
} from '../../design/catalogs/Equipment';
import type { CommissioningState } from '../../design/UnitBlueprint';

// ── Design-time calculations ─────────────────────────────────────────────────

export interface CASDesignPoint {
  volumeM3: number;
  hrtHoursAtDesignFlow: number;
  fmRatioDay: number;
  organicLoadingKgBodM3d: number;
  /** Oxygen demand at given loading (kg O2/d). */
  oxygenDemandKgDay: number;
  nitrificationDemandKgDay: number;
  denitrificationCreditKgDay: number;
  netDemandKgDay: number;
  /** Transfer capacity of installed blowers+diffusers at clean water (kg O2/d). */
  oxygenTransferCapacityKgDay: number;
  /** Capacity derated for fouling + field conditions. */
  fieldTransferCapacityKgDay: number;
  capacityMarginRatio: number; // >1 = headroom, <1 = undersized
}

export function casDesignPoint(
  unit: PlacedUnit,
  influentBodMgL: number,
  influentNh4MgL: number,
  designFlowM3Day: number,
  effluentBodTargetMgL: number = 20
): CASDesignPoint | null {
  const bp = unit.blueprint;
  if (!bp || bp.processType !== 'activated_sludge_cas') return null;
  const cas = bp.equipment as import('../../design/UnitBlueprint').CASDesign;

  const V = workingVolumeM3(bp.design.geometry);
  if (V <= 0 || designFlowM3Day <= 0) return null;

  const hrtHours = (24 * V) / designFlowM3Day;
  const mlss = cas.designMlssMgL; // g/m³ numerically
  const fm = (designFlowM3Day * influentBodMgL) / (V * mlss);
  const organicLoading = (designFlowM3Day * influentBodMgL) / 1000 / V;

  // ── Oxygen demand ──
  // Carbonaceous: BOD removed ≈ yield-corrected O2 ≈ Q·ΔS / f where f accounts
  // for the fraction of substrate electron equivalents actually oxidized
  // (1 − yield effect); classic aeration-design shortcut uses ~0.68 kgO2/kgBOD
  // removed at typical yields... we use the aeration-design standard:
  // O2 = Q·(S0−S)/f − 1.42·Xw  with f=0.68 (biodegradable fraction), then add
  // nitrification and subtract denitrification credit.
  const bodRemovedKgDay = ((designFlowM3Day * (influentBodMgL - effluentBodTargetMgL)) / 1000);
  const carbonaceousKgDay = Math.max(0, bodRemovedKgDay) / 0.68 - 1.42 * ((designFlowM3Day * 0.06)); // waste solids term approximated at design stage
  const nitrifDemand = (4.57 * designFlowM3Day * influentNh4MgL) / 1000;
  // Assume ~35% of influent TKN is denitrified in pre-anoxic/floc zones when
  // configured (gameplay-lumped; A2O migration will compute this properly).
  const denitCredit = (2.86 * designFlowM3Day * influentNh4MgL * 0.35) / 1000;
  const netDemand = Math.max(
    carbonaceousKgDay > 0 ? carbonaceousKgDay : 0,
    carbonaceousKgDay - denitCredit
  ) + nitrifDemand;

  // ── Supply side ──
  // Transfer capacity = air mass flow × OTE at design submergence.
  // Air ≈ 1.293 kg/m³; OTE (fraction of O2 transferred per m submergence)
  // already folds in the 0.297 kgO2/kgair oxygen fraction via calibration.
  const depth =
    bp.design.geometry.shape === 'rect'
      ? bp.design.geometry.waterDepthM
      : bp.design.geometry.sideWaterDepthM;
  const blowers = installedBlowerCapacity(cas.blowerModelId, cas.blowerRedundancyId);
  const ote = diffuserTransferEfficiency(cas.diffuserModelId, depth, 1.0);
  const airflow = blowers ? blowers.totalRatedAirflowM3h : 0;
  const airMassKgDay = airflow * 1.293 * 24;
  const transferCapacity = airMassKgDay * ote; // kg O2/d delivered to liquid

  return {
    volumeM3: V,
    hrtHoursAtDesignFlow: hrtHours,
    fmRatioDay: fm,
    organicLoadingKgBodM3d: organicLoading,
    oxygenDemandKgDay: Math.max(0, carbonaceousKgDay),
    nitrificationDemandKgDay: nitrifDemand,
    denitrificationCreditKgDay: denitCredit,
    netDemandKgDay: netDemand,
    oxygenTransferCapacityKgDay: transferCapacity,
    fieldTransferCapacityKgDay: transferCapacity * 0.72, // αF field factor
    capacityMarginRatio: transferCapacity * 0.72 / Math.max(1e-6, netDemand),
  };
}

// ── Runtime state machine ────────────────────────────────────────────────────

export interface CASRuntimeInputs {
  inlet: {
    flowRate: number;      // m³/d mixed liquor entering reactor
    bod: number; cod: number; tss: number; tn: number; nh4: number; no3: number;
    tp: number; pathogens: number; do: number; ph: number;
    turbidity: number; toxicIndex: number; temp?: number;
  };
  controls: { doSetpointMgL: number; wasRateM3d: number };
  dtDays: number;
  commissioning: CommissioningState;
  biomassKg: number;
}

export interface CASRuntimeOutput {
  effluent: {
    flowRate: number; bod: number; cod: number; tss: number; tn: number;
    nh4: number; no3: number; tp: number; pathogens: number; do: number;
    ph: number; turbidity: number; toxicIndex: number;
  };
  newBiomassKg: number;
  srtDays: number;
  actualDoMgL: number;
  powerKw: number;
  commissioning: CommissioningState;
  diagnostics: {
    hrtHours: number;
    fmRatio: number;
    ourKgO2Day: number;
    suppliedKgO2Day: number;
    oxygenLimited: boolean;
    blowerUtilization: number;
    wasActualM3d: number;
    mlssMgL: number;
    nitrifyingCapacityFraction: number;
  };
}

const EMPTY_OUT = () => ({
  flowRate: 0, bod: 0, cod: 0, tss: 0, tn: 0, nh4: 0, no3: 0, tp: 0,
  pathogens: 0, do: 0, ph: 7.2, turbidity: 1, toxicIndex: 0,
});

/** Seed inventory targets when commissioning starts (mg/L equivalent). */
const SEED_MLSS_MGL_NATURAL = 40;
const SEED_MLSS_MGL_IMPORTED = 800;
void SEED_MLSS_MGL_NATURAL;

export function stepCasRuntime(unit: PlacedUnit, input: CASRuntimeInputs): CASRuntimeOutput {
  const bp = unit.blueprint!;
  const cas = bp.equipment as import('../../design/UnitBlueprint').CASDesign;
  const geo = bp.design.geometry;
  const V = workingVolumeM3(geo);

  let comm = { ...input.commissioning };
  let X_kg = input.biomassKg;

  // ── Commissioning phase progression ──
  const advancePhase = (next: CommissioningState['phase'], daysNeeded: number): boolean => {
    if (comm.daysInPhase >= daysNeeded) {
      comm = { ...comm, phase: next, daysInPhase: 0 };
      return true;
    }
    return false;
  };

  switch (comm.phase) {
    case 'empty':
      // Reactor fills hydraulically within hours — treat as instant on flow.
      // A SEEDED reactor (operator trucks in mature seed sludge from another
      // plant) begins life with a developed biomass community: near-design
      // performance from day one. An UNSEEDED one must grow its own culture
      // through the full multi-week commissioning schedule below.
      if (input.inlet.flowRate > 1) {
        if (input.commissioning.seededWithSludge) {
          X_kg = Math.max(X_kg, V * SEED_MLSS_MGL_IMPORTED / 1000); // ~800 mg/L equivalent
          comm = { ...comm, phase: 'stable', daysInPhase: 0 };
        } else {
          comm = { ...comm, phase: 'fill', daysInPhase: 0 };
        }
      }
      break;
    case 'fill':
      if (advancePhase('seed', 0.25)) {
        // Natural startup: whatever biomass rides in with the influent.
        X_kg = Math.max(X_kg, V * 40 / 1000); // ~40 mg/L equivalent
      }
      break;
    case 'seed':
      if (advancePhase('startup', 0.5)) { /* seed contact period */ }
      break;
    case 'startup':
      advancePhase('developing', 3);
      break;
    case 'developing':
      advancePhase('nitrification_establishing', 8);
      break;
    case 'nitrification_establishing':
      advancePhase('stable', 10);
      break;
  }

  const seededBoost = comm.seededWithSludge && comm.phase !== 'empty' && comm.phase !== 'fill';
  if (seededBoost && X_kg < V * 800 / 1000 && comm.phase === 'startup') {
    X_kg = Math.max(X_kg, V * 800 / 1000); // seed sludge delivers ~800 mg/L immediately
  }

  const inFlow = Math.max(0, input.inlet.flowRate);
  const HRT_h = inFlow > 0 ? (24 * V) / inFlow : Infinity;

  // kg/m³ → mg/L is ×1000: MLSS = (biomassKg / V)·1000.
  const mlssMgL = (X_kg / Math.max(1e-6, V)) * 1000;

  // ── Oxygen supply vs demand ──
  const casDepth = geo.shape === 'rect' ? geo.waterDepthM : geo.sideWaterDepthM;
  const blowers = installedBlowerCapacity(cas.blowerModelId, cas.blowerRedundancyId);
  const cond = unit.condition;
  const fouling = cond?.diffuserFoulingFactor ?? 1.0;
  const ote = diffuserTransferEfficiency(cas.diffuserModelId, casDepth, fouling);
  const installedAir = blowers ? blowers.totalRatedAirflowM3h : 0;
  const airMassKgDay = installedAir * 1.293 * 24;

  // Demand: carbonaceous (from actual load) + nitrification − credit.
  const bodLoadKgDay = (inFlow * input.inlet.bod) / 1000;
  const carbonaceous = bodLoadKgDay / 0.68 * 0.85; // fraction truly oxidized
  const nh4LoadKgDay = (inFlow * input.inlet.nh4) / 1000;
  // Nitrifier population grows with SRT & maturity; capacity fraction 0..1
  const srtEstimate = Math.max(1, input.biomassKg > 0 ? estimateSrt(X_kg, input.controls.wasRateM3d, inFlow, mlssMgL) : 1);
  const nitrifMaturity = nitrificationMaturity(comm, srtEstimate);
  const nitrifiableNh4 = nh4LoadKgDay * nitrifMaturity.capacity;
  const nitrifDemand = 4.57 * nitrifiableNh4;
  const denitCredit = 2.86 * nitrifiableNh4 * 0.30;
  const ourKgDay = Math.max(0, carbonaceous + nitrifDemand - denitCredit);

  // Controller tries to satisfy the setpoint but cannot exceed supply.
  const demandedForSetpoint =
    ourKgDay + basalKgDay(V); // endogenous respiration baseline
  const supplyNeededForSetpoint = demandedForSetpoint / Math.max(1e-6, ote * 0.9);
  const requestedAirMass = supplyNeededForSetpoint; // mass basis (kg air/d)
  const vfdCapable = blowers && BLOWER_MODELS[cas.blowerModelId]?.hasVFD;
  const minTurndown = BLOWER_MODELS[cas.blowerModelId]?.minimumTurndown ?? 0.55;
  const airMassUsed = Math.min(
    airMassKgDay,
    Math.max(requestedAirMass, airMassKgDay * minTurndown)
  );
  void vfdCapable;

  const suppliedKgDay = airMassUsed * ote;
  const blowerUtilization = airMassKgDay > 0 ? airMassUsed / airMassKgDay : 0;
  const o2DeficitRatio = suppliedKgDay / Math.max(1e-6, demandedForSetpoint);

  // Actual DO from supply/demand balance: saturating Monod-style mapping.
  const doSetpoint = input.controls.doSetpointMgL;
  const achievedFraction = Math.min(1, o2DeficitRatio);
  const actualDo = Math.max(0.05, doSetpoint * achievedFraction);

  const oxygenLimited = o2DeficitRatio < 0.95;

  // ── Process kinetics driven by ACTUAL DO and biomass state ──
  const doFactor = actualDo / (0.3 + actualDo);
  const toxicPenalty = Math.max(0.15, 1 - (input.inlet.toxicIndex / 100) * 0.8);
  const maturityPenalty =
    comm.phase === 'stable' ? 1 :
    comm.phase === 'nitrification_establishing' ? 0.75 :
    comm.phase === 'developing' ? 0.55 :
    comm.phase === 'startup' ? 0.3 : 0.12;

  const bodRemoval = Math.min(0.97, 0.93 * doFactor * toxicPenalty * maturityPenalty);
  const removedBod = input.inlet.bod * bodRemoval;
  const out = EMPTY_OUT();
  out.flowRate = inFlow; // reactors pass through full mixed-liquor flow
  out.bod = input.inlet.bod - removedBod;
  out.cod = Math.max(12, input.inlet.cod - removedBod * 1.6);

  // Nitrification: needs mature autotrophs, DO>1, SRT sufficient.
  const nitrifRate =
    actualDo > 1.0 && nitrifMaturity.srtOk
      ? 0.85 * nitrifMaturity.capacity * (actualDo / (1.3 + actualDo))
      : actualDo > 0.5
      ? 0.10 * nitrifMaturity.capacity
      : 0.03;
  const nitrified = input.inlet.nh4 * nitrifRate;
  out.nh4 = input.inlet.nh4 - nitrified;
  out.no3 = Math.max(0, input.inlet.no3 + nitrified * 0.75);
  const assimilatedN = nitrified * 0.20;
  const denitrified = nitrified * 0.30;
  out.tn = out.nh4 + out.no3 + Math.max(0.5, (input.inlet.tn - input.inlet.nh4 - input.inlet.no3) * 0.25) - assimilatedN - denitrified;
  out.tss = Math.max(8, mlssMgL * 0.004 + 6); // floc carryover proxy (clarifier refines)
  out.tp = input.inlet.tp * 0.75;
  out.pathogens = input.inlet.pathogens * Math.max(0.02, 1 - 1.7 * maturityPenalty);
  out.ph = input.inlet.ph;
  out.toxicIndex = Math.max(0, input.inlet.toxicIndex - 25 * maturityPenalty);
  out.do = actualDo;
  out.turbidity = Math.max(1.5, out.tss * 0.8);

  // ── Biomass balance (Prompt §G): growth − decay − wasting − carryover ──
  // Growth is a MASS rate: kg biomass/d = Y · (Q · ΔS_mg/L / 1000).
  const Y = 0.6;         // kg biomass/kg BOD removed
  const kd = 0.06;       // endogenous decay /day
  const growthKgDay = Y * ((inFlow * removedBod) / 1000);
  const decay = kd * X_kg;
  const wastedKgDay = wasteSolidsKgDay(input.controls.wasRateM3d, mlssMgL);
  const carryoutKgDay = (out.flowRate * out.tss) / 1000;
  let newX = X_kg + (growthKgDay - decay - wastedKgDay - carryoutKgDay) * input.dtDays;
  newX = Math.max(0, Math.min(newX, V * 6)); // cap at 6000 mg/L equivalent
  if (inFlow <= 0.01 && comm.phase === 'empty') newX = 0;

  // ── Power: blower wire-to-air at actual duty ──
  const model = BLOWER_MODELS[cas.blowerModelId];
  const airFrac = blowerUtilization;
  // Turbo blowers keep efficiency at turndown; lobes lose it.
  const effDegradation = model?.hasVFD ? 1 : 0.75 + 0.25 * airFrac;
  // Blower shaft power ≈ Q·Δp / η (Q in m³/s, Δp in kPa → /1000... folded).
  const blowerKw =
    ((installedAir * airFrac) / 3600) *
    (casDepth + 5) * // submergence + distribution losses ≈ kPa
    (100 / (model?.isentropicEfficiency ?? 0.65) / (model?.motorEfficiency ?? 0.92)) /
    100;
  const powerKw = blowerKw * effDegradation;

  return {
    effluent: out,
    newBiomassKg: newX,
    srtDays: srtEstimate,
    actualDoMgL: actualDo,
    powerKw,
    commissioning: comm,
    diagnostics: {
      hrtHours: HRT_h === Infinity ? 0 : HRT_h,
      fmRatio: inFlow * input.inlet.bod / 1000 / Math.max(1e-6, X_kg),
      ourKgO2Day: ourKgDay + basalKgDay(V),
      suppliedKgO2Day: suppliedKgDay,
      oxygenLimited,
      blowerUtilization,
      wasActualM3d: Math.min(input.controls.wasRateM3d, inFlow * 0.2),
      mlssMgL,
      nitrifyingCapacityFraction: nitrifMaturity.capacity,
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function basalKgDay(volumeM3: number): number {
  return volumeM3 * 0.024; // endogenous baseline respiration
}

function wasteSolidsKgDay(wasRateM3d: number, mlssMgL: number): number {
  // WAS pulls blanket-density sludge (~ MLSS × 1.6 concentration factor from
  // the clarifier underflow); here conservatively at MLSS itself.
  return (wasRateM3d * mlssMgL) / 1000;
}

function estimateSrt(
  biomassKg: number,
  wasRateM3d: number,
  forwardFlowM3d: number,
  mlssMgL: number
): number {
  const wasted = wasteSolidsKgDay(wasRateM3d, mlssMgL);
  const carriedOut = (forwardFlowM3d * Math.max(6, mlssMgL * 0.004)) / 1000;
  const totalRemoval = wasted + carriedOut;
  if (totalRemoval < 1e-6) return 999;
  return biomassKg / totalRemoval;
}

export interface NitrificationMaturity {
  /** 0..1 autotroph population relative to fully-mature capability. */
  capacity: number;
  srtOk: boolean;
}

/**
 * Autotrophs grow far slower than heterotrophs: full nitrification needs both
 * commissioning maturity AND an SRT comfortably above ~2× their doubling time
 * (~8 d minimum, robust ≥ 12 d).
 */
export function nitrificationMaturity(
  comm: CommissioningState,
  srtDays: number
): NitrificationMaturity {
  const phaseCap =
    comm.phase === 'stable' ? 1 :
    comm.phase === 'nitrification_establishing' ? 0.55 :
    comm.phase === 'developing' ? 0.25 :
    comm.phase === 'startup' ? 0.05 : 0;
  const srtOk = srtDays >= 8;
  const srtFactor = srtOk ? Math.min(1, 0.6 + 0.4 * Math.min(1, (srtDays - 8) / 8)) : Math.max(0.1, srtDays / 16);
  return { capacity: phaseCap * srtFactor, srtOk };
}
