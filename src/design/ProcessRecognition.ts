/**
 * ProcessRecognition — CONSTRUCTION-BUILDER PHASE 7 slice 1
 * ("Build the process, do not select the process").
 *
 * The player physically builds basins, baffles, machines and utility
 * lines (Phases 1–6). Physics already follows the constructed config
 * via ConstructionAdapter. This module is the *observer*: a pure,
 * headless function that READS the built plant and emits descriptive
 * badges that resemble real process archetypes — WITHOUT ever labeling
 * the plant authoritatively or changing physics.
 *
 * Badges are EDUCATIONAL HINTS ("Resembles …", "IFAS-like", "Anoxic → Aerobic")
 * so the player learns which archetype they have accidentally built,
 * while the sim stays driven purely by ConstructionAdapter multipliers.
 * No badge influences simulation — it is a read-only lens.
 *
 * Badges include:
 *  - Compartmentalised (baffles → zones)
 *  - Aerated / Mixed / Aerated+Mixed (activated-sludge-like)
 *  - Anoxic → Aerobic sequence (baffled train with one aerated zone + one mixed-only zone)
 *  - Membrane barrier (MBR-like) — powered cassettes
 *  - Biofilm media (MBBR-like) — fluidised carriers
 *  - Hybrid IFAS-like (suspended + biofilm in the same aerated zone)
 *  - Septic warning (unmixed zones)
 *
 * Pure domain: no three.js, no React. Fully headless-testable.
 */
import type { CustomBasin } from './CustomBasin';
import type { ProcessEquipmentItem } from './ProcessEquipment';
import type { UtilityConnection } from './UtilityConnection';
import type { BaffleWall } from './BasinZone';
import { allZones } from './BasinZone';
import {
  aeratedDiffuserIds,
  mixerActiveIds,
  poweredEquipmentIds,
} from './ConstructionNetwork';

export type ProcessBadgeTone = 'emerald' | 'sky' | 'cyan' | 'violet' | 'amber' | 'slate';

export interface ProcessBadge {
  /** Stable id for React keys / tests */
  id: string;
  /** Short label, e.g. "Membrane barrier" */
  label: string;
  /** One-line detail, e.g. "2 live cassettes — MBR-like" */
  detail: string;
  tone: ProcessBadgeTone;
}

function mixerInZone(
  mixer: ProcessEquipmentItem,
  zone: { x: number; y: number; w: number; h: number },
): boolean {
  return mixer.x >= zone.x && mixer.x < zone.x + zone.w
      && mixer.y >= zone.y && mixer.y < zone.y + zone.h;
}

export function recognizeProcess(
  basins: CustomBasin[],
  baffles: BaffleWall[],
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[],
): ProcessBadge[] {
  const bs = basins ?? [];
  const bfs = baffles ?? [];
  const eq = equipment ?? [];
  const uc = utilityConnections ?? [];
  if (bs.length === 0) return [];

  const hasBaffles = bfs.length > 0;
  const badges: ProcessBadge[] = [];

  // ── Network sets (single source of truth, mirrors ConstructionAdapter) ────
  const aeratedSet = aeratedDiffuserIds(eq as any, uc as any);
  const poweredMixerIds = mixerActiveIds(eq as any, uc as any);
  const poweredSet = poweredEquipmentIds(eq as any, uc as any);

  const aeratedCount = aeratedSet.size;
  const poweredMixers = poweredMixerIds.size;
  const totalMixers = eq.filter(e => e.typeId === 'submersible_mixer').length;

  // ── Derived zone partition (mirrors ConstructionAdapter) ──────────────────
  let derivedZones: { id: string; x: number; y: number; w: number; h: number }[] | null = null;
  if (hasBaffles) {
    derivedZones = allZones(bs as unknown as CustomBasin[], bfs as any) as any;
  }
  const zones: { id: string; x: number; y: number; w: number; h: number }[] =
    hasBaffles && derivedZones ? derivedZones : bs.map(b => ({ id: (b as any).id, x: (b as any).x, y: (b as any).y, w: (b as any).w, h: (b as any).h }));

  const zoneHealthy = new Map<string, boolean>();
  const zoneAerated = new Map<string, boolean>();
  const zoneHasLiveMembrane = new Map<string, boolean>();
  const zoneHasActiveCarrier = new Map<string, boolean>();

  for (const z of zones) {
    const healthy = eq.some(e => e.typeId === 'submersible_mixer' && poweredMixerIds.has(e.id) && mixerInZone(e as any, z as any));
    zoneHealthy.set(z.id, healthy);
    const aerated = eq.some(e => e.typeId === 'fine_bubble_diffuser' && aeratedSet.has(e.id) && mixerInZone(e as any, z as any));
    zoneAerated.set(z.id, aerated);
  }

  // Per-zone filtration (reuse healthy map)
  const membraneItems = eq.filter(e => e.typeId === 'membrane_cassette');
  const carrierItems = eq.filter(e => e.typeId === 'mbbr_carrier');
  let liveMembranes = 0;
  let degradedMembranes = 0;
  let poweredMembranes = 0;
  let activeCarriers = 0;
  let aeratedCarriers = 0;
  // Instrumentation kit — powered sensor counts
  const sensorItems = eq.filter(e => e.typeId === 'do_probe' || e.typeId === 'flow_meter' || e.typeId === 'level_sensor');
  let poweredSensors = 0;
  for (const e of sensorItems) if (poweredSet.has(e.id)) poweredSensors++;

  const zoneIdForTile = (tx: number, ty: number): string | null => {
    for (const z of zones) if (tx >= z.x && tx < z.x + z.w && ty >= z.y && ty < z.y + z.h) return z.id;
    return null;
  };

  for (const e of membraneItems) {
    if (poweredSet.has(e.id)) {
      poweredMembranes++;
      const zid = zoneIdForTile(e.x, e.y);
      const healthy = zid ? (zoneHealthy.get(zid) ?? false) : false;
      if (healthy) { liveMembranes++; if (zid) zoneHasLiveMembrane.set(zid, true); }
      else { degradedMembranes++; }
    }
  }
  for (const e of carrierItems) {
    const zid = zoneIdForTile(e.x, e.y);
    const healthy = zid ? (zoneHealthy.get(zid) ?? false) : false;
    if (healthy) {
      activeCarriers++;
      if (zid) zoneHasActiveCarrier.set(zid, true);
      const aerated = zid ? (zoneAerated.get(zid) ?? false) : false;
      if (aerated) aeratedCarriers++;
    }
  }

  const totalZones = zones.length;
  const healthyZones = zones.filter(z => zoneHealthy.get(z.id)).length;
  const septicZones = totalZones - healthyZones;
  const aeratedZones = zones.filter(z => zoneAerated.get(z.id)).length;

  // ── 1. Compartmentalised ────────────────────────────────────────────────
  if (hasBaffles && bfs.length > 0) {
    badges.push({
      id: 'compartment',
      label: 'Compartmentalised',
      detail: `${totalZones} zones · ${bfs.length} baffle${bfs.length === 1 ? '' : 's'} — baffles partition flow`,
      tone: 'violet',
    });
  }

  // ── 2. Aerated ────────────────────────────────────────────────────────
  if (aeratedCount > 0) {
    badges.push({
      id: 'aerated',
      label: 'Aerated',
      detail: `${aeratedCount} diffuser${aeratedCount === 1 ? '' : 's'} aerated in ${aeratedZones} zone${aeratedZones === 1 ? '' : 's'}`,
      tone: 'emerald',
    });
  }

  // ── 3. Mixed ──────────────────────────────────────────────────────────
  if (poweredMixers > 0) {
    badges.push({
      id: 'mixed',
      label: 'Mixed',
      detail: `${poweredMixers}/${totalMixers} mixer${poweredMixers === 1 ? '' : 's'} powered · ${healthyZones}/${totalZones} zone${totalZones === 1 ? '' : 's'} mixed`,
      tone: 'sky',
    });
  }

  // ── 4. Activated-sludge-like (aerated + mixed co-located) ───────────
  if (aeratedCount > 0 && poweredMixers > 0) {
    const coLocated = zones.some(z => (zoneAerated.get(z.id) ?? false) && (zoneHealthy.get(z.id) ?? false));
    if (coLocated) {
      badges.push({
        id: 'activated',
        label: 'Activated-sludge-like',
        detail: 'Aeration + mixing in the same zone — resembles suspended-growth',
        tone: 'emerald',
      });
    }
  }

  // ── 5. Anoxic → Aerobic sequence (baffled train) ─────────────────────
  if (hasBaffles && totalZones >= 2) {
    const hasAeratedZone = zones.some(z => zoneAerated.get(z.id) ?? false);
    const hasNonAeratedZone = zones.some(z => !(zoneAerated.get(z.id) ?? false));
    // At least one aerated zone and at least one zone without aeration
    // (that zone is implicitly "anoxic" when it has a mixer — otherwise septic)
    if (hasAeratedZone && hasNonAeratedZone) {
      badges.push({
        id: 'anoxic-aerobic',
        label: 'Anoxic → Aerobic',
        detail: 'Baffled train with aerated + non-aerated zones — resembles A²O / MLE',
        tone: 'violet',
      });
    }
  }

  // ── 6. Membrane barrier (MBR-like) ──────────────────────────────────
  if (poweredMembranes > 0) {
    const qualifier = liveMembranes > 0
      ? `${liveMembranes} live${degradedMembranes > 0 ? ` · ${degradedMembranes} fouled` : ''}`
      : `${degradedMembranes} fouled — add mixing`;
    badges.push({
      id: 'membrane',
      label: 'Membrane barrier',
      detail: `${qualifier} cassette${poweredMembranes === 1 ? '' : 's'} — MBR-like filtration`,
      tone: 'cyan',
    });
  }

  // ── 7. Biofilm carriers (MBBR-like) ─────────────────────────────────
  if (activeCarriers > 0 || carrierItems.length > 0) {
    if (activeCarriers > 0) {
      const extra = aeratedCarriers > 0 ? ` (${aeratedCarriers} aerated)` : '';
      badges.push({
        id: 'biofilm',
        label: 'Biofilm media',
        detail: `${activeCarriers} active carrier${activeCarriers === 1 ? '' : 's'}${extra} — MBBR-like`,
        tone: 'sky',
      });
    } else if (carrierItems.length > 0 && poweredMixers === 0) {
      // Carriers present but all dormant (no mixing)
      badges.push({
        id: 'biofilm-dormant',
        label: 'Biofilm carriers (dormant)',
        detail: `${carrierItems.length} carrier${carrierItems.length === 1 ? '' : 's'} — not fluidised, needs mixing`,
        tone: 'amber',
      });
    }
  }

  // ── 8. Hybrid IFAS-like (aerated + carriers in same zone) ───────────
  if (aeratedCarriers > 0) {
    const hybridZones = zones.filter(z =>
      (zoneAerated.get(z.id) ?? false) && (zoneHasActiveCarrier.get(z.id) ?? false)
    ).length;
    if (hybridZones > 0) {
      badges.push({
        id: 'ifas',
        label: 'Hybrid IFAS-like',
        detail: `Suspended + biofilm in ${hybridZones} aerated zone${hybridZones === 1 ? '' : 's'}`,
        tone: 'cyan',
      });
    }
  }

  // ── 9. Septic warning ────────────────────────────────────────────────
  if (septicZones > 0 && totalMixers > 0) {
    // Only warn when mixers exist somewhere but don't cover all zones
    badges.push({
      id: 'septic',
      label: 'Septic risk',
      detail: `${septicZones} zone${septicZones === 1 ? '' : 's'} unmixed — solids may go septic`,
      tone: 'amber',
    });
  } else if (septicZones === totalZones && totalZones > 1 && totalMixers === 0) {
    badges.push({
      id: 'septic',
      label: 'Septic risk',
      detail: `${totalZones} zones with no mixing — add mixers to avoid septic dead pockets`,
      tone: 'amber',
    });
  }

  // ── 10. Instrumented (Phase 7 slice 2) ─────────────────────────────
  if (poweredSensors >= 2) {
    const types = new Set(sensorItems.filter(e => poweredSet.has(e.id)).map(e => e.typeId));
    const typeLabel = types.size >= 3 ? 'full triad (DO+flow+level)' : `${types.size} sensor type${types.size===1?'':'s'}`;
    badges.push({
      id: 'instrumented',
      label: 'Instrumented',
      detail: `${poweredSensors} sensor${poweredSensors===1?'':'s'} live (${typeLabel}) — telemetry online`,
      tone: 'slate',
    });
  }

  return badges;
}

export function processSummaryLine(badges: ProcessBadge[]): string {
  if (badges.length === 0) return 'No process pattern recognised yet — build basins & equipment to see badges.';
  return badges.map(b => b.label).join(' · ');
}
