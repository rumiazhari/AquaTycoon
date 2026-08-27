/**
 * GreenDividend — TYCOON GREEN DIVIDEND (iter 47).
 *
 * City energy-independence subsidy for plants that offset ≥50% of their
 * power demand with on-site green generation (biogas CHP + solar PV + wind).
 * Teaching: renewable power is not just avoided OPEX — the city pays a
 * premium when you are green enough to be resilient.
 *
 * Economics (flow×tariff, selfPct-gated — mirrors trust/reclaim pattern):
 *   8% of tariff revenue when self-sufficiency ≥50%, otherwise 0.
 *   At L1 (3500 m³/d × $0.45) → $126/d
 *   At L4 (12000 m³/d × $0.95) → $912/d
 *   At L5 (15000 m³/d × $0.90) → $1080/d
 *   Stacks with trust/reclaim/seasonal/biosolids; flow>10 & tariff>0 gated.
 *
 * Pure, deterministic, headlessly testable — no RNG, no three.js.
 */

export const GREEN_DIVIDEND_RATE = 0.08;
export const GREEN_DIVIDEND_THRESHOLD_PCT = 50;

/**
 * Green energy dividend in $/day.
 * Returns 0 when flow≤10, tariff≤0, selfPct<50, or any arg non-finite.
 */
export function greenDividendBonusPerDay(
  flowM3d: number,
  tariffPerM3: number,
  selfSufficiencyPct: number,
): number {
  if (!Number.isFinite(flowM3d) || flowM3d <= 10) return 0;
  if (!Number.isFinite(tariffPerM3) || tariffPerM3 <= 0) return 0;
  if (!Number.isFinite(selfSufficiencyPct) || selfSufficiencyPct < GREEN_DIVIDEND_THRESHOLD_PCT) return 0;
  const bonus = flowM3d * tariffPerM3 * GREEN_DIVIDEND_RATE;
  if (!Number.isFinite(bonus) || bonus <= 0) return 0;
  return bonus;
}

/**
 * Human label for the current green tier.
 */
export function greenDividendLabel(selfSufficiencyPct: number): string {
  if (!Number.isFinite(selfSufficiencyPct)) return 'Grid dependent';
  return selfSufficiencyPct >= GREEN_DIVIDEND_THRESHOLD_PCT ? 'Energy independent' : 'Grid dependent';
}

/**
 * One-line summary for HUD / alerts.
 */
export function greenDividendSummaryLine(
  flowM3d: number,
  tariffPerM3: number,
  selfSufficiencyPct: number,
): string {
  const bonus = greenDividendBonusPerDay(flowM3d, tariffPerM3, selfSufficiencyPct);
  const label = greenDividendLabel(selfSufficiencyPct);
  if (bonus <= 0.5) return `${label} — no green dividend`;
  return `${label} +$${Math.round(bonus)}/d green subsidy (${Math.round(GREEN_DIVIDEND_RATE * 100)}% × ${Math.round(selfSufficiencyPct)}% self)`;
}
