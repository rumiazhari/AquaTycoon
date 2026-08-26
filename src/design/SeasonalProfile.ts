/**
 * SeasonalProfile — TYCOON SEASONAL (iter 45).
 *
 * Annual tariff cycle that gives the tycoon loop a calendar rhythm:
 * summer drought = scarcity premium (up to +12% tariff),
 * winter = surplus discount (down to −12%).
 * Pure deterministic sinusoid over a 365-day year — same game clock
 * ⇒ same tariff, no RNG, trivially testable.
 *
 * Flow is left at its level-spec value (diurnal already modulates
 * intra-day dynamics) — seasonal touches ONLY the tariff economics
 * so physics/compliance are never destabilised.
 *
 * Economics:
 *   revenue = flow × tariff × seasonalMul + reclaim + trust
 *   seasonalBonus = flow × tariff × (mul − 1)  — can be negative
 *   At L1 (3500 m³/d × $0.45)  peak summer ≈ +$189/d, trough winter ≈ −$189/d.
 *   At L5 (15000 m³/d × $0.90) peak ≈ +$1620/d.
 *   At L4 (12000 m³/d × $0.95) peak ≈ +$1368/d.
 */

export const SEASONAL_TARIFF_AMPLITUDE = 0.12;
export const SEASONAL_PERIOD_DAYS = 365;

/**
 * Annual tariff multiplier for a given game clock.
 * 1.12 at summer peak (day ~171, Jun 20), 0.88 at winter trough (day ~354),
 * 1.00 at the equinox crossovers (day ~80 and ~262).
 * Deterministic sinusoid: 1 + A·sin(2π·(days−80)/365).
 * Guards: non-finite days ⇒ 1.0 (neutral).
 */
export function seasonalTariffMultiplier(gameTimeDays: number): number {
  if (!Number.isFinite(gameTimeDays)) return 1;
  const phase = (2 * Math.PI * (gameTimeDays - 80)) / SEASONAL_PERIOD_DAYS;
  return 1 + SEASONAL_TARIFF_AMPLITUDE * Math.sin(phase);
}

/**
 * Seasonal tariff bonus in $/day (can be negative in winter).
 * Pure domain: flow>10 & tariff>0 otherwise 0.
 * Guards NaN/Infinity inputs.
 */
export function seasonalBonusPerDay(
  flowM3d: number,
  tariffPerM3: number,
  gameTimeDays: number,
): number {
  if (!Number.isFinite(flowM3d) || flowM3d <= 10) return 0;
  if (!Number.isFinite(tariffPerM3) || tariffPerM3 <= 0) return 0;
  if (!Number.isFinite(gameTimeDays)) return 0;
  const mul = seasonalTariffMultiplier(gameTimeDays);
  return flowM3d * tariffPerM3 * (mul - 1);
}

/**
 * Seasonal label for HUD / alerts.
 * Returns a short season name and signed percent string like "+12%" or "−8%".
 */
export function seasonalLabel(gameTimeDays: number): {
  season: string;
  pct: string;
  isPremium: boolean;
  multiplier: number;
} {
  const mul = seasonalTariffMultiplier(gameTimeDays);
  const pctVal = Math.round((mul - 1) * 100);
  const pct = `${pctVal >= 0 ? '+' : ''}${pctVal}%`;
  const isPremium = mul > 1.005;
  // Map the phase angle to a season name (peak = summer drought)
  const phaseDeg = (((gameTimeDays - 80) / SEASONAL_PERIOD_DAYS) * 360) % 360;
  const norm = phaseDeg < 0 ? phaseDeg + 360 : phaseDeg;
  let season: string;
  if (norm < 45 || norm >= 315) season = pctVal > 2 ? 'Summer drought' : pctVal < -2 ? 'Winter low' : 'Spring';
  else if (norm < 135) season = 'Summer drought';
  else if (norm < 225) season = 'Autumn';
  else season = 'Winter low';
  // Refine with the actual sign so winter trough never reads summer
  if (mul > 1.06) season = 'Summer drought';
  else if (mul < 0.94) season = 'Winter low';
  else if (norm >= 45 && norm < 135 && mul > 1.02) season = 'Late spring';
  else if (norm >= 225 && norm < 315 && mul < 0.98) season = 'Winter low';
  return { season, pct, isPremium, multiplier: mul };
}

/**
 * One-line summary for construction/tycoon HUD (mirrors other bonus lines).
 */
export function seasonalSummaryLine(gameTimeDays: number): string {
  const { season, pct } = seasonalLabel(gameTimeDays);
  return `${season} ${pct} tariff`;
}
