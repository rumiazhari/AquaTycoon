/**
 * Clarifier engineering (Prompt §I) — SOR / SLR / blanket dynamics from the
 * ACTUAL designed geometry (circular or rectangular), replacing hardcoded
 * 144 m² assumptions.
 */

import { planAreaM2, BasinGeometry } from '../../design/Geometry';

export interface ClarifierLoadResult {
  planAreaM2: number;
  /** Surface overflow rate on FORWARD flow (m³/m²·d). */
  sorM3M2Day: number;
  /** Solids loading rate on total mixed-liquor feed (kg TSS/m²·d). */
  slrKgM2Day: number;
  /** Peak-factor-adjusted SOR used for overload checks. */
  peakSorM3M2Day: number;
  /** 0..1 sludge blanket level. */
  blanketLevelFraction: number;
  /** Effluent escape TSS (mg/L) after settling performance. */
  escapeTssMgL: number;
  overloaded: boolean;
}

const PEAK_FACTOR = 1.8; // storm/diurnal peak over average

/**
 * Evaluate clarifier state for a design at a given instant.
 * forwardFlowM3d: clarified (overflow) flow; mlssFeedMgL: mixed-liquor TSS in.
 */
export function evaluateClarifierLoad(
  geometry: BasinGeometry,
  forwardFlowM3d: number,
  mlssFeedMgL: number,
  totalFeedM3d: number,
  currentBlanketFraction: number = 0.25
): ClarifierLoadResult {
  const A = Math.max(1, planAreaM2(geometry));
  const qForward = Math.max(0, forwardFlowM3d);
  const sor = qForward / A;
  const solidsKgDay = (Math.max(0, totalFeedM3d) * mlssFeedMgL) / 1000;
  const slrKgM2Day = solidsKgDay / A;
  const slrKgM2Hour = slrKgM2Day / 24;

  // State-based settling capacity (Metcalf&Eddy ranges):
  // SOR > ~33 m/d or SLR > ~6 kg/m²·h (≈144 kg/m²·d) pushes the blanket up.
  const sorOverload = sor > 33 ? (sor - 33) / 20 : 0;
  const slrOverload = slrKgM2Hour > 6 ? (slrKgM2Hour - 6) / 4 : 0;
  const overloadPressure = Math.max(sorOverload, slrOverload);

  // Blanket rises under overload, falls when lightly loaded.
  const targetBlanket = Math.min(0.95, 0.22 + overloadPressure * 0.8);
  const blanketLevelFraction = Math.min(
    0.98,
    currentBlanketFraction + (targetBlanket - currentBlanketFraction) * 0.5
  );

  // Escape concentration grows with both SOR and blanket proximity to weirs.
  let escapeTss =
    sor < 16 ? 5 : sor < 24 ? 8 : sor < 32 ? 12 : sor < 45 ? 20 : 30;
  if (blanketLevelFraction > 0.55) escapeTss += (blanketLevelFraction - 0.55) * 60;
  escapeTss = Math.min(120, escapeTss);

  return {
    planAreaM2: A,
    sorM3M2Day: sor,
    slrKgM2Day: slrKgM2Day,
    peakSorM3M2Day: sor * PEAK_FACTOR,
    blanketLevelFraction,
    escapeTssMgL: escapeTss,
    overloaded: overloadPressure > 0 || blanketLevelFraction > 0.7,
  };
}
