/**
 * ConstructionNetwork — Phase 4 of the CONSTRUCTION-BUILDER mission
 * ("Build the process, do not select the process").
 *
 * The player has drawn basins, installed machines, and run utility lines
 * (Phases 1–3). This module makes those components *functional* without
 * touching the legacy simulation: it answers "what is actually live?"
 *
 *   - poweredEquipmentIds : which machines have power (need a power_cable
 *     incident on their exact tile; powerKw == 0 → always live)
 *   - aeratedDiffuserIds  : which diffusers have air (air_pipe to a
 *     powered blower)
 *   - constructionStats   : derived HUD numbers (volumes, power, salvage)
 *
 * Pure, headless-testable. No three.js, no React.
 */

import { EQUIPMENT_TYPES, ProcessEquipmentItem } from './ProcessEquipment';
import type { UtilityConnection } from './UtilityConnection';
import type { CustomBasin } from './CustomBasin';
import { basinVolumeM3 } from './CustomBasin';

function hasPowerCableAt(
  x: number, y: number,
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): boolean {
  return utilityConnections.some(
    u => u.type === 'power_cable' &&
      ((u.ax === x && u.ay === y) || (u.bx === x && u.by === y))
  );
}

function hasAirPipe(
  ax: number, ay: number, bx: number, by: number,
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): boolean {
  return utilityConnections.some(
    u => u.type === 'air_pipe' &&
      ((u.ax === ax && u.ay === ay && u.bx === bx && u.by === by) ||
       (u.ax === bx && u.ay === by && u.bx === ax && u.by === ay))
  );
}

/**
 * Equipment counts as powered when:
 *  - it draws no power (powerKw === 0, e.g. passive diffuser) → always live
 *  - otherwise at least one power_cable has an endpoint on its exact tile
 */
export function isEquipmentPowered(
  item: ProcessEquipmentItem,
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): boolean {
  const def = EQUIPMENT_TYPES[item.typeId];
  if (!def) return false;
  if (def.powerKw === 0) return true;
  return hasPowerCableAt(item.x, item.y, utilityConnections);
}

export function poweredEquipmentIds(
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): Set<string> {
  const s = new Set<string>();
  for (const eq of equipment) {
    if (isEquipmentPowered(eq, utilityConnections)) s.add(eq.id);
  }
  return s;
}

/**
 * A fine-bubble diffuser is aerated when an air_pipe connects its tile
 * to a blower tile, and that blower is itself powered.
 */
export function isDiffuserAerated(
  diffuser: ProcessEquipmentItem,
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): boolean {
  if (diffuser.typeId !== 'fine_bubble_diffuser') return false;
  // Find every blower that could feed this diffuser
  const blowers = equipment.filter(e => e.typeId === 'rotary_blower');
  for (const blower of blowers) {
    if (!isEquipmentPowered(blower, utilityConnections)) continue;
    if (hasAirPipe(diffuser.x, diffuser.y, blower.x, blower.y, utilityConnections)) return true;
  }
  return false;
}

export function aeratedDiffuserIds(
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): Set<string> {
  const s = new Set<string>();
  for (const eq of equipment) {
    if (eq.typeId === 'fine_bubble_diffuser' && isDiffuserAerated(eq, equipment, utilityConnections)) {
      s.add(eq.id);
    }
  }
  return s;
}

export function mixerActiveIds(
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): Set<string> {
  const s = new Set<string>();
  for (const eq of equipment) {
    if (eq.typeId === 'submersible_mixer' && isEquipmentPowered(eq, utilityConnections)) s.add(eq.id);
  }
  return s;
}

export interface ConstructionStats {
  /** Total excavated water volume of all custom basins (m³). */
  totalBasinVolumeM3: number;
  /** Total footprint area (m²) — tiles × 36 m². */
  totalBasinAreaM2: number;
  totalBasins: number;
  totalEquipment: number;
  poweredEquipment: number;
  unpoweredEquipment: number;
  totalDiffusers: number;
  aeratedDiffusers: number;
  unaeratedDiffusers: number;
  /** Phase 6 filtration stage: membrane cassettes (powered). */
  totalMembranes: number;
  poweredMembranes: number;
  /** Phase 6 filtration stage: MBBR carrier media (passive, needs mixing). */
  totalCarriers: number;
  /** Phase 7 slice 2 instrumentation: live process sensors. */
  totalSensors: number;
  poweredSensors: number;
  totalDoProbes: number;
  poweredDoProbes: number;
  totalFlowMeters: number;
  poweredFlowMeters: number;
  totalLevelSensors: number;
  poweredLevelSensors: number;
  /** Phase 7 slice 3 chemical dosing kit */
  totalChemicalUnits: number;
  poweredChemicalUnits: number;
  totalStorageTanks: number;
  poweredStorageTanks: number;
  totalDosingPumps: number;
  poweredDosingPumps: number;
  /** Nameplate power of *powered* machines only (kW) — what the grid actually feeds. */
  livePowerKw: number;
  /** Nameplate power of all installed machines (kW). */
  installedPowerKw: number;
  /** Live daily OPEX of powered machines (USD/day). Passive kit always live. */
  liveOpexPerDay: number;
  totalUtilityConnections: number;
}

export function constructionStats(
  basins: (CustomBasin & { depthM: number })[],
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[]
): ConstructionStats {
  const powered = poweredEquipmentIds(equipment, utilityConnections);
  const aerated = aeratedDiffuserIds(equipment, utilityConnections);
  let totalBasinVolumeM3 = 0;
  let totalBasinAreaM2 = 0;
  for (const b of basins) {
    totalBasinVolumeM3 += basinVolumeM3(b);
    totalBasinAreaM2 += b.w * b.h * 36;
  }
  const diffusers = equipment.filter(e => e.typeId === 'fine_bubble_diffuser');
  let livePowerKw = 0;
  let installedPowerKw = 0;
  let liveOpexPerDay = 0;
  for (const eq of equipment) {
    const def = EQUIPMENT_TYPES[eq.typeId];
    const pw = def?.powerKw ?? 0;
    const opex = def?.opexUsdPerDay ?? 0;
    installedPowerKw += pw;
    // passive kit (pw==0) always counts as live
    const live = pw === 0 || powered.has(eq.id);
    if (live) {
      livePowerKw += pw;
      liveOpexPerDay += opex;
    }
  }
  return {
    totalBasinVolumeM3: Math.round(totalBasinVolumeM3),
    totalBasinAreaM2: Math.round(totalBasinAreaM2),
    totalBasins: basins.length,
    totalEquipment: equipment.length,
    poweredEquipment: powered.size,
    unpoweredEquipment: equipment.length - powered.size,
    totalDiffusers: diffusers.length,
    aeratedDiffusers: aerated.size,
    unaeratedDiffusers: diffusers.length - aerated.size,
    totalMembranes: equipment.filter(e => e.typeId === 'membrane_cassette').length,
    poweredMembranes: equipment.filter(e => e.typeId === 'membrane_cassette' && powered.has(e.id)).length,
    totalCarriers: equipment.filter(e => e.typeId === 'mbbr_carrier').length,
    totalSensors: equipment.filter(e => e.typeId === 'do_probe' || e.typeId === 'flow_meter' || e.typeId === 'level_sensor').length,
    poweredSensors: equipment.filter(e => (e.typeId === 'do_probe' || e.typeId === 'flow_meter' || e.typeId === 'level_sensor') && powered.has(e.id)).length,
    totalDoProbes: equipment.filter(e => e.typeId === 'do_probe').length,
    poweredDoProbes: equipment.filter(e => e.typeId === 'do_probe' && powered.has(e.id)).length,
    totalFlowMeters: equipment.filter(e => e.typeId === 'flow_meter').length,
    poweredFlowMeters: equipment.filter(e => e.typeId === 'flow_meter' && powered.has(e.id)).length,
    totalLevelSensors: equipment.filter(e => e.typeId === 'level_sensor').length,
    poweredLevelSensors: equipment.filter(e => e.typeId === 'level_sensor' && powered.has(e.id)).length,
    totalChemicalUnits: equipment.filter(e => e.typeId === 'chemical_storage_tank' || e.typeId === 'chemical_dosing_pump').length,
    poweredChemicalUnits: equipment.filter(e => (e.typeId === 'chemical_storage_tank' || e.typeId === 'chemical_dosing_pump') && powered.has(e.id)).length,
    totalStorageTanks: equipment.filter(e => e.typeId === 'chemical_storage_tank').length,
    poweredStorageTanks: equipment.filter(e => e.typeId === 'chemical_storage_tank' && powered.has(e.id)).length,
    totalDosingPumps: equipment.filter(e => e.typeId === 'chemical_dosing_pump').length,
    poweredDosingPumps: equipment.filter(e => e.typeId === 'chemical_dosing_pump' && powered.has(e.id)).length,
    livePowerKw,
    installedPowerKw,
    liveOpexPerDay,
    totalUtilityConnections: utilityConnections.length,
  };
}

/**
 * One-line human summary for toasts / HUD.
 */
export function constructionSummaryLine(s: ConstructionStats): string {
  const parts: string[] = [];
  if (s.totalBasins > 0) parts.push(`${s.totalBasins} basin${s.totalBasins > 1 ? 's' : ''} · ${s.totalBasinVolumeM3.toLocaleString()} m³`);
  if (s.totalEquipment > 0) parts.push(`${s.poweredEquipment}/${s.totalEquipment} powered`);
  if (s.totalDiffusers > 0) parts.push(`${s.aeratedDiffusers}/${s.totalDiffusers} diffusers aerated`);
  if (s.totalMembranes > 0) parts.push(`${s.poweredMembranes}/${s.totalMembranes} membranes live`);
  if (s.totalCarriers > 0) parts.push(`${s.totalCarriers} carrier tile${s.totalCarriers>1?'s':''}`);
  if (s.totalSensors > 0) parts.push(`${s.poweredSensors}/${s.totalSensors} sensors live`);
  if (s.totalChemicalUnits > 0) parts.push(`${s.poweredChemicalUnits}/${s.totalChemicalUnits} dosing live`);
  if (s.totalUtilityConnections > 0) parts.push(`${s.totalUtilityConnections} utility line${s.totalUtilityConnections > 1 ? 's' : ''}`);
  if (parts.length === 0) return 'No custom construction yet — draw a basin to start.';
  return parts.join(' · ');
}
