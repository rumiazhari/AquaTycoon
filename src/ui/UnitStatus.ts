import type { PlacedUnit } from '../types/simulation';

/**
 * UnitStatus — pure, testable derivation of an inspector's hydraulic status.
 * Replaces the old hardcoded "Active & Steady" badge that showed regardless of
 * whether the unit was disabled, dry, or receiving a toxic shock load.
 */

export type UnitStatusKey = 'inactive' | 'no_flow' | 'stressed' | 'steady';

export interface UnitStatus {
  key: UnitStatusKey;
  /** Short player-facing label. */
  label: string;
  /** Tailwind color class for the status line. */
  toneClass: string;
  /** Longer explanation shown as a tooltip. */
  detail: string;
}

export function deriveUnitStatus(unit: PlacedUnit): UnitStatus {
  if (!unit.active) {
    return {
      key: 'inactive',
      label: 'Inactive',
      toneClass: 'text-slate-400',
      detail: 'This unit is switched off — it processes nothing and draws no power.',
    };
  }

  const inlet = unit.lastInletQuality;
  if (!inlet || !(inlet.flowRate > 0.1)) {
    return {
      key: 'no_flow',
      label: 'No Flow',
      toneClass: 'text-amber-400',
      detail: 'No wastewater is reaching this unit — connect pipes upstream.',
    };
  }

  if (inlet.toxicIndex > 40) {
    return {
      key: 'stressed',
      label: 'Toxic Shock',
      toneClass: 'text-rose-400',
      detail: `Toxic industrial load (index ${inlet.toxicIndex.toFixed(0)}) is harming this process — add equalization or pretreatment upstream.`,
    };
  }

  return {
    key: 'steady',
    label: 'Active & Steady',
    toneClass: 'text-emerald-400',
    detail: 'Hydraulically connected and processing normally.',
  };
}

/** Null-safe numeric formatting: valid 0 stays "0", absent data renders "—". */
export function fmtMetric(v: number | undefined | null, digits = 0): string {
  return v === undefined || v === null || !Number.isFinite(v)
    ? '—'
    : v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
