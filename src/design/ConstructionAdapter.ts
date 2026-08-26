/**
 * ConstructionAdapter — Phase 4 slice 2 of the CONSTRUCTION-BUILDER mission
 * ("Build the process, do not select the process").
 *
 * The player has drawn basins, installed machines, and wired utilities
 * (Phases 1–3). Phase 4 slice 1 made that network *visible* (powered/aerated
 * tints + HUD). This module makes it *functional*: a thin, pure domain
 * adapter that translates the live construction network into adjustments
 * applied once per GameManager.tick AFTER the legacy pipe/unit simulation.
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
 * Effects modeled (one coherent slice):
 *  - Hydraulic buffer: total excavated basin volume gives passive settling /
 *    equalization (up to ~4% BOD/TSS credit for a big plant).
 *  - Aeration: each aerated fine-bubble diffuser (blower→diffuser air_pipe
 *    with a powered blower) adds oxygen and biologically polishes BOD/TSS/TN.
 *  - Mixing / septic: a basin that holds NO powered mixer is a septic dead
 *    zone — solids settle anaerobically, releasing BOD/NH4 and consuming DO.
 *  - Power & OPEX: live-powered machines are summed from ConstructionStats
 *    (the single source of truth for what is actually energized).
 */

import type { CustomBasin } from './CustomBasin';
import type { ProcessEquipmentItem } from './ProcessEquipment';
import type { UtilityConnection } from './UtilityConnection';
import {
  aeratedDiffuserIds,
  constructionStats,
  mixerActiveIds,
} from './ConstructionNetwork';

export interface ConstructionTickEffect {
  /** Number of basins that actually hold a powered mixer (healthy). */
  healthyBasins: number;
  /** Number of basins with NO powered mixer inside (septic). */
  septicBasins: number;
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

/**
 * Pure evaluation of the thin adapter. No mutation.
 */
export function evaluateConstructionEffects(
  basins: CustomBasin[],
  equipment: ProcessEquipmentItem[],
  utilityConnections: Pick<UtilityConnection, 'type' | 'ax' | 'ay' | 'bx' | 'by'>[],
): ConstructionTickEffect {
  const bs = basins ?? [];
  const eq = equipment ?? [];
  const uc = utilityConnections ?? [];
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

  // ── Septic penalty: basins without a powered mixer ───────────────────────
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
    if (septicBasins > 0) {
      const n = Math.min(septicBasins, 3); // cap at 3 dead zones
      const bodPenalty = Math.pow(1.08, n);
      const tnPenalty  = Math.pow(1.05, n);
      const tssPenalty = Math.pow(1.06, n);
      const codPenalty = Math.pow(1.06, n);
      bodMul *= bodPenalty;
      tnMul  *= tnPenalty;
      tssMul *= tssPenalty;
      codMul *= codPenalty;
      doBoost -= Math.min(1.0, 0.40 * n);
      // Hard caps: septic never dominates by more than ~35%
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
    if (septicBasins === 0) parts.push(`${healthyBasins}/${bs.length} basins mixed`);
    else parts.push(`${septicBasins} basin${septicBasins>1?'s':''} septic`);
  }
  if (aerated > 0) parts.push(`${aerated} diffuser${aerated>1?'s':''} aerated`);
  if (extraPowerKw > 0) parts.push(`${extraPowerKw} kW live`);
  if (parts.length === 0) parts.push('no construction effect');
  const summary = parts.join(' · ');

  return {
    healthyBasins,
    septicBasins,
    aeratedDiffusers: aerated,
    poweredMixers,
    totalMixers,
    totalBasinVolumeM3,
    extraPowerKw,
    extraOpexPerDay,
    bodMultiplier: bodMul,
    tnMultiplier: tnMul,
    tssMultiplier: tssMul,
    codMultiplier: codMul,
    doBoostMgL: doBoost,
    summary,
  };
}
