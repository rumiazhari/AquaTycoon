import type { TreatmentStandard, WaterQuality } from '../types/simulation';

/**
 * PermitEngine — THE single authoritative regulatory-compliance evaluator.
 *
 * Every player-facing compliance surface (Header HUD water-quality chip,
 * Operator Console report, PFD regulatory table, campaign objective/victory
 * logic via SimulationEngine, advisory ranking) MUST derive from this module
 * so no two UIs can ever disagree about whether the plant is compliant.
 *
 * Criteria mirror SimulationEngine's permit check exactly (11 criteria):
 * BOD, COD, TSS, TN, NH4, TP, pathogens (TRUE ZERO limit supported),
 * DO minimum, pH band (min AND max), turbidity.
 *
 * NOTE: a genuine `maxPathogens = 0` is a real sterilization-class permit.
 * It is evaluated literally (`value <= 0`) — never clamped to 1, never
 * weakened for display convenience.
 */

/** Stable criterion keys. `ph_low` / `ph_high` are separate CRITERIA (the sim
 *  counts them independently) but merge into one display ROW in UI tables. */
export type PermitCriterionKey =
  | 'bod' | 'cod' | 'tss' | 'tn' | 'nh4' | 'tp'
  | 'pathogens' | 'do' | 'ph_low' | 'ph_high' | 'turbidity';

export interface PermitCriterion {
  key: PermitCriterionKey;
  /** Effluent value being judged. */
  value: number;
  /** Applicable numeric bound (`maxPh` for `ph_high`, `minDo` for `do`, …). */
  limit: number;
  /** true → value must be ≥ limit (minimum criteria: DO, pH-low). */
  isMinimum: boolean;
  /** Verdict for THIS criterion. */
  pass: boolean;
  /** Identical message string the SimulationEngine pushes into its violation
   *  list — kept byte-for-byte compatible with the historical permit check. */
  engineMessage: string;
}

const fmtNum = (n: number, d: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(d);

/**
 * Evaluate ALL applicable permit criteria for an effluent sample.
 * Order matches SimulationEngine's historical check sequence.
 */
export function evaluatePermitCriteria(
  eff: WaterQuality,
  std: TreatmentStandard
): PermitCriterion[] {
  const c = (
    key: PermitCriterionKey,
    value: number,
    limit: number,
    isMinimum: boolean,
    engineMessage: string
  ): PermitCriterion => ({
    key, value, limit, isMinimum,
    pass: isMinimum ? value >= limit : value <= limit,
    engineMessage,
  });

  return [
    c('bod',       eff.bod,       std.maxBod,       false, `BOD (${eff.bod.toFixed(1)} > ${std.maxBod} mg/L)`),
    c('cod',       eff.cod,       std.maxCod,       false, `COD (${eff.cod.toFixed(1)} > ${std.maxCod} mg/L)`),
    c('tss',       eff.tss,       std.maxTss,       false, `TSS (${eff.tss.toFixed(1)} > ${std.maxTss} mg/L)`),
    c('tn',        eff.tn,        std.maxTn,        false, `TN (${eff.tn.toFixed(1)} > ${std.maxTn} mg/L)`),
    c('nh4',       eff.nh4,       std.maxNh4,       false, `Ammonia (${eff.nh4.toFixed(1)} > ${std.maxNh4} mg/L NH4-N)`),
    c('tp',        eff.tp,        std.maxTp,        false, `TP (${eff.tp.toFixed(2)} > ${std.maxTp} mg/L)`),
    // TRUE ZERO support: `pathogens <= 0` passes a 0-limit permit; any positive
    // reading fails it. No Math.max(1, …) clamping anywhere.
    c('pathogens', eff.pathogens, std.maxPathogens, false, `Pathogens (${eff.pathogens.toFixed(0)} > ${std.maxPathogens} CFU)`),
    c('do',        eff.do,        std.minDo,        true,  `DO (${eff.do.toFixed(1)} < ${std.minDo} mg/L)`),
    c('ph_low',    eff.ph,        std.minPh,        true,  `pH too low (${eff.ph.toFixed(2)} < ${std.minPh})`),
    c('ph_high',   eff.ph,        std.maxPh,        false, `pH too high (${eff.ph.toFixed(2)} > ${std.maxPh})`),
    c('turbidity', eff.turbidity, std.maxTurbidity, false, `Turbidity (${eff.turbidity.toFixed(1)} > ${std.maxTurbidity} NTU)`),
  ];
}

/** Failed criteria only (sorted worst-first by exceedance ratio). */
export function permitViolations(
  eff: WaterQuality,
  std: TreatmentStandard
): PermitCriterion[] {
  return evaluatePermitCriteria(eff, std)
    .filter(cr => !cr.pass)
    .sort((a, b) => violationRatio(b) - violationRatio(a));
}

/** Exceedance severity (>1 means failing). Finite even for zero limits. */
export function violationRatio(cr: PermitCriterion): number {
  return cr.isMinimum
    ? Math.max(1.01, cr.limit / Math.max(0.01, cr.value))
    : Math.max(1.01, cr.value / Math.max(0.001, cr.limit));
}

/** THE verdict. True ⇔ every applicable criterion passes. */
export function isPermitCompliant(eff: WaterQuality, std: TreatmentStandard): boolean {
  return evaluatePermitCriteria(eff, std).every(cr => cr.pass);
}

// ── Display rows (one row per PERMIT PARAMETER — pH merges its two criteria) ─

/** Row keys are PERMIT PARAMETERS; pH is one row backed by two criteria. */
export type PermitRowKey =
  | 'bod' | 'cod' | 'tss' | 'tn' | 'nh4' | 'tp'
  | 'pathogens' | 'do' | 'ph' | 'turbidity';

export interface PermitRow {
  key: PermitRowKey;
  label: string;
  unit: string;
  decimals: number;
  /** Effluent concentration. */
  value: number;
  /** Upper bound (null when the parameter has none). */
  limitMax: number | null;
  /** Lower bound (null when the parameter has none). */
  limitMin: number | null;
  /** Human-readable legal limit, e.g. `"≤ 25 mg/L"`, `"≥ 5 mg/L"`, `"6–9"`, `"≤ 0 CFU"`. */
  limitText: string;
  /** Both pH bounds must pass for the pH row to pass. */
  pass: boolean;
}

const ROW_META: Record<PermitRowKey, { label: string; unit: string; decimals: number }> = {
  bod:       { label: 'BOD₅',                unit: 'mg/L',     decimals: 1 },
  cod:       { label: 'COD',                 unit: 'mg/L',     decimals: 0 },
  tss:       { label: 'TSS',                 unit: 'mg/L',     decimals: 1 },
  tn:        { label: 'Total Nitrogen (TN)', unit: 'mg/L',     decimals: 1 },
  nh4:       { label: 'Ammonia (NH₄-N)',     unit: 'mg/L',     decimals: 1 },
  tp:        { label: 'Total Phosphorus (TP)', unit: 'mg/L',   decimals: 2 },
  pathogens: { label: 'Pathogens',           unit: 'CFU/100mL', decimals: 0 },
  do:        { label: 'Dissolved Oxygen',    unit: 'mg/L',     decimals: 1 },
  ph:        { label: 'pH',                  unit: '',         decimals: 1 },
  turbidity: { label: 'Turbidity',           unit: 'NTU',      decimals: 1 },
};

/**
 * Complete permit table — EVERY applicable standard, ready for UI tables.
 * Never shows a fake-PASS: pass/fail comes straight from the criteria above.
 */
export function permitRows(eff: WaterQuality, std: TreatmentStandard): PermitRow[] {
  const crit = evaluatePermitCriteria(eff, std);
  const byKey = (k: PermitCriterionKey) => crit.find(c => c.key === k)!;

  const row = (
    key: PermitRowKey,
    limitMin: number | null,
    limitMax: number | null,
    pass: boolean
  ): PermitRow => {
    const meta = ROW_META[key];
    const value = eff[key];
    const limitText =
      limitMin !== null && limitMax !== null
        ? `${fmtNum(limitMin, meta.decimals)}–${fmtNum(limitMax, meta.decimals)}`
        : limitMin !== null
        ? `≥ ${fmtNum(limitMin, meta.decimals)}${meta.unit ? ' ' + meta.unit : ''}`
        : `≤ ${fmtNum(limitMax ?? 0, meta.decimals)}${meta.unit ? ' ' + meta.unit : ''}`;
    return { key, ...meta, value, limitMin, limitMax, limitText, pass };
  };

  return [
    row('bod',       null,            std.maxBod,       byKey('bod').pass),
    row('cod',       null,            std.maxCod,       byKey('cod').pass),
    row('tss',       null,            std.maxTss,       byKey('tss').pass),
    row('tn',        null,            std.maxTn,        byKey('tn').pass),
    row('nh4',       null,            std.maxNh4,       byKey('nh4').pass),
    row('tp',        null,            std.maxTp,        byKey('tp').pass),
    row('pathogens', null,            std.maxPathogens, byKey('pathogens').pass),
    row('do',        std.minDo,       null,             byKey('do').pass),
    row('ph',        std.minPh,       std.maxPh,        byKey('ph_low').pass && byKey('ph_high').pass),
    row('turbidity', null,            std.maxTurbidity, byKey('turbidity').pass),
  ];
}

/** Map criterion key → the WaterQuality field it reads (for prediction diffs). */
export const PERMIT_FIELD: Record<PermitCriterionKey, keyof WaterQuality> = {
  bod: 'bod', cod: 'cod', tss: 'tss', tn: 'tn', nh4: 'nh4', tp: 'tp',
  pathogens: 'pathogens', do: 'do', ph_low: 'ph', ph_high: 'ph', turbidity: 'turbidity',
};

/** Short player-facing labels for violation chips/toasts. */
export const PERMIT_LABEL: Record<PermitCriterionKey, string> = {
  bod: 'BOD', cod: 'COD', tss: 'TSS', tn: 'Total Nitrogen', nh4: 'Ammonia',
  tp: 'Phosphorus', pathogens: 'Pathogens', do: 'Dissolved Oxygen',
  ph_low: 'pH (too low)', ph_high: 'pH (too high)', turbidity: 'Turbidity',
};
