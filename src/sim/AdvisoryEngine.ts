import { GameState } from '../gameplay/GameManager';
import { SimulationEngine } from './SimulationEngine';
import { UNIT_DEFINITIONS } from './UnitProcessModels';
import { PlacedUnit, TreatmentStandard, UnitTypeId, WaterQuality } from '../types/simulation';

/**
 * Compliance Doctor — turns raw effluent numbers into an actionable,
 * ranked repair plan. Every parameter-tweak candidate is evaluated against
 * the real process simulator before being offered, so the advice is honest:
 * players see the predicted outcome ("BOD 39 → 17 mg/L") of each action.
 */

export interface FixAction {
  kind: 'adjust_param' | 'build_unit' | 'auto_pipe';
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

export function collectViolations(eff: WaterQuality, std: TreatmentStandard): Violation[] {
  const v: Violation[] = [];
  const push = (key: string, label: string, value: number, limit: number, min: boolean = false) => {
    const ok = min ? value >= limit : value <= limit;
    if (!ok && limit >= 0) {
      v.push({ key, label, value, limit, ratio: Math.max(1.01, min ? limit / Math.max(0.01, value) : value / Math.max(0.001, limit)) });
    }
  };
  push('bod', 'BOD', eff.bod, std.maxBod);
  push('cod', 'COD', eff.cod, std.maxCod);
  push('tss', 'TSS', eff.tss, std.maxTss);
  push('tn', 'Total Nitrogen', eff.tn, std.maxTn);
  push('nh4', 'Ammonia', eff.nh4, std.maxNh4);
  push('tp', 'Phosphorus', eff.tp, std.maxTp);
  push('pathogens', 'Pathogens', eff.pathogens, Math.max(1, std.maxPathogens));
  push('do', 'Dissolved Oxygen', eff.do, std.minDo, true);
  return v.sort((a, b) => b.ratio - a.ratio);
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
      cause: 'Your units are not connected with pipes yet. Water only flows through piped connections.',
      fixes: [{
        kind: 'auto_pipe',
        label: 'Auto-connect all pipes',
        detail: 'Links every placed unit into one treatment line automatically.',
        affordable: true,
      }],
    });
    return adv;
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
    const nv = collectViolations(after, std).find(x => x.key === viol.key);
    const newVal = nv ? nv.value : (after as unknown as Record<string, number>)[viol.key];
    parts.push(`${viol.label} ${viol.value.toFixed(viol.limit < 10 ? 2 : 0)}→${Number(newVal).toFixed(viol.limit < 10 ? 2 : 0)}${nv ? ' ✗' : ' ✓'}`);
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
};
