/**
 * CustomBasin — Phase 1 of the CONSTRUCTION-BUILDER mission ("Build the
 * process, do not select the process").
 *
 * A CustomBasin is a player-DRAWN rectangular earthworks/concrete structure:
 * the player drag-rectangles directly on the 3D site and this module owns the
 * pure domain logic — geometry normalization, placement validation, quantity
 * take-off and cost. NO three.js, NO react — fully headless-testable.
 *
 * World scale: 1 grid tile = 6 m × 6 m (matches UNIT_DEFINITIONS footprints,
 * whose meshes are built at 6 m per tile — see UnitMeshes/mkUnit volume math).
 */

export const BASIN_TILE_METERS = 6;
/** Minimum drawable basin: 2×2 tiles = 12 m × 12 m (a real package plant cell). */
export const BASIN_MIN_TILES = 2;
/** Fixed initial depth for Phase 1 (direct depth editing lands in Phase 2+). */
export const BASIN_DEFAULT_DEPTH_M = 4.0;
/** Direct-editing bounds (iter 49 P1 slice 1): player can retune depth after draw. */
export const BASIN_MIN_DEPTH_M = 1.5;
export const BASIN_MAX_DEPTH_M = 8.0;
export const BASIN_DEPTH_STEP_M = 0.5;

/** Cost model (§19 — quantity-based, simple, visible while building):
 *  civil works ≈ $165 per m³ of excavated/reinforced water volume
 *             + $55 per m² of wall formwork (perimeter × depth). */
const COST_PER_M3_VOLUME = 165;
const COST_PER_M2_WALL = 55;

export interface BasinRect {
  /** Integer tile coords of the MIN corner (inclusive). */
  x: number;
  y: number;
  /** Extent in tiles (≥ 1 after normalization). */
  w: number;
  h: number;
}

export interface CustomBasin extends BasinRect {
  id: string;
  depthM: number;
  createdAtDay: number;
}

/** Normalizes two arbitrary corner tiles into a positive-width rect. */
export function rectFromCorners(
  ax: number, ay: number,
  bx: number, by: number
): BasinRect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    w: Math.abs(ax - bx) + 1,
    h: Math.abs(ay - by) + 1,
  };
}

export function basinLengthM(b: Pick<BasinRect, 'w'>): number {
  return b.w * BASIN_TILE_METERS;
}

export function basinWidthM(b: Pick<BasinRect, 'h'>): number {
  return b.h * BASIN_TILE_METERS;
}

/** External water volume in m³ (rectangular tank, wall thickness ignored). */
export function basinVolumeM3(b: BasinRect & { depthM: number }): number {
  return basinLengthM(b) * basinWidthM(b) * b.depthM;
}

/** Quantity take-off → construction cost in $. Deterministic, pure. */
export function estimateBasinCAPEX(b: BasinRect & { depthM: number }): number {
  const lengthM = basinLengthM(b);
  const widthM = basinWidthM(b);
  const wallAreaM2 = 2 * (lengthM + widthM) * b.depthM;
  return Math.round(
    basinVolumeM3(b) * COST_PER_M3_VOLUME + wallAreaM2 * COST_PER_M2_WALL
  );
}

export function rectsOverlap(a: BasinRect, b: BasinRect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x &&
    a.y < b.y + b.h && a.y + a.h > b.y
  );
}

export function rectContains(r: BasinRect, tx: number, ty: number): boolean {
  return tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h;
}

export interface BasinPlacementResult {
  ok: boolean;
  reason?: string;
}

/**
 * Full placement validation for a candidate rect against the map, existing
 * basins and legacy placed units. Mirrors the strictness of GameManager.
 * placeUnit (boundary + overlap) so neither system can tunnel into the other.
 */
export function validateBasinPlacement(
  rect: BasinRect,
  depthM: number,
  mapSize: [number, number],
  existingBasins: CustomBasin[],
  placedUnitRects: BasinRect[]
): BasinPlacementResult {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.w) || !Number.isFinite(rect.h)) {
    return { ok: false, reason: 'Invalid basin rectangle' };
  }
  if (rect.w < BASIN_MIN_TILES || rect.h < BASIN_MIN_TILES) {
    return { ok: false, reason: `Basin too small — minimum ${BASIN_MIN_TILES}×${BASIN_MIN_TILES} tiles (${BASIN_MIN_TILES * BASIN_TILE_METERS} m)` };
  }
  const [mapW, mapH] = mapSize;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > mapW || rect.y + rect.h > mapH) {
    return { ok: false, reason: 'Out of site boundary' };
  }
  if (!(depthM >= 1.5 && depthM <= 8)) {
    return { ok: false, reason: 'Depth must be 1.5–8 m' };
  }
  for (const b of existingBasins) {
    if (rectsOverlap(rect, b)) {
      return { ok: false, reason: 'Overlaps an existing basin' };
    }
  }
  for (const u of placedUnitRects) {
    if (rectsOverlap(rect, u)) {
      return { ok: false, reason: 'Overlaps an existing unit lot' };
    }
  }
  return { ok: true };
}

/**
 * P1 DIRECT EDITING — validates a RESIZE/DEPTH edit of an EXISTING basin.
 * Reuses placement rules but EXCLUDES the basin itself from overlap checks
 * and adds stranded-equipment / baffle-validity guards so a shrink never
 * orphans installed kit or leaves a baffle wall outside the new footprint.
 */
export function validateBasinEdit(
  basinId: string,
  newRect: BasinRect,
  newDepthM: number,
  mapSize: [number, number],
  allBasins: CustomBasin[],
  placedUnitRects: BasinRect[],
  equipmentTiles: { x: number; y: number }[] = [],
  baffleOffsets: { basinId: string; orientation: 'vertical' | 'horizontal'; offsetTiles: number }[] = []
): BasinPlacementResult {
  if (!Number.isFinite(newDepthM) || !(newDepthM >= BASIN_MIN_DEPTH_M && newDepthM <= BASIN_MAX_DEPTH_M)) {
    return { ok: false, reason: `Depth must be ${BASIN_MIN_DEPTH_M}–${BASIN_MAX_DEPTH_M} m` };
  }
  const others = allBasins.filter(b => b.id !== basinId);
  const v = validateBasinPlacement(newRect, newDepthM, mapSize, others, placedUnitRects);
  if (!v.ok) return v;
  // Stranded equipment: every tile that was inside the OLD basin and holds
  // equipment must still be inside the new rect — otherwise the machine
  // would float outside the walls.
  for (const e of equipmentTiles) {
    if (!rectContains(newRect, e.x, e.y)) {
      return { ok: false, reason: 'Resize would strand installed equipment — remove it first' };
    }
  }
  // Baffle validity: each baffle's offset must still be 1..dim-1 under new dims
  for (const bf of baffleOffsets) {
    if (bf.basinId !== basinId) continue;
    const dim = bf.orientation === 'vertical' ? newRect.w : newRect.h;
    if (bf.offsetTiles < 1 || bf.offsetTiles >= dim) {
      return { ok: false, reason: 'Resize would invalidate a baffle wall — remove baffles first' };
    }
  }
  return { ok: true };
}

/** Cost delta for an edit (positive = extra CAPEX, negative = salvage pool). */
export function basinEditCostDelta(oldBasin: CustomBasin & { depthM: number }, newRect: BasinRect & { depthM: number }): number {
  return estimateBasinCAPEX(newRect) - estimateBasinCAPEX(oldBasin);
}

/** Human one-liner for a basin's engineered dimensions (in-world label). */
export function basinDimensionLabel(b: CustomBasin): string {
  const len = basinLengthM(b);
  const wid = basinWidthM(b);
  const vol = basinVolumeM3(b);
  return `${len}×${wid} m · ${b.depthM.toFixed(1)} m deep · ${Math.round(vol).toLocaleString()} m³`;
}
