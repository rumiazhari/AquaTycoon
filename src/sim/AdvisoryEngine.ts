import { GameState } from '../gameplay/GameManager';
import { SimulationEngine } from './SimulationEngine';
import { UNIT_DEFINITIONS } from './UnitProcessModels';
import {
  permitViolations,
  PERMIT_LABEL,
  PERMIT_FIELD,
  violationRatio,
  PermitCriterion,
  PermitCriterionKey,
} from './PermitEngine';
import { PlacedUnit, TreatmentStandard, UnitTypeId, WaterQuality } from '../types/simulation';
import { membraneCipCostUsd, membraneReplacementCostUsd, MBR_CLEANING_THRESHOLD, MBR_EOL_IRREVERSIBLE, MEMBRANE_MATERIALS } from './processes/MBR';

/**
 * Compliance Doctor — turns raw effluent numbers into an actionable,
 * ranked repair plan. Every parameter-tweak candidate is evaluated against
 * the real process simulator before being offered, so the advice is honest:
 * players see the predicted outcome ("BOD 39 → 17 mg/L") of each action.
 */

export interface FixAction {
  kind: 'adjust_param' | 'build_unit' | 'start_piping' | 'auto_train' | 'clean_mbr' | 'replace_mbr';
  label: string;
  detail: string;
  /** predicted parameter outcome for adjust_param actions */
  prediction?: string;
  unitTypeId?: UnitTypeId;
  instanceId?: string;
  paramKey?: string;
  delta?: number;
  affordable: boolean;
}

export interface Advisory {
  id: string;
  severity: 'critical' | 'warning';
  title: string;
  cause: string;
  fixes: FixAction[];
}

interface Violation {
  key: string;
  label: string;
  value: number;
  limit: number;
  ratio: number; // value / limit (>1 = failing)
}

const POWER_RATE = 0.15; // $/kWh matches SimulationEngine default

export function getInfluent(gs: GameState): WaterQuality {
  return gs.gameMode === 'sandbox' ? gs.sandboxCustomInfluent : gs.currentLevel.influentSpec;
}

/**
 * Single-source compliance check — delegates to PermitEngine (the ONE
 * authoritative evaluator shared with the HUD, Operator Console and PFD) so
 * advisory ranking can never disagree with any other compliance surface.
 * Supports TRUE ZERO pathogen limits (no Math.max(1, …) clamping) and covers
 * pH band + turbidity, which the previous local copy silently dropped.
 */
export function collectViolations(eff: WaterQuality, std: TreatmentStandard): Violation[] {
  return permitViolations(eff, std).map((cr: PermitCriterion): Violation => ({
    key: cr.key,
    label: PERMIT_LABEL[cr.key],
    value: cr.value,
    limit: cr.limit,
    ratio: violationRatio(cr),
  }));
}

/** Total normalized exceedance — lower is better. Used to rank candidate fixes. */
function violationScore(eff: WaterQuality, std: TreatmentStandard): number {
  return collectViolations(eff, std).reduce(
    (acc, v) => acc + (v.key === 'pathogens' ? Math.log10(v.ratio) * 2 : v.ratio),
    0
  );
}

function cloneUnitsForSim(units: PlacedUnit[]): PlacedUnit[] {
  return units.map(u => ({ ...u, lastOutletQuality: { ...u.lastOutletQuality }, lastInletQuality: { ...u.lastInletQuality } }));
}

function simulateEffluent(gs: GameState, units: PlacedUnit[]) {
  const influent = getInfluent(gs);
  const result = SimulationEngine.stepSimulation(
    units,
    gs.pipes,
    influent,
    gs.currentLevel.standards,
    gs.financials,
    gs.currentLevel.tariffPerM3
  );
  return result.finalEffluent;
}

/** Finds a free rectangle near the main treatment line for auto-placing a suggested unit. */
export function findFreeSpot(
  units: PlacedUnit[],
  mapSize: [number, number],
  footprint: [number, number]
): { x: number; y: number } | null {
  const anchor = units.filter(u => u.typeId !== 'influent_inlet' && u.typeId !== 'effluent_outfall')
    .reduce<PlacedUnit | null>((best, u) => (!best || u.gridX > best.gridX ? u : best), null);
  const startX = anchor ? anchor.gridX + UNIT_DEFINITIONS[anchor.typeId].footprint[0] : 4;
  const [mw, mh] = mapSize;

  const fits = (x: number, y: number) =>
    x >= 0 && y >= 0 && x + footprint[0] <= mw && y + footprint[1] <= mh &&
    !units.some(u => {
      const d = UNIT_DEFINITIONS[u.typeId];
      if (!d) return false;
      return x < u.gridX + d.footprint[0] && x + footprint[0] > u.gridX &&
             y < u.gridY + d.footprint[1] && y + footprint[1] > u.gridY;
    });

  for (let dx = 0; dx < mw; dx++) {
    for (let dy = 0; dy < mh; dy += 2) {
      const x = startX + dx;
      if (fits(x, Math.min(mh - footprint[1], Math.max(0, anchor ? anchor.gridY + dy : dy)))) return { x, y: Math.min(mh - footprint[1], Math.max(0, anchor ? anchor.gridY + dy : dy)) };
      if (dy > 0 && fits(x, Math.max(0, (anchor ? anchor.gridY : dy) - dy))) return { x, y: Math.max(0, (anchor ? anchor.gridY : dy) - dy) };
    }
  }
  return null;
}

interface SimCandidate {
  fix: FixAction;
  score: number;
}

/** Generates one param-adjustment candidate; returns null if out of bounds/no change. */
function makeParamCandidate(
  gs: GameState,
  unit: PlacedUnit,
  paramKey: string,
  delta: number,
  label: string,
  detail: string
): SimCandidate | null {
  const def = UNIT_DEFINITIONS[unit.typeId];
  const pd = def.paramDefinitions.find(pp => pp.key === paramKey);
  if (!pd) return null;
  const current = unit.customParams[paramKey] ?? pd.defaultValue;
  const next = Math.round(Math.min(pd.max, Math.max(pd.min, current + delta)) * 100) / 100;
  if (Math.abs(next - current) < 0.01) return null;

  const simmed = cloneUnitsForSim(gs.units).map(u => {
    if (u.instanceId !== unit.instanceId) return u;
    return { ...u, customParams: { ...u.customParams, [paramKey]: next } };
  });
  const newScore = violationScore(simulateEffluent(gs, simmed), gs.currentLevel.standards);

  // Running-cost estimate for power-linked parameters (aeration blowers)
  let costHint = '';
  if (unit.typeId === 'activated_sludge_cas') {
    const base = def.powerConsumptionKw;
    const dKw = base * 0.4 * ((next - current) / 2.0);
    costHint = ` +$${Math.max(0, Math.round(dKw * 24 * POWER_RATE))}/day power`;
  }

  return {
    score: newScore,
    fix: {
      kind: 'adjust_param',
      label: `${label}: ${current} → ${next}${costHint}`,
      detail,
      unitTypeId: unit.typeId,
      instanceId: unit.instanceId,
      paramKey,
      delta: next - current,
      affordable: true,
    },
  };
}

function bioUnits(gs: GameState): PlacedUnit[] {
  return gs.units.filter(u => u.typeId === 'activated_sludge_cas' || u.typeId === 'a2o_bardenpho');
}

function buildFix(gs: GameState, typeId: UnitTypeId, why: string): FixAction | null {
  const avail = gs.currentLevel.availableUnits.includes(typeId) || gs.gameMode === 'sandbox';
  if (!avail) return null;
  const def = UNIT_DEFINITIONS[typeId];
  const lockedByTech = gs.gameMode !== 'sandbox' && !!def.requiredTechId &&
    !gs.techTree.find(t => t.id === def.requiredTechId)?.unlocked;
  if (lockedByTech) return null;
  const spot = findFreeSpot(gs.units, gs.currentLevel.mapSize, def.footprint);
  if (!spot) return null;
  return {
    kind: 'build_unit',
    label: `Build ${def.name}`,
    detail: why,
    unitTypeId: typeId,
    affordable: gs.gameMode === 'sandbox' || gs.financials.cash >= def.capex,
  };
}

/**
 * Main entry: produce prioritized, test-backed advisories for the plant.
 */
export function generateAdvisories(gs: GameState): Advisory[] {
  const adv: Advisory[] = [];
  const std = gs.currentLevel.standards;
  const eff = gs.finalEffluent;
  const flowing = eff.flowRate > 10;

  if (!flowing) {
    adv.push({
      id: 'no_flow',
      severity: 'critical',
      title: 'No treated water is reaching the river',
      cause: 'Water only flows through pipes YOU lay. Open the Pipes tool, click a unit to pick its output port, then click the destination. Connection order matters — each unit expects a certain feed quality.',
      fixes: [{
        kind: 'auto_train',
        label: '⚡ Auto-connect main treatment train',
        detail: 'One click wires the main liquid line: Inlet → Screen → Grit → Primary → Bioreactor → Clarifier → UV → Outfall. Sludge, RAS & gas lines always stay manual.',
        affordable: true,
      }, {
        kind: 'start_piping',
        label: 'Open the Pipes tool',
        detail: 'Manual piping by port: source unit → pick port → destination → pick inlet.',
        affordable: true,
      }],
    });
    return adv;
  }

  // ── Piping-mistake detection: bad routing has real consequences ──────
  // RAS topology warning: a secondary clarifier configured for RAS must have
  // its sludge_outlet physically piped back to a bioreactor ras_inlet.
  {
    const bioIds = new Set(gs.units.filter(u => u.typeId === 'activated_sludge_cas' || u.typeId === 'a2o_bardenpho').map(u => u.instanceId));
    for (const u of gs.units) {
      if (u.typeId !== 'secondary_clarifier') continue;
      const hasRasReturn = gs.pipes.some(
        p => p.fromUnitId === u.instanceId && p.fromPortId === 'sludge_outlet' &&
             bioIds.has(p.toUnitId) && p.toPortId === 'ras_inlet'
      );
      const hasWasOut = gs.pipes.some(p => p.fromUnitId === u.instanceId && p.fromPortId === 'was_outlet');
      if (!hasRasReturn) {
        adv.push({
          id: `ras_disconnected_${u.instanceId}`,
          severity: 'warning',
          title: `Secondary clarifier RAS is not returning to a bioreactor`,
          cause:
            `${UNIT_DEFINITIONS[u.typeId].name} is configured for ${u.customParams.rasRecycleRatioPercent ?? 75}% RAS, ` +
            `but its "RAS Return" port is not piped back to any aeration basin's RAS inlet. Without the return loop, ` +
            `biomass leaves with the effluent and BOD removal will collapse. Open Pipes → click the clarifier → choose "RAS Return" → click the reactor.`,
          fixes: [{ kind: 'start_piping', label: 'Open the Pipes tool', detail: 'Pipe the clarifier\'s RAS Return port into the aeration basin\'s RAS inlet.', affordable: true }],
        });
      }
      if (!hasWasOut) {
        adv.push({
          id: `was_disconnected_${u.instanceId}`,
          severity: 'warning',
          title: `Waste Activated Sludge (WAS) has nowhere to go`,
          cause: `The clarifier purges WAS to control Sludge Age (SRT). Route its "WAS Waste Sludge" port to a sludge thickener so solids leave the liquid train in a controlled way.`,
          fixes: [{ kind: 'start_piping', label: 'Open the Pipes tool', detail: 'Pipe WAS Waste Sludge → Sludge Thickener inlet.', affordable: true }],
        });
      }
    }
  }

  for (const u of gs.units) {
    // Cleaning-due advisory fires regardless of current flow — fouling
    // persists whether or not the train is wet right now (migration slice 3).
    if (u.typeId === 'mbr_membrane' && u.mbrFouling?.cleaningDue) {
      const name = UNIT_DEFINITIONS[u.typeId].name;
      const mem = u.blueprint?.equipment as
        { materialId?: string; moduleCount?: number; areaPerModuleM2?: number } | undefined;
      const cipCost = membraneCipCostUsd(
        mem?.materialId ?? 'pvdf_hollow_fiber',
        (mem?.moduleCount ?? 9) * (mem?.areaPerModuleM2 ?? 850),
      );
      adv.push({
        id: `mbr_clean_due_${u.instanceId}`,
        severity: 'warning',
        title: `${name} resistance ${u.mbrFouling.resistanceMultiple.toFixed(2)}× clean — chemical clean due`,
        cause: `Filtration resistance passed the ${MBR_CLEANING_THRESHOLD}× cleaning threshold. TMP, permeate pumping power and opex all scale with it until a clean-in-place strips the foulant layer.`,
        fixes: [{
          kind: 'clean_mbr',
          label: gs.gameMode === 'sandbox'
            ? 'Run CIP clean (free)'
            : `Run CIP clean (~$${cipCost.toLocaleString()})`,
          detail: 'Hypochlorite + citric-acid soak of the cassettes: strips reversible fouling and resets the clean-day clock.',
          instanceId: u.instanceId,
          affordable: gs.gameMode === 'sandbox' || gs.financials.cash >= cipCost,
        }],
      });
    }
    // Replacement-due advisory (slice 4): end-of-life membranes cannot be
    // cleaned back to health — CIP no longer helps, only new cassettes do.
    if (u.typeId === 'mbr_membrane' && u.mbrFouling?.endOfLife) {
      const name = UNIT_DEFINITIONS[u.typeId].name;
      const mem = u.blueprint?.equipment as
        { materialId?: string; moduleCount?: number; areaPerModuleM2?: number } | undefined;
      const mat = MEMBRANE_MATERIALS[mem?.materialId ?? 'pvdf_hollow_fiber'];
      const replCost = membraneReplacementCostUsd(
        mem?.materialId ?? 'pvdf_hollow_fiber',
        (mem?.moduleCount ?? 9) * (mem?.areaPerModuleM2 ?? 850),
      );
      const ageYears = (u.mbrFouling.ageDays ?? 0) / 365.25;
      const byAge = ageYears >= mat.lifetimeYears;
      adv.push({
        id: `mbr_replacement_due_${u.instanceId}`,
        severity: 'critical',
        title: `${name} membranes are at end of life — replacement due`,
        cause: byAge
          ? `The ${mat.name} cassettes have served ${ageYears.toFixed(1)} yr of their rated ${mat.lifetimeYears} yr municipal life. Irreversible fouling is now structural (${u.mbrFouling.irreversibleMultiple.toFixed(2)}× clean) — another CIP will not recover design flux.`
          : `Irreversible fouling reached ${u.mbrFouling.irreversibleMultiple.toFixed(2)}× clean (limit ${MBR_EOL_IRREVERSIBLE}×). Heavy duty has aged the ${mat.name} cassettes past recovery at just ${ageYears.toFixed(1)} yr of a rated ${mat.lifetimeYears} yr life.`,
        fixes: [{
          kind: 'replace_mbr',
          label: gs.gameMode === 'sandbox'
            ? 'Replace membrane cassettes (free)'
            : `Replace membrane cassettes (~$${replCost.toLocaleString()})`,
          detail: 'Swaps every cassette for a new set of the same material: resistance, age and end-of-life flags reset to brand-new.',
          instanceId: u.instanceId,
          affordable: gs.gameMode === 'sandbox' || gs.financials.cash >= replCost,
        }],
      });
    }
    const inlet = u.lastInletQuality;
    if (!inlet || inlet.flowRate <= 1) continue;
    const name = UNIT_DEFINITIONS[u.typeId].name;

    if (u.typeId === 'uv_disinfection' && (inlet.tss > 40 || inlet.turbidity > 25)) {
      adv.push({
        id: `uv_shadow_${u.instanceId}`,
        severity: 'critical',
        title: `${name} is blinded by solids`,
        cause: `UV light cannot penetrate water this murky (TSS ${inlet.tss.toFixed(0)} mg/L, turbidity ${inlet.turbidity.toFixed(0)} NTU) — particles shadow pathogens from the lamp, so disinfection collapses. Route UV AFTER clarifiers/filters, not straight from raw sewage.`,
        fixes: [{ kind: 'start_piping', label: 'Re-route with the Pipes tool', detail: 'In the Pipes tool, reconnecting the same two units removes that pipe � then re-route in the correct order.', affordable: true }],
      });
    }
    if (u.typeId === 'reverse_osmosis' && (inlet.tss > 2 || inlet.turbidity > 3)) {
      adv.push({
        id: `ro_foul_${u.instanceId}`,
        severity: 'critical',
        title: `${name} membranes are fouling`,
        cause: `RO spirals demand feed water of near-zero solids (SDI < 3). Piping unfiltered water in scales and fouls the membranes — rejection drops and recovery tanks. Always pre-filter (sand filter/MBR) before RO.`,
        fixes: [{ kind: 'start_piping', label: 'Re-route with the Pipes tool', detail: 'Reconnect the same units to remove the bad pipe, then route through a sand filter first.', affordable: true }],
      });
    }
    if (u.typeId === 'mbr_membrane' && inlet.tss > 500) {
      adv.push({
        id: `mbr_foul_${u.instanceId}`,
        severity: 'critical',
        title: `${name} cassettes are clogging`,
        cause: `MBRs are designed for biological mixed liquor (~8,000-12,000 mg/L MLSS from its own bioreactor), but raw sludge or screenings at ${inlet.tss.toFixed(0)} mg/L blind the hollow fibers instantly. Feed it bioreactor liquor, not raw waste.`,
        fixes: [{ kind: 'start_piping', label: 'Re-route with the Pipes tool', detail: 'Remove the bad pipe (reconnect same units), then feed the MBR from a bioreactor outlet.', affordable: true }],
      });
    }
    if (u.typeId === 'pump_station' && inlet.tss > 350) {
      adv.push({
        id: `pump_clog_${u.instanceId}`,
        severity: 'warning',
        title: `${name} is at risk of clogging`,
        cause: `Unscreened sewage (TSS ${inlet.tss.toFixed(0)} mg/L) carries rags and debris that jam impellers — expect higher power draw and maintenance costs. Place a bar screen upstream of any pump.`,
        fixes: buildFix(gs, 'bar_screen', 'A mechanical bar screen catches rags before they reach the pump.') ? [buildFix(gs, 'bar_screen', 'A mechanical bar screen catches rags before they reach the pump.')!] : [],
      });
    }
    if (u.typeId === 'chlorination_basin' && inlet.nh4 > 10) {
      adv.push({
        id: `cl_demand_${u.instanceId}`,
        severity: 'warning',
        title: `${name} losing disinfection power`,
        cause: `Chlorine reacts with ammonia (${inlet.nh4.toFixed(1)} mg/L N) to form chloramines — that consumed dose can't kill pathogens (chlorine demand). Nitrify first in an aerated bioreactor, or raise the chlorine dose.`,
        fixes: [{ kind: 'adjust_param', label: 'Raise chlorine dose', detail: 'Compensates for chlorine demand, at a cost.', instanceId: u.instanceId, paramKey: 'chlorineDoseMgL', delta: +2, affordable: true }],
      });
    }
    if (u.typeId === 'sand_filter' && inlet.tss > 220) {
      adv.push({
        id: `sf_blind_${u.instanceId}`,
        severity: 'warning',
        title: `${name} bed is blinding fast`,
        cause: `A rapid sand filter is a POLISHING step — feeding it raw-level solids (${inlet.tss.toFixed(0)} mg/L) clogs the media within hours and forces constant backwashing. Put clarification upstream.`,
        fixes: [{ kind: 'start_piping', label: 'Re-route with the Pipes tool', detail: 'Remove the bad pipe, then route clarification upstream of the filter.', affordable: true }],
      });
    }
    if ((u.typeId === 'activated_sludge_cas' || u.typeId === 'a2o_bardenpho') && inlet.toxicIndex > 40) {
      const eqFix = buildFix(gs, 'equalization_basin', 'An equalization basin dampens toxic shock loads protecting your biomass.');
      adv.push({
        id: `bio_toxic_${u.instanceId}`,
        severity: 'critical',
        title: `${name} biomass is dying off`,
        cause: `Toxic industrial load (index ${inlet.toxicIndex.toFixed(0)}) kills the aerobic bacteria — biology needs equalization or chemical/oxidative pretreatment upstream, otherwise BOD removal crashes.`,
        fixes: eqFix ? [eqFix] : [],
      });
    }
  }

  const violations = collectViolations(eff, std);
  const bios = bioUnits(gs);
  const hasType = (t: UnitTypeId) => gs.units.some(u => u.typeId === t);

  // ── Per-parameter advisory construction ──────────────────────────────
  for (const v of violations) {
    const candidates: (SimCandidate | null)[] = [];
    const buildSugs: (() => FixAction | null)[] = [];

    switch (v.key) {
      case 'bod':
      case 'cod': {
        if (bios.length === 0) {
          buildSugs.push(() => buildFix(gs, 'activated_sludge_cas',
            'A biological aeration basin is where bacteria digest dissolved organic pollution (BOD/COD). This is the heart of every plant.'));
          break;
        }
        for (const b of bios) {
          const k = b.typeId === 'activated_sludge_cas' ? 'doSetpoint' : 'aerobicDo';
          candidates.push(makeParamCandidate(gs, b, k, +0.5, 'Increase aeration oxygen', 'Higher dissolved oxygen lets bacteria consume more organic matter.'));
          candidates.push(makeParamCandidate(gs, b, k, +1.0, 'Increase aeration oxygen', 'Higher dissolved oxygen lets bacteria consume more organic matter.'));
        }
        if (v.key === 'cod' && !hasType('sand_filter')) {
          buildSugs.push(() => buildFix(gs, 'sand_filter',
            'Remaining COD is fine particulate floc — a polishing sand filter captures it.'));
        }
        if (v.key === 'cod' && !hasType('advanced_oxidation_aop')) {
          buildSugs.push(() => buildFix(gs, 'advanced_oxidation_aop',
            'Ozone chemically destroys stubborn non-biodegradable COD.'));
        }
        if (v.key === 'cod' && !hasType('secondary_clarifier') && bios.length > 0) {
          buildSugs.push(() => buildFix(gs, 'secondary_clarifier',
            'A final clarifier settles out biomass and particle-bound COD before discharge.'));
        }
        break;
      }
      case 'tss': {
        if (!hasType('secondary_clarifier') && bios.length > 0) {
          buildSugs.push(() => buildFix(gs, 'secondary_clarifier',
            'Suspended solids are settled out gravitationally in a clarifier.'));
        } else if (!hasType('sand_filter')) {
          buildSugs.push(() => buildFix(gs, 'sand_filter',
            'A rapid sand filter polishes remaining fine suspended solids.'));
        }
        break;
      }
      case 'nh4':
      case 'tn': {
        if (bios.length === 0) {
          buildSugs.push(() => buildFix(gs, 'activated_sludge_cas',
            'Nitrifying bacteria need an aerated biological reactor to convert ammonia.'));
          break;
        }
        for (const b of bios) {
          const k = b.typeId === 'activated_sludge_cas' ? 'doSetpoint' : 'aerobicDo';
          candidates.push(makeParamCandidate(gs, b, k, +0.5, 'Increase aeration oxygen', 'Nitrifying bacteria are strict aerobes — they demand ample oxygen.'));
        }
        if (hasType('a2o_bardenpho')) {
          const a2o = gs.units.find(u => u.typeId === 'a2o_bardenpho')!;
          candidates.push(makeParamCandidate(gs, a2o, 'internalRecyclePercent', +50, 'Boost internal recycle', 'Pumps more nitrate-rich liquor back to the anoxic zone for denitrification.'));
          candidates.push(makeParamCandidate(gs, a2o, 'carbonDosingRateMgL', +10, 'Add carbon source', 'Methanol feeds denitrifying bacteria so they can convert nitrate to N₂ gas.'));
        } else {
          buildSugs.push(() => buildFix(gs, 'a2o_bardenpho',
            'Nitrogen removal needs an anoxic zone — the A2O reactor recycles nitrate back where bacteria breathe it to N₂ gas.'));
        }
        break;
      }
      case 'tp': {
        if (hasType('chemical_phosphorus')) {
          const cp = gs.units.find(u => u.typeId === 'chemical_phosphorus')!;
          candidates.push(makeParamCandidate(gs, cp, 'coagulantDoseMgL', +6, 'Increase coagulant dose', 'More FeCl₃/alum precipitates phosphorus as removable solid.'));
        } else {
          buildSugs.push(() => buildFix(gs, 'chemical_phosphorus',
            'Dosing iron or aluminium salts chemically precipitates phosphorus out of the water.'));
        }
        if (hasType('a2o_bardenpho')) {
          const a2o = gs.units.find(u => u.typeId === 'a2o_bardenpho')!;
          candidates.push(makeParamCandidate(gs, a2o, 'carbonDosingRateMgL', +10, 'Feed EBPR carbon', 'Extra carbon fuels phosphorus-accumulating organisms in the anaerobic zone.'));
        }
        break;
      }
      case 'pathogens': {
        if (hasType('uv_disinfection')) {
          const uv = gs.units.find(u => u.typeId === 'uv_disinfection')!;
          candidates.push(makeParamCandidate(gs, uv, 'uvFluenceMJCm2', +10, 'Raise UV dose', 'Stronger UV radiation destroys more pathogen DNA — needs clear water to penetrate.'));
        }
        if (hasType('chlorination_basin')) {
          const cb = gs.units.find(u => u.typeId === 'chlorination_basin')!;
          candidates.push(makeParamCandidate(gs, cb, 'chlorineDoseMgL', +2, 'Increase chlorine dose', 'Longer, stronger chlorine contact inactivates pathogens.'));
        }
        if (!hasType('uv_disinfection') && !hasType('chlorination_basin')) {
          buildSugs.push(() => buildFix(gs, 'uv_disinfection',
            'UV lamps deliver a lethal dose of ultraviolet light to bacteria and viruses without chemicals.'));
        } else if (eff.turbidity > 8) {
          buildSugs.push(() => buildFix(gs, 'sand_filter',
            'Cloudy water shields pathogens from UV light — clarify first with filtration.'));
        }
        break;
      }
      case 'do': {
        for (const b of bios) {
          const k = b.typeId === 'activated_sludge_cas' ? 'doSetpoint' : 'aerobicDo';
          candidates.push(makeParamCandidate(gs, b, k, +0.5, 'Increase aeration oxygen', 'The discharged water carries the oxygen setpoint of your reactors.'));
        }
        break;
      }
      default:
        break;
    }

    // Rank simulated candidates by actual predicted outcome
    const baseline = violationScore(eff, std);
    const working = candidates
      .filter((c): c is NonNullable<SimCandidate> => c !== null)
      .map(c => ({ ...c, gain: baseline - c.score }))
      .filter(c => c.gain > 0.005)
      .sort((a, b) => b.gain - a.gain)
      .slice(0, 3);

    const fixes: FixAction[] = working.map(w => ({
      ...w.fix,
      prediction: describePrediction(gs, w.fix),
    }));

    for (const sug of buildSugs) {
      const f = sug();
      if (f && !fixes.some(x => x.kind === 'build_unit' && x.unitTypeId === f.unitTypeId)) {
        fixes.push(f);
      }
    }

    if (fixes.length > 0 || v.ratio > 1) {
      adv.push({
        id: v.key,
        severity: v.ratio > 2 ? 'critical' : 'warning',
        title: `${v.label} above limit — ${v.value.toFixed(v.limit < 10 ? 2 : 0)} vs allowed ${v.limit}`,
        cause: CAUSES[v.key] ?? '',
        fixes,
      });
    }
  }

  return adv;
}

function describePrediction(gs: GameState, fix: FixAction): string {
  if (fix.kind !== 'adjust_param' || !fix.instanceId || !fix.paramKey) return '';
  const unit = gs.units.find(u => u.instanceId === fix.instanceId);
  if (!unit) return '';
  const def = UNIT_DEFINITIONS[unit.typeId];
  const pd = def.paramDefinitions.find(p => p.key === fix.paramKey);
  if (!pd) return '';
  const cur = unit.customParams[fix.paramKey] ?? pd.defaultValue;
  const next = Math.min(pd.max, Math.max(pd.min, cur + (fix.delta ?? 0)));
  const paramKey: string = fix.paramKey;
  const simmed = cloneUnitsForSim(gs.units).map(u =>
    u.instanceId === unit.instanceId ? { ...u, customParams: { ...u.customParams, [paramKey]: next } } : u
  );
  const after = simulateEffluent(gs, simmed);
  const std = gs.currentLevel.standards;
  const parts: string[] = [];
  for (const viol of collectViolations(gs.finalEffluent, std)) {
    // ph_low/ph_high both read the `ph` field; keys map via PERMIT_FIELD.
    const field = PERMIT_FIELD[viol.key as PermitCriterionKey] ?? (viol.key as keyof WaterQuality);
    const nv = collectViolations(after, std).find(x => x.key === viol.key);
    const newVal = nv ? nv.value : (after as unknown as Record<string, number>)[field];
    const dec = viol.limit < 10 ? 2 : 0;
    parts.push(`${viol.label} ${viol.value.toFixed(dec)}→${Number(newVal).toFixed(dec)}${nv ? ' ✗' : ' ✓'}`);
  }
  return parts.join('  ');
}

const CAUSES: Record<string, string> = {
  bod: 'BOD is organic food for microbes. Your bacteria are not getting enough time or oxygen to finish digesting it.',
  cod: 'COD tracks all organic chemistry. Soluble parts need biology; fine particulates need settling or filtration.',
  tss: 'Suspended solids are physical particles. They must be settled in clarifiers or strained through media filters.',
  tn: 'Total nitrogen leaves as ammonia or nitrate. Converting it to gas requires an oxygen-free (anoxic) zone.',
  nh4: 'Ammonia conversion (nitrification) is done by slow-growing aerobic bacteria — they need generous oxygen.',
  tp: 'Phosphorus must be captured chemically or stored biologically by special bacteria, then removed with the sludge.',
  pathogens: 'Pathogens are killed by UV light or chlorine — but cloudy water shields them, so clarity comes first.',
  do: 'Healthy rivers need oxygen. Deeply polluted water arrives starved of oxygen; aeration restores it before discharge.',
  ph_low: 'Discharge pH is below the legal floor. Excessively acidic water corrodes pipes and harms river life.',
  ph_high: 'Discharge pH is above the legal ceiling. Over-alkaline water also stresses aquatic ecosystems.',
  turbidity: 'Turbidity measures how cloudy the discharge is — fine particles that block light and carry stuck-on pollutants.',
};
