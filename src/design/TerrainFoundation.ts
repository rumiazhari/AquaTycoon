/**
 * TerrainFoundation — CONSTRUCTION-BUILDER terrain foundation cost (iter 62).
 *
 * Basin excavation cost varies with deterministic pseudo-heightmap / ground
 * conditions per tile. The player feels location matters: soft ground is
 * cheaper, rocky ground costs more. No Math.random — fully deterministic and
 * headless-testable. The multiplier is 0.92–1.18 per tile, averaged over the
 * basin footprint.
 *
 * Pure domain: no three.js, no React.
 */

import { estimateBasinCAPEX, type BasinRect } from './CustomBasin';

export const TERRAIN_FOUNDATION_MIN = 0.92;
export const TERRAIN_FOUNDATION_MAX = 1.18;
export const TERRAIN_FOUNDATION_RANGE = TERRAIN_FOUNDATION_MAX - TERRAIN_FOUNDATION_MIN; // 0.26

/**
 * Deterministic terrain factor for a single tile (x,y) in 0.92–1.18.
 * Uses a 32-bit integer hash of the tile coords — stable across engines,
 * no Math.random, no per-world seed (the map itself is the seed).
 */
export function terrainFactorForTile(x: number, y: number): number {
  // mix tile coords into a 32-bit hash — Murmur-ish, deterministic
  let h = ((x * 0x8da6b343) ^ (y * 0xd8163841)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  // 24-bit fraction → [0,1)
  const f = (h & 0xffffff) / 0x1000000;
  const v = TERRAIN_FOUNDATION_MIN + f * TERRAIN_FOUNDATION_RANGE;
  // clamp for floating safety
  if (v < TERRAIN_FOUNDATION_MIN) return TERRAIN_FOUNDATION_MIN;
  if (v > TERRAIN_FOUNDATION_MAX) return TERRAIN_FOUNDATION_MAX;
  return v;
}

/**
 * Average terrain factor for a rectangular footprint (w×h tiles).
 * For 1×1 the tile factor is returned directly; for larger basins the
 * per-tile factors are averaged — a basin straddling soft+rocky ground
 * pays the mean.
 */
export function terrainFactorForRect(rect: BasinRect): number {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
    return 1;
  }
  if (rect.w <= 0 || rect.h <= 0) return 1;
  let sum = 0;
  let count = 0;
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) {
      sum += terrainFactorForTile(rect.x + dx, rect.y + dy);
      count++;
    }
  }
  return count > 0 ? sum / count : 1;
}

/**
 * Basin CAPEX adjusted for terrain (base estimate × avg tile factor).
 * The underlying estimateBasinCAPEX stays pure (geometry → base cost);
 * this wrapper applies the foundation multiplier and rounds to dollars.
 */
export function estimateBasinCAPEXWithTerrain(basin: BasinRect & { depthM: number }): number {
  const base = estimateBasinCAPEX(basin);
  const factor = terrainFactorForRect(basin);
  return Math.round(base * factor);
}

/**
 * Human condition label for a factor.
 * 0.92–0.96 soft, 0.96–1.02 average, 1.02–1.10 firm, 1.10–1.18 rocky
 */
export function foundationConditionLabel(factor: number): string {
  if (factor < 0.96) return 'Soft ground';
  if (factor < 1.02) return 'Average ground';
  if (factor < 1.10) return 'Firm ground';
  return 'Rocky ground';
}

/**
 * Tone for UI chips (tailwind-style semantic).
 */
export function foundationConditionTone(factor: number): 'emerald' | 'sky' | 'amber' | 'rose' {
  if (factor < 0.96) return 'emerald';
  if (factor < 1.02) return 'sky';
  if (factor < 1.10) return 'amber';
  return 'rose';
}

/**
 * 3D foundation tint hex per tone — saturated tailwind tones so the
 * foundation apron reads at a glance in-world (soft emerald → rocky rose).
 * Exported as pure domain (no three.js) so sim-tests & SceneManager share
 * the same single source of truth for ground-condition colours.
 */
export const FOUNDATION_TONE_HEX: Record<'emerald' | 'sky' | 'amber' | 'rose', number> = {
  emerald: 0x34d399, // soft ground — green discount
  sky: 0x38bdf8,     // average — neutral
  amber: 0xf59e0b,   // firm — surcharge
  rose: 0xfb7185,    // rocky — heavy surcharge
};

export function foundationToneHex(tone: 'emerald' | 'sky' | 'amber' | 'rose'): number {
  return FOUNDATION_TONE_HEX[tone] ?? FOUNDATION_TONE_HEX.sky;
}

export function foundationHexForFactor(factor: number): number {
  return foundationToneHex(foundationConditionTone(factor));
}

export function foundationHexForRect(rect: BasinRect): number {
  return foundationHexForFactor(terrainFactorForRect(rect));
}

/**
 * Signed percent label e.g. "+14%" or "−6%" (rounded to 1 decimal if needed,
 * whole percent when near integer).
 */
export function foundationPctLabel(factor: number): string {
  const pct = (factor - 1) * 100;
  const sign = pct >= 0 ? '+' : '−';
  const abs = Math.abs(pct);
  // whole percent when within 0.15 of integer
  const rounded = Math.round(abs * 10) / 10;
  const text = Math.abs(rounded - Math.round(rounded)) < 0.15 ? `${Math.round(rounded)}%` : `${rounded.toFixed(1)}%`;
  return `${sign}${text}`;
}

/**
 * One-liner summary for a basin or rect e.g. "Firm ground +6.2% · $12,340 base → $13,102"
 */
export function basinFoundationSummary(basin: BasinRect & { depthM: number }): string {
  const base = estimateBasinCAPEX(basin);
  const factor = terrainFactorForRect(basin);
  const adjusted = Math.round(base * factor);
  const pct = foundationPctLabel(factor);
  const label = foundationConditionLabel(factor);
  return `${label} ${pct} · $${base.toLocaleString()} → $${adjusted.toLocaleString()}`;
}

export function terrainFactorSummary(rect: BasinRect): string {
  const f = terrainFactorForRect(rect);
  return `${foundationConditionLabel(f)} ${foundationPctLabel(f)} (${f.toFixed(3)}×)`;
}

/**
 * Full breakdown for inspector / hover preview.
 */
export interface BasinFoundationBreakdown {
  baseCost: number;
  factor: number;
  adjustedCost: number;
  delta: number; // adjusted - base (positive = surcharge, negative = discount)
  pctLabel: string;
  conditionLabel: string;
  conditionTone: 'emerald' | 'sky' | 'amber' | 'rose';
  summary: string;
}

export function basinFoundationBreakdown(basin: BasinRect & { depthM: number }): BasinFoundationBreakdown {
  const baseCost = estimateBasinCAPEX(basin);
  const factor = terrainFactorForRect(basin);
  const adjustedCost = Math.round(baseCost * factor);
  const delta = adjustedCost - baseCost;
  const pctLabel = foundationPctLabel(factor);
  const conditionLabel = foundationConditionLabel(factor);
  const conditionTone = foundationConditionTone(factor);
  return {
    baseCost,
    factor,
    adjustedCost,
    delta,
    pctLabel,
    conditionLabel,
    conditionTone,
    summary: basinFoundationSummary(basin),
  };
}
