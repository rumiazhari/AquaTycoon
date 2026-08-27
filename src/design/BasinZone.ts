/**
 * BasinZone — Phase 5 of the CONSTRUCTION-BUILDER mission
 * ("Build the process, do not select the process").
 *
 * Player-drawn basins (Phase 1) are big rectangular tanks. Real
 * treatment trains compartmentalise that volume with interior baffle
 * walls — anoxic pockets, aerobic lanes, clarifier stilling zones.
 * This module owns the pure domain: baffle-wall geometry, validation,
 * quantity take-off, and the DERIVED zone grid that partitions each
 * basin into functional compartments.
 *
 * A basin with zero baffles has exactly one zone covering the whole
 * footprint. Each baffle is a straight, axis-aligned wall that spans
 * the FULL extent of its basin in one direction (vertical = north–south
 * wall at a tile offset, horizontal = east–west). Multiple baffles form
 * a regular grid; zones are the rectangular cells of that grid. No
 * T-junctions in slice 1 — that keeps validation/visuals trivial and
 * lets the next membrane/media phases build per-zone reactors.
 *
 * World scale: 1 tile = 6 m (matches CustomBasin/ProcessEquipment).
 * Depth is the basin's depthM; baffle height = depthM.
 */

import type { CustomBasin } from './CustomBasin';
import type { ProcessEquipmentItem } from './ProcessEquipment';

export type ZoneRole = 'anoxic' | 'aerobic' | 'settling' | 'buffer';
export type BaffleOrientation = 'vertical' | 'horizontal';

export interface BaffleWall {
  id: string;
  basinId: string;
  orientation: BaffleOrientation;
  /** Offset in tiles from the basin's origin (x for vertical, y for horizontal). 1 .. dim-1 */
  offsetTiles: number;
  createdAtDay: number;
}

export interface BasinZone {
  id: string;
  basinId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  role: ZoneRole;
  /** Indices in the grid (useful for debugging / role assignment). */
  gridI: number;
  gridJ: number;
}

const TILE_M = 6;
const COST_PER_M2_WALL = 55;
const BAFFLE_FIXED_USD = 450;

/** Length of a baffle wall in metres (full span of its basin). */
export function baffleLengthM(basin: Pick<CustomBasin, 'w' | 'h'>, orientation: BaffleOrientation): number {
  return (orientation === 'vertical' ? basin.h : basin.w) * TILE_M;
}

/** Area of one baffle wall in m². */
export function baffleAreaM2(basin: Pick<CustomBasin, 'w' | 'h' | 'depthM'>, orientation: BaffleOrientation): number {
  return baffleLengthM(basin, orientation) * basin.depthM;
}

/** Installed cost for one interior baffle wall. Deterministic, pure. */
export function estimateBaffleCAPEX(
  basin: Pick<CustomBasin, 'w' | 'h' | 'depthM'>,
  orientation: BaffleOrientation,
): number {
  return Math.round(baffleAreaM2(basin, orientation) * COST_PER_M2_WALL + BAFFLE_FIXED_USD);
}

export interface BafflePlacementResult {
  ok: boolean;
  reason?: string;
}

/**
 * Full placement validation for a candidate baffle inside a basin.
 * Checks basin existence, integer offset, in-range, no duplicate offset
 * for the same basin+orientation, and sane depth.
 */
export function validateBafflePlacement(
  basin: CustomBasin | undefined,
  existingBaffles: BaffleWall[],
  orientation: BaffleOrientation,
  offsetTiles: number,
): BafflePlacementResult {
  if (!basin) return { ok: false, reason: 'Target basin not found' };
  if (orientation !== 'vertical' && orientation !== 'horizontal') {
    return { ok: false, reason: 'Invalid baffle orientation' };
  }
  if (!Number.isInteger(offsetTiles)) {
    return { ok: false, reason: 'Offset must be an integer tile count' };
  }
  const dim = orientation === 'vertical' ? basin.w : basin.h;
  if (offsetTiles < 1 || offsetTiles > dim - 1) {
    return { ok: false, reason: `Offset must be 1–${dim - 1} tiles for this basin (${dim} tiles)` };
  }
  if (!(basin.depthM >= 1.5 && basin.depthM <= 8)) {
    return { ok: false, reason: 'Basin depth out of range' };
  }
  const duplicate = existingBaffles.some(
    b => b.basinId === basin.id && b.orientation === orientation && b.offsetTiles === offsetTiles,
  );
  if (duplicate) return { ok: false, reason: 'A baffle already exists at that offset' };
  return { ok: true };
}

/** All baffles that belong to a specific basin. */
export function bafflesForBasin(basinId: string, baffles: BaffleWall[]): BaffleWall[] {
  return baffles.filter(b => b.basinId === basinId);
}

/**
 * Derives the rectangular zone grid for one basin from its baffle set.
 * Vertical offsets partition X, horizontal offsets partition Y; the
 * Cartesian product is the zone list. Zones are ordered row-major
 * (x-major, then y).
 */
export function zonesForBasin(basin: CustomBasin, baffles: BaffleWall[]): BasinZone[] {
  const vOff = [...new Set(baffles.filter(b => b.basinId === basin.id && b.orientation === 'vertical').map(b => b.offsetTiles))].sort((a, b) => a - b);
  const hOff = [...new Set(baffles.filter(b => b.basinId === basin.id && b.orientation === 'horizontal').map(b => b.offsetTiles))].sort((a, b) => a - b);

  const vBounds = [0, ...vOff, basin.w];
  const hBounds = [0, ...hOff, basin.h];

  const zones: BasinZone[] = [];
  for (let i = 0; i < vBounds.length - 1; i++) {
    for (let j = 0; j < hBounds.length - 1; j++) {
      const x = basin.x + vBounds[i];
      const y = basin.y + hBounds[j];
      const w = vBounds[i + 1] - vBounds[i];
      const h = hBounds[j + 1] - hBounds[j];
      // Default role: single zone = buffer, otherwise first column anoxic-ish,
      // the rest aerobic, so a 2-zone split naturally teaches anoxic→aerobic.
      let role: ZoneRole = 'buffer';
      const nCols = vBounds.length - 1;
      const nRows = hBounds.length - 1;
      const total = nCols * nRows;
      if (total === 1) role = 'aerobic';
      else if (total === 2 && nCols === 2 && nRows === 1) role = i === 0 ? 'anoxic' : 'aerobic';
      else if (total === 2 && nCols === 1 && nRows === 2) role = j === 0 ? 'anoxic' : 'aerobic';
      else role = (i + j) % 2 === 0 ? 'anoxic' : 'aerobic';

      zones.push({
        id: `${basin.id}__z${i}-${j}`,
        basinId: basin.id,
        x, y, w, h,
        role,
        gridI: i,
        gridJ: j,
      });
    }
  }
  return zones;
}

/** All zones across all basins. */
export function allZones(basins: CustomBasin[], baffles: BaffleWall[]): BasinZone[] {
  const out: BasinZone[] = [];
  for (const b of basins) out.push(...zonesForBasin(b, baffles));
  return out;
}

/** Volume of one zone in m³ (uses its parent basin's depth). */
export function zoneVolumeM3(zone: BasinZone, depthM: number): number {
  return zone.w * TILE_M * zone.h * TILE_M * depthM;
}

/** Total compartmentalised volume across a basin's zones (should equal basin volume). */
export function totalZoneVolumeM3(basin: CustomBasin, baffles: BaffleWall[]): number {
  return zonesForBasin(basin, baffles).reduce((s, z) => s + zoneVolumeM3(z, basin.depthM), 0);
}

/** Which zone contains a given tile (or null if none). */
export function zoneAtTile(tx: number, ty: number, zones: BasinZone[]): BasinZone | null {
  return zones.find(z => tx >= z.x && tx < z.x + z.w && ty >= z.y && ty < z.y + z.h) ?? null;
}

/** Which zone hosts a piece of in-basin equipment (null for ground kit or outside). */
export function zoneForEquipment(
  equipment: Pick<ProcessEquipmentItem, 'x' | 'y'>,
  zones: BasinZone[],
): BasinZone | null {
  return zoneAtTile(equipment.x, equipment.y, zones);
}

/** Basin zone stats for HUD / diagnostics. */
export interface BasinZoneStats {
  totalBasins: number;
  totalBaffles: number;
  totalZones: number;
  verticalBaffles: number;
  horizontalBaffles: number;
  /** Zones per basin (map basinId -> count). */
  zonesPerBasin: Map<string, number>;
}

export function basinZoneStats(basins: CustomBasin[], baffles: BaffleWall[]): BasinZoneStats {
  const verticalBaffles = baffles.filter(b => b.orientation === 'vertical').length;
  const horizontalBaffles = baffles.filter(b => b.orientation === 'horizontal').length;
  const zonesPerBasin = new Map<string, number>();
  let totalZones = 0;
  for (const b of basins) {
    const n = zonesForBasin(b, baffles).length;
    zonesPerBasin.set(b.id, n);
    totalZones += n;
  }
  return {
    totalBasins: basins.length,
    totalBaffles: baffles.length,
    totalZones,
    verticalBaffles,
    horizontalBaffles,
    zonesPerBasin,
  };
}

/** Hit-test: is point (px,pz) in tile-space near a baffle wall midline? */
export function pointNearBaffle(
  px: number,
  pz: number,
  baffle: BaffleWall,
  basin: CustomBasin,
  thresholdTiles = 0.45,
): boolean {
  if (baffle.basinId !== basin.id) return false;
  if (baffle.orientation === 'vertical') {
    const wallX = basin.x + baffle.offsetTiles; // tile-boundary line at +offset
    const wallXCenter = wallX; // sits on the grid line
    const inY = pz >= basin.y && pz <= basin.y + basin.h;
    return inY && Math.abs(px - wallXCenter) <= thresholdTiles;
  } else {
    const wallY = basin.y + baffle.offsetTiles;
    const inX = px >= basin.x && px <= basin.x + basin.w;
    return inX && Math.abs(pz - wallY) <= thresholdTiles;
  }
}

/** One-line human summary for toasts / HUD chip. */
export function baffleSummaryLine(stats: BasinZoneStats): string {
  if (stats.totalBasins === 0) return 'No basins — draw one to compartmentalise.';
  if (stats.totalBaffles === 0) return `${stats.totalBasins} basin${stats.totalBasins>1?'s':''} · ${stats.totalZones} zone${stats.totalZones>1?'s':''} · no baffles yet`;
  return `${stats.totalBasins} basin${stats.totalBasins>1?'s':''} · ${stats.totalZones} zones · ${stats.totalBaffles} baffle${stats.totalBaffles>1?'s':''}`;
}

/**
 * P4 slice 3 — Bounding rect for a baffle wall for grouping brackets.
 * Vertical wall: thin 0.8 m strip at the tile boundary running full basin height.
 * Horizontal wall: thin strip running full width. Returned rect is bracket-friendly
 * (non-degenerate width/height so L-legs render). Returns null if basin mismatch.
 */
export function baffleRectFor(
  baffle: Pick<BaffleWall, 'basinId' | 'orientation' | 'offsetTiles'>,
  basin: Pick<CustomBasin, 'id' | 'x' | 'y' | 'w' | 'h'>,
): { x: number; y: number; w: number; h: number } | null {
  if (baffle.basinId !== basin.id) return null;
  if (baffle.orientation === 'vertical') {
    return { x: basin.x + baffle.offsetTiles - 0.4, y: basin.y, w: 0.8, h: basin.h };
  }
  return { x: basin.x, y: basin.y + baffle.offsetTiles - 0.4, w: basin.w, h: 0.8 };
}
