/**
 * MBR membrane engineering — Mission §Q + §R, migration slice 1.
 *
 * Replaces the legacy binary fouled/not-fouled heuristic with a real design
 * basis:
 *
 *   Flux            J = Qp·1000 / (Am·24)  [LMH]
 *   Required area   Am = Qp·1000 / (24·J)
 *   Clean TMP       TMP₀ = J / permeability          [kPa]
 *   Design-basis    TMP = TMP₀ · (1 + kFoul · foulLoad)
 *     foulLoad = foulingCoefficient · (TSS/TSSref) · (J/Jref) · scourPenalty
 *
 * High flux: area↓ CAPEX↓ fouling↑ TMP↑ cleaning↑ replacement↑. Conservative:
 * CAPEX↑ resilience↑ — emergent from the formulas, not scripted bonuses.
 * This module is DESIGN-TIME physics (validator + Show Calculation); the
 * runtime resistance/fouling progression lands with the next MBR slice.
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
