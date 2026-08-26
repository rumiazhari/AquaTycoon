/**
 * MBR membrane engineering — Mission §Q + §R, migration slice 1 + 2.
 *
 * Replaces the legacy binary fouled/not-fouled heuristic with a real design
 * basis AND a runtime resistance/fouling progression.
 *
 * DESIGN BASIS (slice 1, used by the validator + Show Calculation):
 *   Flux            J = Qp·1000 / (Am·24)  [LMH]
 *   Required area   Am = Qp·1000 / (24·J)
 *   Clean TMP       TMP₀ = J / permeability          [kPa]
 *   Design-basis    TMP = TMP₀ · (1 + kFoul · foulLoad)
 *     foulLoad = foulingCoefficient · (TSS/TSSref) · (J/Jref) · scourPenalty
 *
 * RUNTIME PROGRESSION (slice 2, used by the simulation engine):
 *   Resistance is the inverse of permeability: R = 1/permeability. As foulant
 *   mass accumulates the effective permeability drops, so:
 *     R_t = R_clean · ρ            where ρ = resistanceMultiple
 *     J_actual = TMP / R_t  (lower permeability ⇒ lower sustainable flux)
 *   Fouling resistance RISES with TSS loading, operating flux and time, and
 *   FALLS with backwash and chemical cleaning (CIP), exactly as real MBR
 *   trains behave. The membrane barrier itself never fails (permeate TSS ≈ 0),
 *   but the TMP needed to push the same flow climbs — surfaced to the player
 *   as power/opex growth and an overload warning they can fix with cleaning.
 *
 * High flux: area↓ CAPEX↓ fouling↑ TMP↑ cleaning↑ replacement↑. Conservative:
 * CAPEX↑ resilience↑ — emergent from the formulas, not scripted bonuses.
 */

// ── §R membrane material catalog ─────────────────────────────────────────────
// Attributes carry technically defensible comparative behavior; no "+10%
// better" game bonuses. Permeability in LMH/kPa (1 bar = 100 kPa, so
// 300 LMH/bar ≈ 3.0 LMH/kPa).

export interface MembraneMaterial {
  id: string;
  name: string;
  /** Clean-water permeability at 20 °C (LMH per kPa). */
  permeabilityLmhPerKpa: number;
  /** Maximum recommended operating transmembrane pressure (kPa). */
  maxTmpKpa: number;
  /** Relative fouling affinity (dimensionless, 1 = typical PVDF baseline). */
  foulingCoefficient: number;
  /** Continuous free-chlorine dosing the polymer/ceramic tolerates (mg/L). */
  chlorineToleranceMgL: number;
  /** Qualitative sludge-abrasion robustness (hollow fiber break-in risk). */
  abrasionResistance: 'moderate' | 'high' | 'very_high';
  /** Module CAPEX intensity ($/m² of installed membrane area). */
  capexUsdPerM2: number;
  /** Expected service life under municipal duty (years). */
  lifetimeYears: number;
}

export const MEMBRANE_MATERIALS: Record<string, MembraneMaterial> = {
  pvdf_hollow_fiber: {
    id: 'pvdf_hollow_fiber',
    name: 'PVDF Hollow Fiber (immersed)',
    permeabilityLmhPerKpa: 3.0,
    maxTmpKpa: 60,
    foulingCoefficient: 1.0,
    chlorineToleranceMgL: 1000,
    abrasionResistance: 'high',
    capexUsdPerM2: 55,
    lifetimeYears: 8,
  },
  pes_hollow_fiber: {
    id: 'pes_hollow_fiber',
    name: 'PES Hollow Fiber (immersed)',
    // More hydrophilic → higher clean-water permeability, but oxidizes fast
    // and fouls more irreversibly than PVDF.
    permeabilityLmhPerKpa: 4.2,
    maxTmpKpa: 45,
    foulingCoefficient: 1.3,
    chlorineToleranceMgL: 50,
    abrasionResistance: 'moderate',
    capexUsdPerM2: 40,
    lifetimeYears: 6,
  },
  ceramic_multichannel: {
    id: 'ceramic_multichannel',
    name: 'Ceramic Multichannel',
    // Lower clean permeability per kPa than PES but withstands aggressive
    // cleaning, very high TMP, and decades of service.
    permeabilityLmhPerKpa: 5.5,
    maxTmpKpa: 150,
    foulingCoefficient: 0.65,
    chlorineToleranceMgL: 5000,
    abrasionResistance: 'very_high',
    capexUsdPerM2: 190,
    lifetimeYears: 20,
  },
};

/** Flux classification bands for immersed municipal MBR (LMH). */
export const FLUX_CONSERVATIVE_MAX_LMH = 18;
export const FLUX_NORMAL_MAX_LMH = 25;
export const FLUX_AGGRESSIVE_MAX_LMH = 30;

export type FluxClass = 'conservative' | 'normal' | 'aggressive' | 'critical';

export function classifyFlux(jLmh: number): FluxClass {
  if (jLmh <= FLUX_CONSERVATIVE_MAX_LMH) return 'conservative';
  if (jLmh <= FLUX_NORMAL_MAX_LMH) return 'normal';
  if (jLmh <= FLUX_AGGRESSIVE_MAX_LMH) return 'aggressive';
  return 'critical';
}

// ── Design math ──────────────────────────────────────────────────────────────

/** Required total membrane area (m²) to pass q m³/d at j LMH. */
export function requiredMembraneAreaM2(qM3d: number, jLmh: number): number {
  if (jLmh <= 0) return Infinity;
  return (qM3d * 1000) / (24 * jLmh);
}

/** Actual flux (LMH) achieved when passing q m³/d through area m². */
export function fluxAtArea(qM3d: number, areaM2: number): number {
  if (areaM2 <= 0) return Infinity;
  return (qM3d * 1000) / (24 * areaM2);
}

// ── Fouling basis constants (documented design assumptions) ──────────────────

/** Reference feed solids for the fouling basis: MBR mixed-liquor design band. */
export const FOUL_TSS_REF_MGL = 10000;
/** Reference flux for the fouling basis (LMH). */
export const FOUL_FLUX_REF_LMH = 20;
/** Dimensionless gain of the fouling term on clean TMP. */
export const FOUL_GAIN = 1.0;
/** Minimum specific air scour for sustainable operation (Nm³/h per m²). */
export const SCOUR_MIN_NM3H_PER_M2 = 0.15;
/** Penalty multiplier when air scour is below the minimum. */
export const SCOUR_PENALTY = 1.5;

export interface MembraneDesignInput {
  materialId: string;
  /** Total installed membrane area (moduleCount × areaPerModule upstream). */
  installedAreaM2: number;
  /** Operator's target design flux (LMH) — sizes the required-area check. */
  designFluxLmh: number;
  /** Specific air-scour demand (Nm³/h per m² of membrane area). */
  airScourNm3hPerM2: number;
}

export interface MembraneDesignPoint {
  material: MembraneMaterial;
  designFlowM3d: number;
  /** Area needed at the target flux (m²). */
  requiredAreaM2: number;
  installedAreaM2: number;
  /** Flux actually produced at design flow through the installed area. */
  actualFluxLmh: number;
  /** Clean-water TMP at actual flux (kPa). */
  cleanTmpKpa: number;
  /** Fouling/scour-adjusted design-basis TMP (kPa). */
  tmpEstimateKpa: number;
  /** tmpEstimate / material.maxTmp (>1 means exceeded). */
  tmpHeadroomRatio: number;
  fluxClass: FluxClass;
  scourAdequate: boolean;
}

/**
 * Design-basis evaluation of an MBR membrane installation at a given flow.
 * Feed TSS defaults to the mixed-liquor design band (MBRs run ON activated
 * sludge — high solids are normal here, unlike the old crude heuristic that
 * read exactly that as "fouled").
 */
export function evaluateMembraneDesign(
  design: MembraneDesignInput,
  opts: { designFlowM3d: number; feedTssMgL?: number },
): MembraneDesignPoint {
  const mat = MEMBRANE_MATERIALS[design.materialId] ?? MEMBRANE_MATERIALS.pvdf_hollow_fiber;
  const q = Math.max(0, opts.designFlowM3d);
  const tss = opts.feedTssMgL ?? FOUL_TSS_REF_MGL;

  const requiredAreaM2 = requiredMembraneAreaM2(q, design.designFluxLmh);
  const installedAreaM2 = Math.max(0, design.installedAreaM2);
  const actualFluxLmh = fluxAtArea(q, installedAreaM2);
  const cleanTmpKpa = actualFluxLmh / mat.permeabilityLmhPerKpa;

  const scourAdequate = design.airScourNm3hPerM2 >= SCOUR_MIN_NM3H_PER_M2;
  const scourPenalty = scourAdequate ? 1 : SCOUR_PENALTY;
  const foulLoad =
    mat.foulingCoefficient *
    (tss / FOUL_TSS_REF_MGL) *
    (actualFluxLmh / FOUL_FLUX_REF_LMH) *
    scourPenalty;
  const tmpEstimateKpa = cleanTmpKpa * (1 + FOUL_GAIN * foulLoad);

  return {
    material: mat,
    designFlowM3d: q,
    requiredAreaM2,
    installedAreaM2,
    actualFluxLmh,
    cleanTmpKpa,
    tmpEstimateKpa,
    tmpHeadroomRatio: tmpEstimateKpa / mat.maxTmpKpa,
    fluxClass: classifyFlux(actualFluxLmh),
    scourAdequate,
  };
}

// ── Runtime fouling progression (migration slice 2) ─────────────────────────
//
// Persistent per-unit membrane state. Held on the placed unit (`mbrFouling`)
// and advanced once per simulation day. All fields are plain numbers so the
// state survives JSON save/load unchanged.

export interface MbrFoulingState {
  /** Filtration resistance multiple vs clean membrane (1 = brand new). */
  resistanceMultiple: number;
  /** Days since the last maintenance clean (backwash/CIP). */
  daysSinceClean: number;
  /** Cumulative irreversible resistance multiple after last CIP (0 = none). */
  irreversibleMultiple: number;
  /** True once R exceeds the operator's cleaning threshold (advisory only). */
  cleaningDue: boolean;
}

/** A clean, healthy membrane at the start of operation. */
export const FRESH_MBR_FOULING: MbrFoulingState = {
  resistanceMultiple: 1,
  daysSinceClean: 0,
  irreversibleMultiple: 0,
  cleaningDue: false,
};

/** Resistance multiple at/above which the player is advised to clean. */
export const MBR_CLEANING_THRESHOLD = 1.6;
/** Hard ceiling on reversible resistance (prevents runaway + NaN). */
export const MBR_RESISTANCE_CEIL = 4.0;
/** Reversible component is scrubbed back to this fraction per CIP. */
export const MBR_CIP_RESIDUAL = 0.15;
/** Daily reversible-resistance growth coefficient (calibrated). */
export const MBR_FOUL_RATE_PER_DAY = 0.045;
/** Daily reversible recovery from routine backwash. */
export const MBR_BACKWASH_RECOVERY_PER_DAY = 0.012;

export interface AdvanceFoulingInput {
  /** Current fouling state (mutated-free: returns a new object). */
  prev: MbrFoulingState;
  /** Membrane material id (PVDF/PES/ceramic). */
  materialId: string;
  /** Feed mixed-liquor TSS (mg/L) — higher solids foul faster. */
  feedTssMgL: number;
  /** Operating flux through the installed area (LMH). */
  fluxLmh: number;
  /** Specific air-scour demand (Nm³/h per m²); below minimum fouls faster. */
  airScourNm3hPerM2: number;
  /** Days elapsed this tick (fractional ok). 0 = snapshot, no change. */
  dtDays: number;
}

/**
 * Advances the membrane fouling state by dtDays.
 *
 * Resistance RISES with TSS loading, operating flux and elapsed time, and
 * FALLS with routine backwash; CIP (performMembraneClean) drops it further.
 * The reversible fraction is what accumulates day to day; the irreversible
 * fraction only moves when CIP strips accumulated irreversible fouling.
 */
export function advanceMbrFouling(input: AdvanceFoulingInput): MbrFoulingState {
  const mat = MEMBRANE_MATERIALS[input.materialId] ?? MEMBRANE_MATERIALS.pvdf_hollow_fiber;
  const dt = Math.max(0, input.dtDays);
  if (dt <= 0) return { ...input.prev };

  const tssFactor = Math.max(0.4, input.feedTssMgL / FOUL_TSS_REF_MGL);
  const fluxFactor = Math.max(0.5, input.fluxLmh / FOUL_FLUX_REF_LMH);
  const scourAdequate = input.airScourNm3hPerM2 >= SCOUR_MIN_NM3H_PER_M2;
  const scourPenalty = scourAdequate ? 1 : SCOUR_PENALTY;
  // Material fouling affinity sets how fast resistance accumulates.
  const foulDriver = mat.foulingCoefficient * tssFactor * fluxFactor * scourPenalty;

  // Reversible resistance = total − fixed irreversible baseline.
  const reversibleNow = Math.max(1, input.prev.resistanceMultiple - input.prev.irreversibleMultiple);
  const growth = MBR_FOUL_RATE_PER_DAY * foulDriver * dt;
  const recovery = MBR_BACKWASH_RECOVERY_PER_DAY * dt;
  let reversibleNext = reversibleNow + growth - recovery;
  reversibleNext = Math.max(1, Math.min(MBR_RESISTANCE_CEIL, reversibleNext));

  const resistanceMultiple = Math.min(
    MBR_RESISTANCE_CEIL,
    reversibleNext + input.prev.irreversibleMultiple,
  );
  const daysSinceClean = input.prev.daysSinceClean + dt;

  return {
    resistanceMultiple,
    daysSinceClean,
    irreversibleMultiple: input.prev.irreversibleMultiple,
    cleaningDue: resistanceMultiple >= MBR_CLEANING_THRESHOLD,
  };
}

/**
 * Chemical cleaning (CIP / backwash event). Strips most of the reversible
 * resistance and a fraction of the irreversible accumulation, resets the
 * clean-day clock. Returns the new state — never mutates the input.
 */
export function performMembraneClean(prev: MbrFoulingState): MbrFoulingState {
  const reversibleNow = Math.max(1, prev.resistanceMultiple - prev.irreversibleMultiple);
  const reversibleAfter = 1 + (reversibleNow - 1) * MBR_CIP_RESIDUAL;
  const irreversibleAfter = prev.irreversibleMultiple * MBR_CIP_RESIDUAL;
  const resistanceMultiple = Math.min(MBR_RESISTANCE_CEIL, reversibleAfter + irreversibleAfter);
  return {
    resistanceMultiple,
    daysSinceClean: 0,
    irreversibleMultiple: irreversibleAfter,
    cleaningDue: resistanceMultiple >= MBR_CLEANING_THRESHOLD,
  };
}

// ── CIP cleaning economics (migration slice 3) ──────────────────────────────
// A clean is a real maintenance operation: hypochlorite/citric-acid dosing,
// soak, neutralization and disposal of spent chemicals, plus technician labor.
// Cost scales with installed membrane area; reagent demand scales with the
// material's fouling affinity (a heavier-fouling membrane needs stronger or
// more frequent chemistry).

/** CIP chemical + labor + disposal cost basis ($ per m² of installed area). */
export const MBR_CIP_COST_USD_PER_M2 = 2.4;

/**
 * Quoted cost of ONE clean-in-place event for an installation.
 * Deterministic: area × basis × material reagent factor (0.8 + 0.4·foulCoeff).
 */
export function membraneCipCostUsd(materialId: string, installedAreaM2: number): number {
  const mat = MEMBRANE_MATERIALS[materialId] ?? MEMBRANE_MATERIALS.pvdf_hollow_fiber;
  const area = Math.max(0, installedAreaM2);
  return Math.round(area * MBR_CIP_COST_USD_PER_M2 * (0.8 + 0.4 * mat.foulingCoefficient));
}

export interface MbrRuntimePoint {
  /** Current operating flux (LMH) — drops as resistance climbs at fixed TMP. */
  fluxLmh: number;
  /** Estimated TMP to push the design flow through current resistance (kPa). */
  tmpKpa: number;
  /** TMP referenced to the material's rated maximum (1 = at rating). */
  tmpHeadroomRatio: number;
  /** Power multiplier from elevated TMP (∝ resistanceMultiple). */
  powerMult: number;
  /** Opex multiplier from elevated TMP + cleaning frequency. */
  opexMult: number;
  /** Resistance multiple vs clean membrane. */
  resistanceMultiple: number;
  cleaningDue: boolean;
}

/**
 * Runtime operating point for the MBR at its current fouling state. Used by
 * the process model to degrade flux / raise power+opex and by the Diagnostics
 * Show-Calculation block to display the live numbers.
 */
export function evaluateMbrRuntime(
  design: MembraneDesignInput,
  flowM3d: number,
  foul: MbrFoulingState,
): MbrRuntimePoint {
  const mat = MEMBRANE_MATERIALS[design.materialId] ?? MEMBRANE_MATERIALS.pvdf_hollow_fiber;
  const installedAreaM2 = Math.max(1, design.installedAreaM2);
  const targetFluxLmh = design.designFluxLmh || FOUL_FLUX_REF_LMH;

  // TMP needed to push the design flow: TMP = J / (permeability / ρ).
  const rho = Math.max(1e-3, foul.resistanceMultiple);
  const effectivePerm = mat.permeabilityLmhPerKpa / rho;
  const actualFluxLmh = fluxAtArea(flowM3d, installedAreaM2);

  // Equivalent TMP at the design target flux through current resistance.
  const tmpKpa = (targetFluxLmh / effectivePerm);
  const powerMult = rho; // suction/permeate pumping scales with resistance
  // Cleaning frequency rises once over threshold → maintenance opex climbs.
  const opexMult = 1 + 0.25 * Math.max(0, foul.resistanceMultiple - 1)
    + (foul.cleaningDue ? 0.15 : 0);

  return {
    fluxLmh: actualFluxLmh,
    tmpKpa,
    tmpHeadroomRatio: tmpKpa / mat.maxTmpKpa,
    powerMult,
    opexMult,
    resistanceMultiple: foul.resistanceMultiple,
    cleaningDue: foul.cleaningDue,
  };
}
