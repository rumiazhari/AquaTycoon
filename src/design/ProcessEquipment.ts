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
  // ── PHASE 6: filtration stage — membrane & carrier media (both in_basin) ───
  membrane_cassette: {
    id: 'membrane_cassette',
    name: 'Hollow-Fiber Membrane Cassette',
    mounting: 'in_basin',
    capexUsd: 18_500,
    opexUsdPerDay: 14,
    powerKw: 5, // suction/fouling control — needs a powered feed to stay effective
    blurb: 'Submerged hollow-fiber cassette. Absolute barrier filtration — near-zero TSS; needs periodic air scour from a blower.',
  },
  mbbr_carrier: {
    id: 'mbbr_carrier',
    name: 'MBBR Bio-Carrier Media',
    mounting: 'in_basin',
    capexUsd: 6_800,
    opexUsdPerDay: 5,
    powerKw: 0, // passive carriers; rely on zone mixing (Phase 5) to stay fluidized
    blurb: 'Floating plastic carrier media. Biofilm grows on each carrier — boosts BOD removal when mixed & aerated.',
  },
  // ── PHASE 7 slice 2: instrumentation kit — process sensors (observability layer) ───
  do_probe: {
    id: 'do_probe',
    name: 'Dissolved-Oxygen Probe',
    mounting: 'in_basin',
    capexUsd: 3_200,
    opexUsdPerDay: 4,
    powerKw: 0.3, // small transmitter/head — needs a power feed to report live
    blurb: 'Submerged luminescent DO probe. Reports mg/L in real time when powered — feed the instrumented badge.',
  },
  flow_meter: {
    id: 'flow_meter',
    name: 'Electromagnetic Flow Meter',
    mounting: 'ground',
    capexUsd: 7_500,
    opexUsdPerDay: 9,
    powerKw: 0.45,
    blurb: 'Dry-installed mag-flow spool. Measures m³/d on open ground — needs power to report.',
  },
  level_sensor: {
    id: 'level_sensor',
    name: 'Ultrasonic Level Transmitter',
    mounting: 'in_basin',
    capexUsd: 4_800,
    opexUsdPerDay: 6,
    powerKw: 0.25,
    blurb: 'Horn over the water surface. Reports level/freeboard when powered — completes the sensor triad.',
  },
  // ── PHASE 7 slice 3: chemical dosing kit — TP polishing through coagulant injection ───
  chemical_storage_tank: {
    id: 'chemical_storage_tank',
    name: 'Chemical Storage Tank',
    mounting: 'ground',
    capexUsd: 11_500,
    opexUsdPerDay: 8,
    powerKw: 0.6, // recirculation/dosing skid
    blurb: 'Ground bulk storage for ferric/alum. Supplies the dosing pump — powered storage enables phosphorus polishing.',
  },
  chemical_dosing_pump: {
    id: 'chemical_dosing_pump',
    name: 'Chemical Dosing Pump',
    mounting: 'in_basin',
    capexUsd: 6_800,
    opexUsdPerDay: 11,
    powerKw: 0.9, // peristaltic injection
    blurb: 'In-basin dosing skid. Injects coagulant at the point of use — TP polish when its zone is mixed and powered.',
  },
  // ── PHASE 7 slice 5 / RO SLICE 1: tertiary reverse-osmosis kit — RO multi-barrier reuse train ───
  ro_skid: {
    id: 'ro_skid',
    name: 'RO Membrane Skid',
    mounting: 'ground',
    capexUsd: 28_500,
    opexUsdPerDay: 19,
    powerKw: 12, // HP pump + CIP recirc — tertiary barrier; powered to polish to potable
    blurb: 'Ground RO skid with 4×8″ spiral-wound vessels + HP pump. Tertiary barrier — polishes TSS/TP/salts to near-zero when powered; brine to tank.',
  },
  brine_tank: {
    id: 'brine_tank',
    name: 'Brine Holding Tank',
    mounting: 'ground',
    capexUsd: 13_500,
    opexUsdPerDay: 7,
    powerKw: 1.5, // agitator/recirc — needs power to handle concentrate
    blurb: 'Ground bunded brine tank. Stores RO concentrate for evaporation/hauling — completes the zero-liquid reuse loop.',
  },
  // ── TYCOON CHP — sludge→energy circular: construction-built biogas engine ───
  biogas_chp_skid: {
    id: 'biogas_chp_skid',
    name: 'Biogas CHP Engine Skid',
    mounting: 'ground',
    capexUsd: 36_500,
    opexUsdPerDay: 16,
    powerKw: 1.8, // parasitic controls/parasite — needs a power_cable to be grid-connected; generation is via ConstructionAdapter (green kW)
    blurb: 'Containerized biogas CHP skid. Burns digester biogas to generate ~14 kW green power when grid-connected via power cable and fed by an anaerobic digester.',
  },
  // ── UV DISINFECTION — construction-built pathogen barrier (tertiary polishing) ───
  uv_channel: {
    id: 'uv_channel',
    name: 'UV Disinfection Channel',
    mounting: 'ground',
    capexUsd: 21_500,
    opexUsdPerDay: 13,
    powerKw: 7.5, // LP/amalgam lamps + ballasts — needs power_cable to deliver UV dose
    blurb: 'Ground UV channel with low-pressure lamps. Tertiary pathogen barrier — ~84% pathogen kill per channel when powered; stack channels for potable-grade disinfection.',
  },
  // ── AOP / OZONE — construction-built toxics + pathogen oxidizer (tertiary advanced oxidation) ───
  aop_skid: {
    id: 'aop_skid',
    name: 'Ozone-AOP Oxidation Skid',
    mounting: 'ground',
    capexUsd: 26_500,
    opexUsdPerDay: 16,
    powerKw: 9.5, // O₂ concentrator + ozone generator + reactor contactor
    blurb: 'Ground O₃/AOP skid with O₂ concentrator + reactor. Tertiary oxidizer — ~88% pathogen kill + 55% toxics oxidation per skid when powered; stack for industrial-grade detox.',
  },
};

/** One installed machine. Occupies exactly ONE grid tile. */
export interface ProcessEquipmentItem {
  id: string;
  typeId: string;
  /** Tile coords (the tile's center hosts the machine). */
  x: number;
  y: number;
  /** Yaw in degrees — ground kit rotates visually; 1×1 so no footprint change. */
  rotation?: 0 | 90 | 180 | 270;
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
  placedUnitRects: { x: number; y: number; w: number; h: number }[],
  ignoreEquipmentId?: string
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
  if (equipment.some(e => e.id !== ignoreEquipmentId && e.x === tx && e.y === ty)) {
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
