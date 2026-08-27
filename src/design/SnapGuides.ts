/**
 * SnapGuides — CONSTRUCTION-BUILDER ergonomics (edge-snap alignment guides).
 *
 * Pure domain: given existing basins / equipment / unit lots, snap a tile or
 * hover position to the nearest edge within 1 tile so the player can flush-
 * align basins and skid equipment with a single nudge. Visual guide lines sit
 * at the snapped edge. No three.js / React.
 *
 * Guides are integer tile-edge coordinates (e.g. basin x and x+w, equipment
 * x and x+1). Snapping picks the nearest candidate within SNAP_THRESHOLD_TILES.
 */

export const SNAP_THRESHOLD_TILES = 1;

export interface Guides {
  vertical: number[];   // x edges
  horizontal: number[]; // y edges
}

/** Collect edge guides from all placed footprints (deduped & sorted). */
export function collectGuides(
  basins: { x: number; y: number; w: number; h: number }[],
  equipment: { x: number; y: number }[] = [],
  unitRects: { x: number; y: number; w: number; h: number }[] = []
): Guides {
  const vs = new Set<number>();
  const hs = new Set<number>();
  for (const b of basins) {
    vs.add(b.x); vs.add(b.x + b.w);
    hs.add(b.y); hs.add(b.y + b.h);
  }
  for (const e of equipment) {
    vs.add(e.x); vs.add(e.x + 1);
    hs.add(e.y); hs.add(e.y + 1);
  }
  for (const u of unitRects) {
    vs.add(u.x); vs.add(u.x + u.w);
    hs.add(u.y); hs.add(u.y + u.h);
  }
  return {
    vertical: [...vs].sort((a, b) => a - b),
    horizontal: [...hs].sort((a, b) => a - b),
  };
}

/** Remove one basin / equipment from guides (so self doesn't snap). */
export function guidesWithoutBasin(all: Guides, basin: { x: number; y: number; w: number; h: number } | null): Guides {
  if (!basin) return all;
  const exV = new Set([basin.x, basin.x + basin.w]);
  const exH = new Set([basin.y, basin.y + basin.h]);
  return {
    vertical: all.vertical.filter(v => !exV.has(v)),
    horizontal: all.horizontal.filter(h => !exH.has(h)),
  };
}

export function guidesWithoutEquipment(all: Guides, equipmentIds: Set<string>, allEquipment: { id: string; x: number; y: number }[]): Guides {
  if (equipmentIds.size === 0) return all;
  const rm = new Set<string>();
  for (const e of allEquipment) if (equipmentIds.has(e.id)) rm.add(e.id);
  // collect edges to remove
  const exV = new Set<number>();
  const exH = new Set<number>();
  for (const e of allEquipment) if (rm.has(e.id)) { exV.add(e.x); exV.add(e.x + 1); exH.add(e.y); exH.add(e.y + 1); }
  return {
    vertical: all.vertical.filter(v => !exV.has(v)),
    horizontal: all.horizontal.filter(h => !exH.has(h)),
  };
}

function nearestGuide(value: number, guides: number[], threshold: number): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const g of guides) {
    const d = Math.abs(value - g);
    if (d <= threshold && d < bestDist) { bestDist = d; best = g; }
  }
  return best;
}

/**
 * Snap a single TILE position (its integer left/top edge) to the nearest
 * guide. Considers both left-edge (tile.x === guide) and right-edge
 * (tile.x+1 === guide → tile.x === guide-1) candidates.
 * Returns snapped tile + which guide(s) caused the snap (for visuals).
 */
export function snapTile(
  tile: { x: number; y: number },
  guides: Guides,
  threshold = SNAP_THRESHOLD_TILES
): { x: number; y: number; snappedX: boolean; snappedY: boolean; vGuide: number | null; hGuide: number | null } {
  // X axis: candidates are gx and gx-1 for each gx
  let bestX = tile.x; let bestXDist = Infinity; let bestV: number | null = null;
  for (const gx of guides.vertical) {
    for (const cand of [gx, gx - 1]) {
      const d = Math.abs(tile.x - cand);
      if (d <= threshold && d < bestXDist) { bestXDist = d; bestX = cand; bestV = gx; }
    }
  }
  let bestY = tile.y; let bestYDist = Infinity; let bestH: number | null = null;
  for (const gy of guides.horizontal) {
    for (const cand of [gy, gy - 1]) {
      const d = Math.abs(tile.y - cand);
      if (d <= threshold && d < bestYDist) { bestYDist = d; bestY = cand; bestH = gy; }
    }
  }
  return { x: bestX, y: bestY, snappedX: bestX !== tile.x, snappedY: bestY !== tile.y, vGuide: bestV, hGuide: bestH };
}

/**
 * Snap a hover corner for basin drawing: start is fixed, hover defines the
 * opposite corner. The moving EXCLUSIVE edge (hover+1 when hover>=start,
 * hover when hover<start) is the one that snaps.
 */
export function snapHoverForBasin(
  start: { x: number; y: number },
  hover: { x: number; y: number },
  guides: Guides,
  threshold = SNAP_THRESHOLD_TILES
): { x: number; y: number; snappedX: boolean; snappedY: boolean; vGuide: number | null; hGuide: number | null } {
  let nx = hover.x, ny = hover.y;
  let vGuide: number | null = null, hGuide: number | null = null;
  // X
  if (hover.x >= start.x) {
    // right exclusive edge = hover.x + 1
    const edge = hover.x + 1;
    const g = nearestGuide(edge, guides.vertical, threshold);
    if (g !== null) { nx = g - 1; vGuide = g; }
  } else {
    const g = nearestGuide(hover.x, guides.vertical, threshold);
    if (g !== null) { nx = g; vGuide = g; }
  }
  // Y
  if (hover.y >= start.y) {
    const edge = hover.y + 1;
    const g = nearestGuide(edge, guides.horizontal, threshold);
    if (g !== null) { ny = g - 1; hGuide = g; }
  } else {
    const g = nearestGuide(hover.y, guides.horizontal, threshold);
    if (g !== null) { ny = g; hGuide = g; }
  }
  return { x: nx, y: ny, snappedX: nx !== hover.x, snappedY: ny !== hover.y, vGuide, hGuide };
}

/**
 * Snap a target tile for basin wall-drag handle. The dragged edge snaps:
 *  n/w -> target edge itself (target.x / target.y)
 *  s/e -> target exclusive edge (target.x+1 / target.y+1)
 * Corners combine both.
 */
export function snapHandleTarget(
  dir: 'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw',
  target: { x: number; y: number },
  guides: Guides,
  threshold = SNAP_THRESHOLD_TILES
): { x: number; y: number; snappedX: boolean; snappedY: boolean; vGuide: number | null; hGuide: number | null } {
  let nx = target.x, ny = target.y;
  let vGuide: number | null = null, hGuide: number | null = null;
  const wantX = dir === 'w' || dir === 'nw' || dir === 'sw';
  const wantXEx = dir === 'e' || dir === 'ne' || dir === 'se';
  const wantY = dir === 'n' || dir === 'nw' || dir === 'ne';
  const wantYEx = dir === 's' || dir === 'sw' || dir === 'se';
  if (wantX) {
    const g = nearestGuide(target.x, guides.vertical, threshold);
    if (g !== null) { nx = g; vGuide = g; }
  } else if (wantXEx) {
    const g = nearestGuide(target.x + 1, guides.vertical, threshold);
    if (g !== null) { nx = g - 1; vGuide = g; }
  }
  if (wantY) {
    const g = nearestGuide(target.y, guides.horizontal, threshold);
    if (g !== null) { ny = g; hGuide = g; }
  } else if (wantYEx) {
    const g = nearestGuide(target.y + 1, guides.horizontal, threshold);
    if (g !== null) { ny = g - 1; hGuide = g; }
  }
  return { x: nx, y: ny, snappedX: nx !== target.x, snappedY: ny !== target.y, vGuide, hGuide };
}

/** One-liner for toasts */
export function snapSummary(s: { snappedX: boolean; snappedY: boolean; vGuide: number | null; hGuide: number | null }): string {
  if (!s.snappedX && !s.snappedY) return '';
  const parts: string[] = [];
  if (s.snappedX && s.vGuide !== null) parts.push(`x→${s.vGuide}`);
  if (s.snappedY && s.hGuide !== null) parts.push(`y→${s.hGuide}`);
  return `snap ${parts.join(' · ')}`;
}
