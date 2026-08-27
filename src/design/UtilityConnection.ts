/**
 * UtilityConnection — Phase 3 of the CONSTRUCTION-BUILDER mission
 * ("Build the process, do not select the process").
 *
 * Player-drawn utility lines that make Phase-2 machines functional:
 * - water_pipe  : liquid transfer (pump ↔ basin, basin ↔ basin)
 * - air_pipe    : blower → diffuser (blower skid feeds diffuser grid)
 * - power_cable : electrical (powers pumps/mixers/blowers)
 *
 * Domain-only: geometry, validation, cost. No three.js, no React.
 * World scale: 1 tile = 6 m (matches CustomBasin/ProcessEquipment).
 */

import { EQUIPMENT_TYPES, ProcessEquipmentItem } from './ProcessEquipment';
import type { CustomBasin } from './CustomBasin';

export type UtilityConnectionType = 'water_pipe' | 'air_pipe' | 'power_cable';

export interface UtilityConnection {
  id: string;
  type: UtilityConnectionType;
  /** Endpoint A tile (center of tile). */
  ax: number;
  ay: number;
  /** Endpoint B tile. */
  bx: number;
  by: number;
  createdAtDay: number;
}

export const UTILITY_TYPES: Record<UtilityConnectionType, { name: string; color: string; perMeterUsd: number; fixedUsd: number; blurb: string }> = {
  water_pipe: {
    name: 'Water Pipe',
    color: '#3b82f6',
    perMeterUsd: 185,
    fixedUsd: 900,
    blurb: 'Liquid transfer — pump to basin or basin to basin.',
  },
  air_pipe: {
    name: 'Air Pipe',
    color: '#f97316',
    perMeterUsd: 110,
    fixedUsd: 600,
    blurb: 'Compressed air — blower skid to diffuser grid.',
  },
  power_cable: {
    name: 'Power Cable',
    color: '#eab308',
    perMeterUsd: 65,
    fixedUsd: 400,
    blurb: 'Electrical — powers pumps, mixers and blowers.',
  },
};

const TILE_M = 6;

/** Euclidean length between tile centers in metres. */
export function utilityLengthM(c: Pick<UtilityConnection, 'ax' | 'ay' | 'bx' | 'by'>): number {
  const dx = (c.bx - c.ax) * TILE_M;
  const dy = (c.by - c.ay) * TILE_M;
  return Math.hypot(dx, dy);
}

/** Quantity take-off → installed cost in $. Deterministic, pure. */
export function estimateUtilityCAPEX(type: UtilityConnectionType, ax: number, ay: number, bx: number, by: number): number {
  const def = UTILITY_TYPES[type];
  if (!def) return 0;
  const len = Math.hypot((bx - ax) * TILE_M, (by - ay) * TILE_M);
  // Minimum billing length is one tile (6 m) so zero-length is never free.
  const billable = Math.max(len, TILE_M);
  return Math.round(billable * def.perMeterUsd + def.fixedUsd);
}

export interface UtilityPlacementResult {
  ok: boolean;
  reason?: string;
}

function isFiniteTile(n: number): boolean {
  return Number.isFinite(n) && Number.isInteger(n);
}

function tileInsideBasin(tx: number, ty: number, basins: Pick<CustomBasin, 'x'|'y'|'w'|'h'>[]): boolean {
  return basins.some(b => tx >= b.x && tx < b.x + b.w && ty >= b.y && ty < b.y + b.h);
}

function equipmentAt(tx: number, ty: number, equipment: ProcessEquipmentItem[]): ProcessEquipmentItem | undefined {
  return equipment.find(e => e.x === tx && e.y === ty);
}

function isPoweredEquipment(typeId: string): boolean {
  const def = EQUIPMENT_TYPES[typeId];
  return !!def && def.powerKw > 0;
}

/**
 * Full placement validation for a utility connection.
 * - known type, integer tile coords, distinct endpoints, inside map bounds
 * - each endpoint must sit on a connectable host (equipment tile or basin tile)
 * - type-specific host rules (air needs blower↔diffuser, water needs pump/basin, power needs powered kit)
 * - no duplicate connection (same unordered endpoints + same type)
 */
export function validateUtilityConnection(
  type: UtilityConnectionType,
  ax: number, ay: number, bx: number, by: number,
  mapSize: [number, number],
  basins: Pick<CustomBasin, 'x'|'y'|'w'|'h'>[],
  equipment: ProcessEquipmentItem[],
  existing: UtilityConnection[]
): UtilityPlacementResult {
  const def = UTILITY_TYPES[type];
  if (!def) return { ok: false, reason: 'Unknown utility type' };
  if (!isFiniteTile(ax) || !isFiniteTile(ay) || !isFiniteTile(bx) || !isFiniteTile(by)) {
    return { ok: false, reason: 'Invalid tile coordinates' };
  }
  if (ax === bx && ay === by) return { ok: false, reason: 'Endpoints must be distinct tiles' };
  const [mapW, mapH] = mapSize;
  if (ax < 0 || ay < 0 || ax >= mapW || ay >= mapH || bx < 0 || by < 0 || bx >= mapW || by >= mapH) {
    return { ok: false, reason: 'Out of site boundary' };
  }
  // Each endpoint must be on a host (equipment tile or basin tile)
  const aEquip = equipmentAt(ax, ay, equipment);
  const bEquip = equipmentAt(bx, by, equipment);
  const aInBasin = tileInsideBasin(ax, ay, basins);
  const bInBasin = tileInsideBasin(bx, by, basins);
  const aHost = !!aEquip || aInBasin;
  const bHost = !!bEquip || bInBasin;
  if (!aHost) return { ok: false, reason: 'Start tile must be on installed equipment or inside a basin' };
  if (!bHost) return { ok: false, reason: 'End tile must be on installed equipment or inside a basin' };

  // Type-specific semantics
  if (type === 'air_pipe') {
    const aIsBlower = aEquip?.typeId === 'rotary_blower';
    const bIsBlower = bEquip?.typeId === 'rotary_blower';
    const aIsDiffuser = aEquip?.typeId === 'fine_bubble_diffuser';
    const bIsDiffuser = bEquip?.typeId === 'fine_bubble_diffuser';
    const hasBlowerDiffuser = (aIsBlower && bIsDiffuser) || (aIsDiffuser && bIsBlower);
    if (!hasBlowerDiffuser) {
      return { ok: false, reason: 'Air pipe must connect a Blower skid to a Diffuser grid' };
    }
  } else if (type === 'water_pipe') {
    const aIsPump = aEquip?.typeId === 'process_pump';
    const bIsPump = bEquip?.typeId === 'process_pump';
    // Water pipe needs at least one pump or one basin endpoint
    if (!aIsPump && !bIsPump && !aInBasin && !bInBasin) {
      return { ok: false, reason: 'Water pipe must touch a pump or a basin' };
    }
    // Forbid pure equipment-equipment water pipe without a pump (e.g. mixer↔blower)
    if (aEquip && bEquip && !aIsPump && !bIsPump) {
      return { ok: false, reason: 'Water pipe must touch a pump or a basin' };
    }
  } else if (type === 'power_cable') {
    const aPowered = aEquip ? isPoweredEquipment(aEquip.typeId) : false;
    const bPowered = bEquip ? isPoweredEquipment(bEquip.typeId) : false;
    // At least one powered machine so the cable does something
    if (!aPowered && !bPowered) {
      return { ok: false, reason: 'Power cable must touch a powered machine (pump, mixer or blower)' };
    }
  }

  // Duplicate check (unordered endpoints, same type)
  const duplicate = existing.some(u =>
    u.type === type &&
    ((u.ax === ax && u.ay === ay && u.bx === bx && u.by === by) ||
     (u.ax === bx && u.ay === by && u.bx === ax && u.by === ay))
  );
  if (duplicate) return { ok: false, reason: 'That utility connection already exists' };

  return { ok: true };
}

/** True when the point (px,pz) in tile-space is near the segment A→B (for click hit-testing). */
export function pointNearUtility(
  px: number, pz: number,
  c: Pick<UtilityConnection, 'ax'|'ay'|'bx'|'by'>,
  thresholdTiles = 0.6
): boolean {
  const ax = c.ax + 0.5, ay = c.ay + 0.5;
  const bx = c.bx + 0.5, by = c.by + 0.5;
  const vx = bx - ax, vz = by - ay;
  const wx = px - ax, wz = pz - ay;
  const len2 = vx * vx + vz * vz;
  if (len2 === 0) return Math.hypot(wx, wz) <= thresholdTiles;
  const t = Math.max(0, Math.min(1, (wx * vx + wz * vz) / len2));
  const projX = ax + t * vx, projZ = ay + t * vz;
  return Math.hypot(px - projX, pz - projZ) <= thresholdTiles;
}

/**
 * P4 slice 3 — Bounding rect for a utility line for grouping brackets.
 * Bounding box over its two endpoints, bracket-friendly (min 1×1 so
 * thin horizontal/vertical lines still get visible L-legs). Pure.
 */
export function utilityRectFor(
  c: Pick<UtilityConnection, 'ax'|'ay'|'bx'|'by'>,
): { x: number; y: number; w: number; h: number } {
  const minX = Math.min(c.ax, c.bx);
  const minY = Math.min(c.ay, c.by);
  const w = Math.abs(c.bx - c.ax) + 1;
  const h = Math.abs(c.by - c.ay) + 1;
  // Ensure non-degenerate so brackets have 4 distinct corners
  return { x: minX, y: minY, w: Math.max(1, w), h: Math.max(1, h) };
}
