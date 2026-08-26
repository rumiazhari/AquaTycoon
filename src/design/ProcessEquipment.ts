/**
 * ProcessEquipment — Phase 2 of the CONSTRUCTION-BUILDER mission ("Build the
 * process, do not select the process").
 *
 * Physical machines the player installs IN or NEXT TO their player-drawn
 * basins: diffusers and mixers live INSIDE basin water (wet-installed),
 * pumps and blowers sit on open ground (dry-installed). The treatment
 * process will later EMERGE from these components (Phases 4+); this module
 * owns only placement geometry rules, the catalog and cost. NO three.js,
 * NO react — fully headless-testable.
 *
 * World scale: 1 grid tile = 6 m × 6 m (matches CustomBasin).
 */

export const EQUIPMENT_TILE_METERS = 6;

/** Where a machine may physically stand. */
export type EquipmentMounting = 'in_basin' | 'ground';

export interface EquipmentTypeDef {
  id: string;
  name: string;
  mounting: EquipmentMounting;
  /** Installed cost in $. Deterministic catalog price (§19 quantity billing). */
  capexUsd: number;
  opexUsdPerDay: number;
  powerKw: number;
  blurb: string;
}

/**
 * Phase-2 starter catalog — the four machines the mission directive names.
 * Prices are order-of-magnitude package costs, tuned to sit BELOW legacy
 * prefab units so hand-building stays the economical, expressive path.
 */
export const EQUIPMENT_TYPES: Record<string, EquipmentTypeDef> = {
  fine_bubble_diffuser: {
    id: 'fine_bubble_diffuser',
    name: 'Fine-Bubble Diffuser Grid',
    mounting: 'in_basin',
    capexUsd: 4_200,
    opexUsdPerDay: 6,
    powerKw: 0, // air comes from blowers through piping (Phase 3+)
    blurb: 'Floor-mounted fine-bubble membrane grid. Transfers oxygen; needs an air blower to run.',
  },
  submersible_mixer: {
    id: 'submersible_mixer',
    name: 'Submersible Mixer',
    mounting: 'in_basin',
    capexUsd: 9_800,
    opexUsdPerDay: 12,
    powerKw: 4,
    blurb: 'Wet-installed low-speed propeller. Keeps solids in suspension; prevents septic dead zones.',
  },
  process_pump: {
    id: 'process_pump',
    name: 'Process Pump (Dry-Pit)',
    mounting: 'ground',
    capexUsd: 14_500,
    opexUsdPerDay: 18,
    powerKw: 11,
    blurb: 'Dry-installed centrifugal pump on a concrete plinth. Moves liquid between structures.',
  },
  rotary_blower: {
    id: 'rotary_blower',
    name: 'Rotary Blower Skid',
    mounting: 'ground',
    capexUsd: 32_000,
    opexUsdPerDay: 40,
    powerKw: 22,
    blurb: 'Positive-displacement air skid. Feeds diffuser grids through air piping (Phase 3+).',
  },
};

/** One installed machine. Occupies exactly ONE grid tile. */
export interface ProcessEquipmentItem {
  id: string;
  typeId: string;
  /** Tile coords (the tile's center hosts the machine). */
  x: number;
  y: number;
  createdAtDay: number;
}

export function estimateEquipmentCAPEX(typeId: string): number {
  return EQUIPMENT_TYPES[typeId]?.capexUsd ?? 0;
}

export interface EquipmentPlacementResult {
  ok: boolean;
  reason?: string;
}

function tileInRect(tx: number, ty: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h;
}

/**
 * Full placement validation for one machine:
 *  - known type, inside site bounds, no double-occupancy by equipment;
 *  - in_basin types MUST sit on a tile covered by a player-drawn basin
 *    (you cannot bolt a diffuser to bare earth);
 *  - ground types must NOT sit inside a basin, over a legacy unit lot,
 *    or anywhere equipment already stands.
 */
export function validateEquipmentPlacement(
  typeId: string,
  tx: number,
  ty: number,
  mapSize: [number, number],
  basins: { x: number; y: number; w: number; h: number }[],
  equipment: ProcessEquipmentItem[],
  placedUnitRects: { x: number; y: number; w: number; h: number }[]
): EquipmentPlacementResult {
  const def = EQUIPMENT_TYPES[typeId];
  if (!def) return { ok: false, reason: 'Unknown equipment type' };
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    return { ok: false, reason: 'Invalid position' };
  }
  const [mapW, mapH] = mapSize;
  if (tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) {
    return { ok: false, reason: 'Out of site boundary' };
  }
  if (equipment.some(e => e.x === tx && e.y === ty)) {
    return { ok: false, reason: 'Tile already holds equipment' };
  }
  if (def.mounting === 'in_basin') {
    if (!basins.some(b => tileInRect(tx, ty, b))) {
      return { ok: false, reason: `${def.name} mounts inside a constructed basin — draw a basin first` };
    }
  } else {
    if (basins.some(b => tileInRect(tx, ty, b))) {
      return { ok: false, reason: `${def.name} is dry-installed — place it on open ground outside basins` };
    }
    for (const u of placedUnitRects) {
      if (tileInRect(tx, ty, u)) {
        return { ok: false, reason: 'Overlaps an existing unit lot' };
      }
    }
  }
  return { ok: true };
}
