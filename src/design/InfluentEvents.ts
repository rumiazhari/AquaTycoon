/**
 * InfluentEvents — TYCOON RANDOM EVENTS iter 48
 * (\"storm surge\" vs \"industrial shock\" influent spikes).
 *
 * Municipal wastewater is not a flat lab beaker: stormwater infiltrates
 * combined sewers (hydraulic surge, diluted concentrations but higher
 * mass load) and factories dump organic/toxic slugs (concentrated shock).
 * Both stress the plant in opposite ways — clarifiers hydraulically vs
 * reactors biologically — and teach the player to build resilience
 * (equalization buffer, aeration headroom, clarifier capacity).
 *
 * Design constraints:
 *  - Pure, deterministic, headless-testable. No three.js, no React.
 *  - No Math.random — schedule is a hash of the integer game day so
 *    save-games replay identically and tests are deterministic.
 *  - Small conservative magnitudes: storm ×1.85 flow / ×0.88 strength,
 *    industrial ×1.0 flow / ×1.65 strength + ×2.2 toxics.
 *  - Duration: storm 1.4 d (spills into next morning), shock 1.0 d.
 *  - Chance: ~6.5% storm, ~4.5% shock per calendar day → ~11% event days,
 *    ~4 events/month — enough tycoon pressure without chaos.
 *  - Zero effect when no event (identity) so legacy saves/performance stay exact.
 */

import type { WaterQuality } from '../types/simulation';

export type InfluentEventType = 'storm_surge' | 'industrial_shock';

export interface InfluentEvent {
  id: string;
  type: InfluentEventType;
  label: string;
  startDay: number;
  durationDays: number;
  flowMul: number;
  strengthMul: number;
  toxicMul: number;
}

/** Deterministic pseudo-random in [0,1) seeded by integer day. No Math.random. */
export function pseudoRandomForDay(day: number): number {
  if (!Number.isFinite(day)) return 0;
  let s = (Math.floor(day) * 0x9e3779b1) >>> 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Tuned multipliers — visible on permit vs flow-rate without being unbeatable.
export const STORM_FLOW_MUL = 1.85;
export const STORM_STRENGTH_MUL = 0.88;
export const STORM_TOXIC_MUL = 0.90;
export const STORM_DURATION_D = 1.4;

export const SHOCK_FLOW_MUL = 1.0;
export const SHOCK_STRENGTH_MUL = 1.65;
export const SHOCK_TOXIC_MUL = 2.2;
export const SHOCK_DURATION_D = 1.0;

function eventStartingAt(startDay: number): InfluentEvent | null {
  if (!Number.isFinite(startDay)) return null;
  const r = pseudoRandomForDay(startDay);
  if (r < 0.065) {
    return {
      id: `storm_${startDay}`,
      type: 'storm_surge',
      label: 'Storm surge',
      startDay,
      durationDays: STORM_DURATION_D,
      flowMul: STORM_FLOW_MUL,
      strengthMul: STORM_STRENGTH_MUL,
      toxicMul: STORM_TOXIC_MUL,
    };
  } else if (r < 0.11) {
    return {
      id: `shock_${startDay}`,
      type: 'industrial_shock',
      label: 'Industrial shock',
      startDay,
      durationDays: SHOCK_DURATION_D,
      flowMul: SHOCK_FLOW_MUL,
      strengthMul: SHOCK_STRENGTH_MUL,
      toxicMul: SHOCK_TOXIC_MUL,
    };
  }
  return null;
}

/**
 * Returns the active influent event covering the given game day, or null
 * when the weather is calm. Checks the last two integer starts so a
 * 1.4-d storm that began yesterday still covers today's morning.
 */
export function activeInfluentEventForDay(day: number): InfluentEvent | null {
  if (!Number.isFinite(day)) return null;
  const d = Math.floor(day);
  for (let offset = -1; offset <= 0; offset++) {
    const s = d + offset;
    const ev = eventStartingAt(s);
    if (ev && day >= ev.startDay && day < ev.startDay + ev.durationDays) return ev;
  }
  return null;
}

/** Human summary line for the event HUD/alert (pure). */
export function influentEventSummaryLine(day: number): string {
  const ev = activeInfluentEventForDay(day);
  if (!ev) return 'calm influent';
  if (ev.type === 'storm_surge') {
    return `${ev.label} +${Math.round((ev.flowMul - 1) * 100)}% flow (diluted ×${ev.strengthMul.toFixed(2)})`;
  }
  return `${ev.label} +${Math.round((ev.strengthMul - 1) * 100)}% organics ×${ev.toxicMul.toFixed(1)} toxics`;
}

/** Short pill label (HUD). */
export function influentEventLabel(ev: InfluentEvent | null): string {
  if (!ev) return 'Calm';
  return ev.type === 'storm_surge' ? 'STORM SURGE' : 'ORGANIC SHOCK';
}

/**
 * Applies the event's hydraulic + strength multipliers to a municipal influent.
 * Returns a new WaterQuality (no mutation). NaN-guarded, flow/strength only —
 * do/ph/temp untouched (physical influent retains its dissolved oxygen).
 */
export function applyInfluentEvent(influent: WaterQuality, event: InfluentEvent | null): WaterQuality {
  if (!event || !influent) return influent;
  if (!Number.isFinite(event.flowMul) || !Number.isFinite(event.strengthMul)) return influent;
  const s = (v: number, mul: number) => (Number.isFinite(v) ? Math.max(0, v * mul) : v);
  return {
    ...influent,
    flowRate: s(influent.flowRate, event.flowMul),
    bod: s(influent.bod, event.strengthMul),
    cod: s(influent.cod, event.strengthMul),
    tss: s(influent.tss, event.strengthMul * 0.96),
    tn: s(influent.tn, event.strengthMul * 0.92),
    nh4: s(influent.nh4, event.strengthMul * 0.92),
    no3: s(influent.no3, event.strengthMul * 0.92),
    tp: s(influent.tp, event.strengthMul * 0.88),
    pathogens: s(influent.pathogens, event.strengthMul),
    toxicIndex: s(influent.toxicIndex, event.toxicMul),
    turbidity: s(influent.turbidity, event.strengthMul * 0.96),
  };
}
