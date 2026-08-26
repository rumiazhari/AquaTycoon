/**
 * ConstructionAdapter — Phase 4 slice 2 + Phase 5 slice 2 of the CONSTRUCTION-BUILDER mission
 * ("Build the process, do not select the process").
 *
 * The player has drawn basins, installed machines, and wired utilities
 * (Phases 1–3). Phase 4 slice 1 made that network *visible* (powered/aerated
 * tints + HUD). Slice 2 made it *functional*: a thin, pure domain
 * adapter that translates the live construction network into adjustments
 * applied once per GameManager.tick AFTER the legacy pipe/unit simulation.
 *
 * Phase 5 slice 1 added interior baffle walls → derived zones (BasinZone.ts).
 * Slice 2 (this iteration) makes the adapter ZONE-AWARE: each derived zone
 * must hold its own powered mixer; otherwise it is a septic dead pocket.
 * A baffled basin with 4 zones and only one mixer is now 75% septic —
 * the player learns to place mixers per compartment, not per basin.
 *
 * Design constraints:
 *  - Pure, headless-testable. No three.js, no React.
 *  - Zero construction = zero effect (100% backward compatible).
 *  - Small, conservative magnitudes — a handful of aerated diffusers polishes
 *    the effluent ~5–20%, not 90%. Septic penalty without powered mixing
 *    cancels the volume/aeration benefit, teaching the player to power mixers.
 *  - Power/OPEX is charged honestly via the live-power set (blower/mixer/pump
 *    only count when a power_cable touches their tile; passive diffusers always live).
 *
 * Effects modeled:
 *  - Hydraulic buffer: total excavated basin volume gives passive settling /
 *    equalization (up to ~4% BOD/TSS credit for a big plant).
 *  - Aeration: each aerated fine-bubble diffuser (blower→diffuser air_pipe
 *    with a powered blower) adds oxygen and biologically polishes BOD/TSS/TN.
 *  - Mixing / septic: per-ZONE when baffle walls exist (each zone needs a
 *    powered mixer), per-BASIN otherwise — the fallback keeps all legacy
 *    tests green when baffles=[].
 *  - Power & OPEX: live-powered machines are summed from ConstructionStats
 *    (the single source of truth for what is actually energized).
 */

import type { CustomBasin } from './CustomBasin';
import type { ProcessEquipmentItem } from './ProcessEquipment';
import type { UtilityConnection } from './UtilityConnection';
import type { BaffleWall } from './BasinZone';
import { allZones } from './BasinZone';
import {
  aeratedDiffuserIds,
  constructionStats,
  mixerActiveIds,
  poweredEquipmentIds,
} from './ConstructionNetwork';

export interface ConstructionTickEffect {
  /** Number of basins that actually hold a powered mixer (healthy). */
  healthyBasins: number;
  /** Number of basins with NO powered mixer inside (septic). */
  septicBasins: number;
  /** Derived-zone counts (Phase 5 slice 2). When no baffles, equals basins. */
  totalZones: number;
  healthyZones: number;
  septicZones: number;
  /** Aerated diffuser grids (air_pipe to a powered blower). */
  aeratedDiffusers: number;
  /** Powered mixers (need power_cable). */
  poweredMixers: number;
  /** All mixers installed (powered or not). */
  totalMixers: number;
  /** Excavated water volume of all basins (m³). */
  totalBasinVolumeM3: number;
  /** Live power draw of powered machines + passive kit (kW). */
  extraPowerKw: number;
  /** Live daily OPEX of powered machines (USD/day). */
  extraOpexPerDay: number;
  /** Filtration stage — Phase 6 slice 2: per-zone membrane & carrier counts. */
  totalMembranes: number;
  poweredMembranes: number;
  liveMembranes: number;
  degradedMembranes: number;
  totalCarriers: number;
  activeCarriers: number;
  aeratedCarriers: number;
  /** Effluent multipliers (<1 = improvement, >1 = penalty). */
  bodMultiplier: number;
  tnMultiplier: number;
  tssMultiplier: number;
  codMultiplier: number;
  /** Dissolved-oxygen delta added to the final effluent (mg/L, may be negative). */
  doBoostMgL: number;
  /** Quick human summary for diagnostics. */
  summary: string;
}

function mixerInBasin(
  mixer: ProcessEquipmentItem,
  basin: CustomBasin,
): boolean {
  return mixer.x >= basin.x && mixer.x < basin.x + basin.w
      && mixer.y >= basin.y && mixer.y < basin.y + basin.h;
}

function mixerInZone(
  mixer: ProcessEquipmentItem,
  zone: { x: number; y: number; w: number; h: number },
): boolean {
  return mixer.x >= zone.x && mixer.x < zone.x + zone.w
      && mixer.y >= zone.y && mixer.y < zone.y + zone.h;
}

/**
 * Pure evaluation of the thin adapter. No mutation.
 * @param baffles optional Phase-5 interior walls — when supplied, septic is
 * evaluated PER ZONE (each derived cell needs its own powered mixer).
 * Empty/undefined falls back to the legacy per-basin check so every existing
 * 3-arg call (and 100% of old tests) keeps its exact numbers.
 */
export function evaluateConstructionEffects(
  basins: CustomBasin[],
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[],
  baffles: BaffleWall[] = [],
): ConstructionTickEffect {
  const bs = basins ?? [];
  const eq = equipment ?? [];
  const uc = utilityConnections ?? [];
  const bfs = baffles ?? [];
  const hasBaffles = bfs.length > 0 && bs.length > 0;
  const stats = constructionStats(
    bs as (CustomBasin & { depthM: number })[],
    eq,
    uc,
  );
  const aeratedSet = aeratedDiffuserIds(eq, uc);
  const poweredMixerIds = mixerActiveIds(eq, uc);

  const aerated = aeratedSet.size;
  const poweredMixers = poweredMixerIds.size;
  const totalMixers = eq.filter(e => e.typeId === 'submersible_mixer').length;
  const totalBasinVolumeM3 = stats.totalBasinVolumeM3;

  // ── Aeration + hydraulic buffer (positive) ───────────────────────────────
  let bodMul = 1;
  let tnMul = 1;
  let tssMul = 1;
  let codMul = 1;
  let doBoost = 0;

  if (bs.length > 0 && aerated > 0) {
    const steps = Math.min(aerated, 8); // cap benefit at ~8 grids
    // Each aerated grid: ~3% BOD, ~1.5% TN/TSS/COD improvement
    bodMul *= Math.pow(0.97, steps);
    tnMul  *= Math.pow(0.985, steps);
    tssMul *= Math.pow(0.985, steps);
    codMul *= Math.pow(0.978, steps);
    // Clamp aeration benefit (no miracle plant)
    bodMul = Math.max(0.75, bodMul);
    tnMul  = Math.max(0.85, tnMul);
    tssMul = Math.max(0.90, tssMul);
    codMul = Math.max(0.80, codMul);
    doBoost += Math.min(1.2, aerated * 0.28);
    // Hydraulic volume adds a small equalization/settling credit
    // up to 4% for a very large plant (25 000 m³ = ~5× 4×4 basins)
    const volBonus = Math.min(0.04, totalBasinVolumeM3 / 25000);
    if (volBonus > 0) {
      bodMul *= (1 - volBonus);
      tnMul  *= (1 - volBonus * 0.6);
      tssMul *= (1 - volBonus * 0.4);
      codMul *= (1 - volBonus * 0.8);
      doBoost += volBonus * 0.8; // extra re-aeration retention
    }
  } else if (bs.length > 0 && totalBasinVolumeM3 > 0) {
    // Basins alone (no aeration) still give a modest settling buffer
    const volBonus = Math.min(0.03, totalBasinVolumeM3 / 30000);
    if (volBonus > 0) {
      bodMul *= (1 - volBonus);
      tssMul *= (1 - volBonus * 0.8);
      codMul *= (1 - volBonus * 0.5);
    }
  }

  // ── Septic bookkeeping: basin-level (legacy compat) + zone-level (Phase 5) ─
  let septicBasins = 0;
  let healthyBasins = 0;
  if (bs.length > 0) {
    for (const b of bs) {
      const hasPoweredMixer = eq.some(e =>
        e.typeId === 'submersible_mixer'
        && poweredMixerIds.has(e.id)
        && mixerInBasin(e, b)
      );
      if (hasPoweredMixer) healthyBasins++;
      else septicBasins++;
    }
  }

  let totalZones: number;
  let healthyZones: number;
  let septicZones: number;
  // Cache zones for filtration (Phase 6 slice 2) — reuse for septic counting
  let derivedZones: any[] | null = null;
  if (hasBaffles) {
    derivedZones = allZones(bs as unknown as CustomBasin[], bfs) as any;
    const zones: any[] = derivedZones!;
    totalZones = zones.length;
    healthyZones = 0;
    septicZones = 0;
    for (const z of zones) {
      const hasMixer = eq.some(e =>
        e.typeId === 'submersible_mixer'
        && poweredMixerIds.has(e.id)
        && mixerInZone(e, z)
      );
      if (hasMixer) healthyZones++;
      else septicZones++;
    }
  } else {
    totalZones = bs.length;
    healthyZones = healthyBasins;
    septicZones = septicBasins;
  }

  // ── Phase 6 slice 2: per-zone filtration (membrane TSS + carrier BOD) ──────
  // Membranes are absolute-barrier filtration; carriers are biofilm that needs
  // mixing + aeration to stay fluidised. Both are zone-scoped when baffles exist.
  let totalMembranes = 0;
  let poweredMembranes = 0;
  let liveMembranes = 0;
  let degradedMembranes = 0;
  let totalCarriers = 0;
  let activeCarriers = 0;
  let aeratedCarriers = 0;
  // Build per-zone health/aeration maps for filtration lookup
  const zoneHealthyById = new Map<string, boolean>();
  const zoneAeratedById = new Map<string, boolean>();
  if (eq.some(e => e.typeId === 'membrane_cassette' || e.typeId === 'mbbr_carrier')) {
    // Populate zone maps (works for both baffled and un-baffled worlds)
    const zonesForFilt: { id: string; basinId: string; x: number; y: number; w: number; h: number }[] =
      hasBaffles && derivedZones
        ? derivedZones
        : bs.map(b => ({ id: b.id, basinId: b.id, x: b.x, y: b.y, w: b.w, h: b.h }));
    for (const z of zonesForFilt) {
      const healthy = eq.some(e =>
        e.typeId === 'submersible_mixer' && poweredMixerIds.has(e.id) && mixerInZone(e, z as any)
      );
      zoneHealthyById.set(z.id, healthy);
      const aerated = eq.some(e =>
        e.typeId === 'fine_bubble_diffuser' && aeratedSet.has(e.id) && mixerInZone(e as any, z as any)
      );
      zoneAeratedById.set(z.id, aerated);
    }
    const poweredSetForMem = poweredEquipmentIds(eq as any, uc as any);
    // Helper: find zone id for a tile
    const zoneIdForTile = (tx: number, ty: number): string | null => {
      for (const z of zonesForFilt) {
        if (tx >= z.x && tx < z.x + z.w && ty >= z.y && ty < z.y + z.h) return z.id;
      }
      return null;
    };
    for (const e of eq) {
      if (e.typeId === 'membrane_cassette') {
        totalMembranes++;
        const powered = poweredSetForMem.has(e.id);
        if (powered) {
          poweredMembranes++;
          const zid = zoneIdForTile(e.x, e.y);
          const healthy = zid ? (zoneHealthyById.get(zid) ?? false) : false;
          if (healthy) liveMembranes++;
          else degradedMembranes++;
        }
      } else if (e.typeId === 'mbbr_carrier') {
        totalCarriers++;
        const zid = zoneIdForTile(e.x, e.y);
        const healthy = zid ? (zoneHealthyById.get(zid) ?? false) : false;
        if (healthy) {
          activeCarriers++;
          const aerated = zid ? (zoneAeratedById.get(zid) ?? false) : false;
          if (aerated) aeratedCarriers++;
        }
      }
    }
    // Apply filtration multipliers (only when basins exist — no basin = no custom treatment)
    if (bs.length > 0) {
      // Membrane TSS polishing: live = 0.20× per membrane (80% removal), degraded = 0.55× (45% removal), floor 0.02
      if (poweredMembranes > 0) {
        let tssFilt = 1;
        for (let i = 0; i < liveMembranes; i++) tssFilt *= 0.20;
        for (let i = 0; i < degradedMembranes; i++) tssFilt *= 0.55;
        // Small BOD/COD polish from membrane barrier too (5% per live, 2% per degraded)
        let bodFiltMem = 1;
        let codFiltMem = 1;
        for (let i = 0; i < liveMembranes; i++) { bodFiltMem *= 0.95; codFiltMem *= 0.96; }
        for (let i = 0; i < degradedMembranes; i++) { bodFiltMem *= 0.98; codFiltMem *= 0.985; }
        tssMul *= Math.max(0.02, tssFilt);
        bodMul *= Math.max(0.75, bodFiltMem);
        codMul *= Math.max(0.78, codFiltMem);
        // Turbidity & TP follow TSS (handled in GameManager.tick via tssMultiplier), no extra work
      }
      // Carrier BOD/TN biofilm: each active carrier 0.965× BOD, aerated carriers extra 0.97× BOD + 0.985× TN
      if (activeCarriers > 0) {
        let bodFiltCar = 1;
        let tnFiltCar = 1;
        for (let i = 0; i < activeCarriers; i++) bodFiltCar *= 0.965;
        for (let i = 0; i < aeratedCarriers; i++) { bodFiltCar *= 0.97; tnFiltCar *= 0.985; }
        bodMul *= Math.max(0.70, bodFiltCar);
        tnMul  *= Math.max(0.88, tnFiltCar);
        // COD tracks BOD partially (biofilm removes organics)
        let codFiltCar = 1;
        for (let i = 0; i < activeCarriers; i++) codFiltCar *= 0.97;
        for (let i = 0; i < aeratedCarriers; i++) codFiltCar *= 0.985;
        codMul *= Math.max(0.74, codFiltCar);
      }
    }
  } else {
    totalMembranes = eq.filter(e => e.typeId === 'membrane_cassette').length;
    poweredMembranes = 0;
    totalCarriers = eq.filter(e => e.typeId === 'mbbr_carrier').length;
  }

  // ── Apply septic penalty (zone-aware when baffles exist) ─────────────────
  const septicForPenalty = hasBaffles ? septicZones : septicBasins;
  if (septicForPenalty > 0) {
    if (hasBaffles) {
      // Per-zone penalties are half the per-basin hit — a 4-zone basin with
      // one mixer (3 septic zones) is penalised ~14% not 26%, so baffles are
      // not a trap and teaching is "one mixer per compartment".
      const n = Math.min(septicForPenalty, 6); // cap at 6 dead zones
      const bodPenalty = Math.pow(1.045, n);
      const tnPenalty  = Math.pow(1.028, n);
      const tssPenalty = Math.pow(1.035, n);
      const codPenalty = Math.pow(1.035, n);
      bodMul *= bodPenalty;
      tnMul  *= tnPenalty;
      tssMul *= tssPenalty;
      codMul *= codPenalty;
      doBoost -= Math.min(1.2, 0.22 * n);
      // Hard caps
      bodMul = Math.min(1.35, bodMul);
      tnMul  = Math.min(1.25, tnMul);
      tssMul = Math.min(1.30, tssMul);
      codMul = Math.min(1.30, codMul);
    } else {
      const n = Math.min(septicBasins, 3); // cap at 3 dead basins (legacy)
      const bodPenalty = Math.pow(1.08, n);
      const tnPenalty  = Math.pow(1.05, n);
      const tssPenalty = Math.pow(1.06, n);
      const codPenalty = Math.pow(1.06, n);
      bodMul *= bodPenalty;
      tnMul  *= tnPenalty;
      tssMul *= tssPenalty;
      codMul *= codPenalty;
      doBoost -= Math.min(1.0, 0.40 * n);
      bodMul = Math.min(1.35, bodMul);
      tnMul  = Math.min(1.25, tnMul);
      tssMul = Math.min(1.30, tssMul);
      codMul = Math.min(1.30, codMul);
    }
  }

  doBoost = Math.max(-1.0, Math.min(1.5, doBoost));

  const extraPowerKw = stats.livePowerKw;
  const extraOpexPerDay = stats.liveOpexPerDay;

  const parts: string[] = [];
  if (bs.length === 0) parts.push('no custom basins');
  else {
    if (hasBaffles) {
      if (septicZones === 0) parts.push(`${healthyZones}/${totalZones} zones mixed`);
      else parts.push(`${septicZones} zone${septicZones>1?'s':''} septic`);
    } else {
      if (septicBasins === 0) parts.push(`${healthyBasins}/${bs.length} basins mixed`);
      else parts.push(`${septicBasins} basin${septicBasins>1?'s':''} septic`);
    }
  }
  if (aerated > 0) parts.push(`${aerated} diffuser${aerated>1?'s':''} aerated`);
  if (liveMembranes > 0) parts.push(`${liveMembranes} membrane${liveMembranes>1?'s':''} filtering`);
  else if (poweredMembranes > 0 && degradedMembranes > 0) parts.push(`${degradedMembranes} membrane${degradedMembranes>1?'s':''} fouled`);
  if (activeCarriers > 0) parts.push(`${activeCarriers} carrier${activeCarriers>1?'s':''} active${aeratedCarriers>0?` (${aeratedCarriers} aerated)`:''}`);
  if (extraPowerKw > 0) parts.push(`${extraPowerKw} kW live`);
  if (parts.length === 0) parts.push('no construction effect');
  const summary = parts.join(' · ');

  return {
    healthyBasins,
    septicBasins,
    totalZones,
    healthyZones,
    septicZones,
    aeratedDiffusers: aerated,
    poweredMixers,
    totalMixers,
    totalBasinVolumeM3,
    extraPowerKw,
    extraOpexPerDay,
    totalMembranes,
    poweredMembranes,
    liveMembranes,
    degradedMembranes,
    totalCarriers,
    activeCarriers,
    aeratedCarriers,
    bodMultiplier: bodMul,
    tnMultiplier: tnMul,
    tssMultiplier: tssMul,
    codMultiplier: codMul,
    doBoostMgL: doBoost,
    summary,
  };
}

/**
 * Per-equipment filtration live sets for 3D tinting.
 * Returns which membranes are actively filtering (powered + healthy zone)
 * and which carriers are fluidised (+ aerated). Pure, headless-testable.
 */
export function filtrationLiveSets(
  basins: CustomBasin[],
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[],
  baffles: BaffleWall[] = [],
): { liveMembraneIds: Set<string>; degradedMembraneIds: Set<string>; activeCarrierIds: Set<string>; aeratedCarrierIds: Set<string> } {
  const ce = evaluateConstructionEffects(basins, equipment, utilityConnections, baffles);
  // Re-derive the same zone maps to build the per-id sets (reuse logic from evaluateConstructionEffects)
  const bs = basins ?? [];
  const eq = equipment ?? [];
  const uc = utilityConnections ?? [];
  const bfs = baffles ?? [];
  const hasBaffles = bfs.length > 0 && bs.length > 0;
  const aeratedSet = aeratedDiffuserIds(eq, uc);
  const poweredMixerIds = mixerActiveIds(eq, uc);
  const poweredSet = poweredEquipmentIds(eq as any, uc as any);
  let derivedZones: any[] | null = null;
  if (hasBaffles) {
    derivedZones = allZones(bs as unknown as CustomBasin[], bfs) as any;
  }
  const zonesForFilt: { id: string; x: number; y: number; w: number; h: number }[] =
    hasBaffles && derivedZones ? derivedZones : bs.map(b => ({ id: (b as any).id, x: (b as any).x, y: (b as any).y, w: (b as any).w, h: (b as any).h }));
  const zoneHealthyById = new Map<string, boolean>();
  const zoneAeratedById = new Map<string, boolean>();
  for (const z of zonesForFilt) {
    const healthy = eq.some(e => e.typeId === 'submersible_mixer' && poweredMixerIds.has(e.id) && e.x >= z.x && e.x < z.x + z.w && e.y >= z.y && e.y < z.y + z.h);
    zoneHealthyById.set(z.id, healthy);
    const aerated = eq.some(e => e.typeId === 'fine_bubble_diffuser' && aeratedSet.has(e.id) && e.x >= z.x && e.x < z.x + z.w && e.y >= z.y && e.y < z.y + z.h);
    zoneAeratedById.set(z.id, aerated);
  }
  const zoneIdForTile = (tx: number, ty: number): string | null => {
    for (const z of zonesForFilt) if (tx >= z.x && tx < z.x + z.w && ty >= z.y && ty < z.y + z.h) return z.id;
    return null;
  };
  const liveMembraneIds = new Set<string>();
  const degradedMembraneIds = new Set<string>();
  const activeCarrierIds = new Set<string>();
  const aeratedCarrierIds = new Set<string>();
  for (const e of eq) {
    if (e.typeId === 'membrane_cassette' && poweredSet.has(e.id)) {
      const zid = zoneIdForTile(e.x, e.y);
      const healthy = zid ? (zoneHealthyById.get(zid) ?? false) : false;
      if (healthy) liveMembraneIds.add(e.id); else degradedMembraneIds.add(e.id);
    } else if (e.typeId === 'mbbr_carrier') {
      const zid = zoneIdForTile(e.x, e.y);
      const healthy = zid ? (zoneHealthyById.get(zid) ?? false) : false;
      if (healthy) {
        activeCarrierIds.add(e.id);
        if (zid && (zoneAeratedById.get(zid) ?? false)) aeratedCarrierIds.add(e.id);
      }
    }
  }
  // Early return with empty sets when no filtration equipment — keeps evaluateConstructionEffects counts in sync is fine
  // ce is evaluated above for counts; sets are derived independently but consistently
  void ce;
  return { liveMembraneIds, degradedMembraneIds, activeCarrierIds, aeratedCarrierIds };
}
