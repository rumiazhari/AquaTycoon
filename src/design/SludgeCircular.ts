/**
 * SludgeCircular — TYCOON SLUDGE CIRCULAR (iter 46).
 *
 * Circular-economy dividend for closing the sludge loop:
 * thickener → anaerobic digester → dewatering press chain converts
 * waste biosolids into marketable fertilizer and biogas residue.
 *
 * The city pays a fertilizer offtake premium scaled by treated flow:
 * each stage of the chain unlocks a higher per-m³ rate. A flowing
 * plant earns nothing without a thickener; a full thickener+digester+
 * dewatering train earns the maximum — teaching the player that sludge
 * is not waste but product when the loop is closed.
 *
 * Economics (flow×rate, tariff-independent — fertilizer is a commodity):
 *   thickener alone           → $0.012 / m³  (≈ $42/d at L1 3500)
 *   + digester (CHP biogas)   → +$0.015 / m³ (≈ $94/d, +$52 over thickener)
 *   + dewatering press (cake) → +$0.012 / m³ (≈ $136/d full chain L1)
 *   At L4 12 000 m³/d: 144 / 324 / 468 $/d for the three tiers.
 *   At L5 15 000 m³/d: 180 / 405 / 585 $/d.
 *
 * Pure, deterministic, headlessly testable — no RNG, no three.js.
 */

export const SLUDGE_BONUS_PER_M3_THICKENER = 0.012;
export const SLUDGE_BONUS_PER_M3_DIGESTER = 0.015;
export const SLUDGE_BONUS_PER_M3_DEWATERING = 0.012;

/**
 * Maximum chain rate when all three sludge stages are present.
 */
export const SLUDGE_BONUS_PER_M3_FULL =
  SLUDGE_BONUS_PER_M3_THICKENER +
  SLUDGE_BONUS_PER_M3_DIGESTER +
  SLUDGE_BONUS_PER_M3_DEWATERING; // 0.039

/**
 * Biosolids circular-economy bonus in $/day.
 * Flow-gated (>10 m³/d); thickener is the entry requirement.
 * Digester only counts when a thickener is present; dewatering only
 * counts when digester is present (real process chain).
 * Guards NaN/Infinity.
 */
export function sludgeCircularBonusPerDay(
  flowM3d: number,
  hasThickener: boolean,
  hasDigester: boolean,
  hasDewatering: boolean,
): number {
  if (!Number.isFinite(flowM3d) || flowM3d <= 10) return 0;
  if (!hasThickener) return 0;
  let rate = SLUDGE_BONUS_PER_M3_THICKENER;
  if (hasDigester) {
    rate += SLUDGE_BONUS_PER_M3_DIGESTER;
    if (hasDewatering) rate += SLUDGE_BONUS_PER_M3_DEWATERING;
  }
  // hasDewatering alone without digester gives no extra — chain order matters
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return flowM3d * rate;
}

/**
 * Human label for the current chain tier.
 */
export function sludgeCircularLabel(
  hasThickener: boolean,
  hasDigester: boolean,
  hasDewatering: boolean,
): string {
  if (!hasThickener) return 'No sludge loop';
  if (hasThickener && hasDigester && hasDewatering) return 'Full circular loop';
  if (hasThickener && hasDigester) return 'Thickened + digested';
  return 'Thickened';
}

/**
 * One-line summary for HUD / alerts.
 */
export function sludgeCircularSummaryLine(
  flowM3d: number,
  hasThickener: boolean,
  hasDigester: boolean,
  hasDewatering: boolean,
): string {
  const bonus = sludgeCircularBonusPerDay(flowM3d, hasThickener, hasDigester, hasDewatering);
  const label = sludgeCircularLabel(hasThickener, hasDigester, hasDewatering);
  if (bonus <= 0.5) return `${label} — no flow`;
  return `${label} +$${Math.round(bonus)}/d fertilizer`;
}
