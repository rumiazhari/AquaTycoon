/**
 * UnitDesigner — the structured engineering interface (Prompt §AC/AD).
 *
 * For engineerable units it replaces the one-dimensional inspector sliders with
 * five tabs:
 *   DESIGN        geometry + construction + equipment + rated capacity + CAPEX
 *   OPERATE       setpoints / pump speed / RAS / WAS / membrane ops
 *   DIAGNOSTICS   HRT, SRT, F/M, SOR, SLR, DO, MLSS, OUR, headloss, duty point
 *   ECONOMICS     quantity-based CAPEX + mechanistic OPEX specifics
 *   MAINTENANCE   condition, runtime, next service, failure risk, actions
 *
 * A "Show Calculation" panel (§AD) renders the substituted equation so the
 * numbers are defensible, not unexplained ratings.
 */

import React, { useMemo, useState } from 'react';
import { X, Ruler, Sliders, Activity, DollarSign, Wrench, Calculator } from 'lucide-react';
import { PlacedUnit } from '../types/simulation';
import type { CommissioningState } from '../design/UnitBlueprint';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { SoundManager } from '../audio/SoundManager';
import {
  BasinGeometry,
  workingVolumeM3,
  planAreaM2,
  civilQuantities,
} from '../design/Geometry';
import {
  CONCRETE_MATERIALS_LIST,
  CONSTRUCTION_MATERIALS,
  BLOWER_MODELS,
  DIFFUSER_MODELS,
  REDUNDANCY_CONFIGS,
} from '../design/catalogs/Equipment';
import { PEAK_FLOW_FACTOR } from '../design/PeakFlow';
import {
  estimateStructureCAPEX,
  estimateBlowerCAPEX,
  estimateSeedSludgeCAPEX,
} from '../design/CostEstimator';
import { validateUnitDesign } from '../design/DesignValidator';
import { EQ_MIN_POOL_FRACTION } from '../sim/processes/Equalization';
import {
  casDesignPoint,
} from '../sim/processes/ActivatedSludge';
import { evaluateClarifierLoad } from '../sim/processes/Clarifier';

export interface UnitDesignerProps {
  unit: PlacedUnit;
  onClose: () => void;
  onUpdateBlueprint: (unitId: string, next: PlacedUnit['blueprint']) => void;
  /** Writes the placed unit's runtime commissioning state (seed-sludge choice). */
  onUpdateCommissioning?: (unitId: string, next: CommissioningState) => void;
  /** Player cash for affordability gating of the seed-sludge haul-in purchase. */
  playerCash?: number;
}

type Tab = 'design' | 'operate' | 'diagnostics' | 'economics' | 'maintenance';

const fmt = (v: number | undefined, d = 1) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
const money = (v: number) => `$${Math.round(v).toLocaleString()}`;

export const UnitDesigner: React.FC<UnitDesignerProps> = ({ unit, onClose, onUpdateBlueprint, onUpdateCommissioning, playerCash }) => {
  const def = UNIT_DEFINITIONS[unit.typeId];
  if (!def || !unit.blueprint) {
    return (
      <Shell onClose={onClose} title={`${def?.name ?? 'Unit'}`}>
        <p className="text-xs text-slate-400 font-mono">This unit type uses fixed factory parameters. The engineering designer applies to customizable process units (aeration basins, clarifiers, equalization, pump stations).</p>
      </Shell>
    );
  }

  const [tab, setTab] = useState<Tab>('design');
  const [bp, setBp] = useState(unit.blueprint);
  const bpRef = React.useRef(bp);
  bpRef.current = bp;

  // Seed-sludge choice (backlog #2): lives on the placed unit's RUNTIME
  // commissioning state — NOT the blueprint (GameManager seeds by default at
  // placement; unchecking here re-routes the unit onto the natural-growth
  // commissioning ramp consumed by stepCasRuntime).
  const seededWithSludge = unit.commissioning?.seededWithSludge ?? true;
  const toggleSeeded = (checked: boolean) => {
    const next: CommissioningState = {
      phase: unit.commissioning?.phase ?? 'empty',
      daysInPhase: unit.commissioning?.daysInPhase ?? 0,
      seededWithSludge: checked,
    };
    onUpdateCommissioning?.(unit.instanceId, next);
  };

  const commit = (next: typeof bp) => {
    setBp(next);
    onUpdateBlueprint(unit.instanceId, next);
  };

  const geo = bp.design.geometry;
  const issues = useMemo(() => validateUnitDesign({ ...unit, blueprint: bp }), [unit, bp]);

  return (
    <Shell onClose={onClose} title={def.name}>
      {/* Tabs */}
      <div className="flex gap-1 mb-3 flex-wrap">
        {(['design', 'operate', 'diagnostics', 'economics', 'maintenance'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => { SoundManager.playClick(); setTab(t); }}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wide border transition ${
              tab === t ? 'bg-teal-500/20 border-teal-400/60 text-teal-200' : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-slate-200'
            }`}
          >
            {t === 'design' && <><Ruler size={11} className="inline mr-1" />Design</>}
            {t === 'operate' && <><Sliders size={11} className="inline mr-1" />Operate</>}
            {t === 'diagnostics' && <><Activity size={11} className="inline mr-1" />Diag</>}
            {t === 'economics' && <><DollarSign size={11} className="inline mr-1" />Econ</>}
            {t === 'maintenance' && <><Wrench size={11} className="inline mr-1" />Maint</>}
          </button>
        ))}
      </div>

      {/* Seed sludge toggle: controls whether the unit runs with seeded biomass
          (immediate near-design performance) or unseeded (commissioning ramp to
          stable). Real economics (backlog #1): the contractor's original seeding
          at placement was bundled into construction CAPEX; every LATER
          unseeded→seeded transition buys a fresh tanker of seed sludge — the
          one-time haul-in charge is enforced by GameManager.setUnitCommissioning. */}
      {unit.typeId === 'activated_sludge_cas' && (() => {
        const seedCost = estimateSeedSludgeCAPEX(unit.volume);
        const canAffordSeed = playerCash === undefined || playerCash >= seedCost;
        return (
          <div className="flex items-center gap-2 mb-3 text-[10px] font-mono">
            <input
              type="checkbox"
              checked={seededWithSludge}
              disabled={!seededWithSludge && !canAffordSeed}
              onChange={e => toggleSeeded(e.target.checked)}
              className="bg-slate-800 border border-slate-700 rounded w-4 h-4 text-teal-400 focus-visible:outline focus-visible:ring-2 disabled:opacity-40"
            />
            <span>
              {seededWithSludge
                ? 'Seed sludge: imported biomass — near-design performance immediately · unchecking spends the culture (no refund)'
                : `Unseeded: ~3-week commissioning ramp at reduced performance · seed now for a ${money(seedCost)} one-time haul-in${canAffordSeed ? '' : ' (insufficient funds)'}`}
            </span>
          </div>
        );
      })()}

      {/* Issue banner */}
      {issues.length > 0 && (
        <div className="flex flex-col gap-1 mb-3">
          {issues.map((iss, i) => (
            <div key={i} className={`text-[10px] font-mono px-2 py-1 rounded border ${
              iss.severity === 'critical' ? 'bg-red-950/40 border-red-600/50 text-red-300'
                : iss.severity === 'warning' ? 'bg-amber-950/30 border-amber-600/40 text-amber-200'
                : 'bg-slate-800/60 border-slate-700 text-slate-300'
            }`}>
              <b className="uppercase">{iss.code}</b>: {iss.message}
              {iss.detail && <div className="opacity-80 mt-0.5">{iss.detail}</div>}
            </div>
          ))}
        </div>
      )}

      {tab === 'design' && <DesignTab bp={bp} onChange={commit} geo={geo} />}
      {tab === 'operate' && <OperateTab bp={bp} onChange={commit} />}
      {tab === 'diagnostics' && <DiagnosticsTab unit={unit} bp={bp} />}
      {tab === 'economics' && <EconomicsTab bp={bp} />}
      {tab === 'maintenance' && <MaintenanceTab unit={unit} />}
    </Shell>
  );
};

// ── Tab content ──────────────────────────────────────────────────────────────

function DesignTab({ bp, geo, onChange }: {
  bp: PlacedUnit['blueprint'];
  geo: BasinGeometry;
  onChange: (b: NonNullable<PlacedUnit['blueprint']>) => void;
}) {
  const setGeo = (patch: Partial<BasinGeometry>) =>
    onChange({ ...bp!, design: { ...bp!.design, geometry: { ...geo, ...patch } as BasinGeometry } });
  const isRect = geo.shape === 'rect';
  const V = workingVolumeM3(geo);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Shape">
          <select
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 w-full"
            value={geo.shape}
            onChange={e => {
              const shape = e.target.value as 'rect' | 'circular';
              const g = shape === 'circular'
                ? { shape, diameterM: isRect ? (geo as any).lengthM : 14, sideWaterDepthM: (geo as any).waterDepthM ?? 3.5, freeboardM: geo.freeboardM, wallThicknessM: geo.wallThicknessM, floorThicknessM: geo.floorThicknessM, numberOfParallelTrains: geo.numberOfParallelTrains }
                : { shape, lengthM: (geo as any).diameterM ?? 30, widthM: 10, waterDepthM: (geo as any).sideWaterDepthM ?? 4.5, freeboardM: geo.freeboardM, wallThicknessM: geo.wallThicknessM, floorThicknessM: geo.floorThicknessM, numberOfParallelTrains: geo.numberOfParallelTrains };
              onChange({ ...bp!, design: { ...bp!.design, geometry: g as BasinGeometry } });
            }}
          >
            <option value="rect">Rectangular</option>
            <option value="circular">Circular</option>
          </select>
        </Field>
        <Field label="Parallel trains">
          <NumberInput value={geo.numberOfParallelTrains} min={1} max={6} step={1}
            onChange={v => setGeo({ numberOfParallelTrains: Math.round(v) })} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {isRect ? (
          <>
            <Field label="Length (m)"><NumberInput value={geo.lengthM} min={4} max={120} step={1} onChange={v => setGeo({ lengthM: v })} /></Field>
            <Field label="Width (m)"><NumberInput value={geo.widthM} min={3} max={60} step={1} onChange={v => setGeo({ widthM: v })} /></Field>
          </>
        ) : (
          <Field label="Diameter (m)"><NumberInput value={geo.diameterM} min={4} max={60} step={1} onChange={v => setGeo({ diameterM: v })} /></Field>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={isRect ? 'Water depth (m)' : 'Side water depth (m)'}>
          <NumberInput value={isRect ? geo.waterDepthM : geo.sideWaterDepthM} min={2} max={8} step={0.25}
            onChange={v => setGeo(isRect ? { waterDepthM: v } : { sideWaterDepthM: v })} />
        </Field>
        <Field label="Freeboard (m)"><NumberInput value={geo.freeboardM} min={0.2} max={1.5} step={0.1} onChange={v => setGeo({ freeboardM: v })} /></Field>
      </div>

      <Field label="Construction material">
        <select className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 w-full"
          value={bp!.design.materialId} onChange={e => onChange({ ...bp!, design: { ...bp!.design, materialId: e.target.value } })}>
          {CONCRETE_MATERIALS_LIST.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </Field>

      {bp!.processType === 'activated_sludge_cas' && (
        <CASDesignEquipment bp={bp!} onChange={onChange} />
      )}

      <div className="text-[11px] font-mono text-slate-300 bg-slate-900/60 rounded-lg p-2 flex justify-between">
        <span>Working volume</span>
        <span className="text-cyan-300">{fmt(V, 0)} m³ ({V * 264 === 0 ? 0 : (V * 0.000264).toFixed(1)} Mgal)</span>
      </div>

      <CalcBlock title="Working Volume"
        eq="V = A_plan × D × n"
        sub={`A = ${fmt(planAreaM2(geo), 0)} m², D = ${fmt(isRect ? geo.waterDepthM : geo.sideWaterDepthM, 2)} m, n = ${geo.numberOfParallelTrains}`}
        result={`${fmt(V, 0)} m³`} note="Total liquid volume across all parallel trains — drives HRT and biomass inventory." />
    </div>
  );
}

function CASDesignEquipment({ bp, onChange }: {
  bp: NonNullable<PlacedUnit['blueprint']>;
  onChange: (b: NonNullable<PlacedUnit['blueprint']>) => void;
}) {
  const eq = bp.equipment as any;
  const setEq = (patch: Record<string, unknown>) =>
    onChange({ ...bp, equipment: { ...(bp.equipment as object), ...patch } as any });
  return (
    <div className="flex flex-col gap-2 border-t border-slate-800 pt-2">
      <h4 className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Aeration Equipment</h4>
      <Field label="Diffuser type">
        <select className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 w-full"
          value={eq.diffuserModelId} onChange={e => setEq({ diffuserModelId: e.target.value })}>
          {Object.values(DIFFUSER_MODELS).map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      </Field>
      <Field label="Diffuser count"><NumberInput value={eq.diffuserCount} min={4} max={2000} step={4} onChange={v => setEq({ diffuserCount: Math.round(v) })} /></Field>
      <Field label="Blower model">
        <select className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 w-full"
          value={eq.blowerModelId} onChange={e => setEq({ blowerModelId: e.target.value })}>
          {Object.values(BLOWER_MODELS).map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
      </Field>
      <Field label="Redundancy">
        <select className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 w-full"
          value={eq.blowerRedundancyId} onChange={e => setEq({ blowerRedundancyId: e.target.value })}>
          {Object.values(REDUNDANCY_CONFIGS).map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Design MLSS (mg/L)"><NumberInput value={eq.designMlssMgL} min={1500} max={6000} step={50} onChange={v => setEq({ designMlssMgL: v })} /></Field>
        <Field label="Target SRT (d)"><NumberInput value={eq.targetSRTDays} min={3} max={30} step={1} onChange={v => setEq({ targetSRTDays: v })} /></Field>
      </div>
    </div>
  );
}

function OperateTab({ bp, onChange }: {
  bp: PlacedUnit['blueprint'];
  onChange: (b: NonNullable<PlacedUnit['blueprint']>) => void;
}) {
  const c = bp!.controls;
  const setC = (patch: Record<string, number>) =>
    onChange({ ...bp!, controls: { ...c, ...patch } });
  return (
    <div className="flex flex-col gap-2">
      {bp!.processType === 'activated_sludge_cas' && (
        <>
          <Field label="DO setpoint (mg/L)"><NumberInput value={c.doSetpointMgL ?? 2} min={0.5} max={5} step={0.1} onChange={v => setC({ doSetpointMgL: v })} /></Field>
          <Field label="WAS rate (m³/d)"><NumberInput value={c.wasRateM3d ?? 60} min={0} max={2000} step={5} onChange={v => setC({ wasRateM3d: v })} /></Field>
          <Field label="RAS recycle (%)"><NumberInput value={c.rasRecyclePercent ?? 75} min={0} max={150} step={5} onChange={v => setC({ rasRecyclePercent: v })} /></Field>
        </>
      )}
      {bp!.processType === 'equalization_basin' && (
        <Field label="Outflow target (m³/h)"><NumberInput value={c.eqOutflowTargetM3h ?? 160} min={0} max={2000} step={10} onChange={v => setC({ eqOutflowTargetM3h: v })} /></Field>
      )}
      {bp!.processType === 'pump_station' && (
        <Field label="Pump speed command (%)"><NumberInput value={(c.pumpSpeedCommand ?? 1) * 100} min={0} max={100} step={5} onChange={v => setC({ pumpSpeedCommand: v / 100 })} /></Field>
      )}
      <p className="text-[10px] text-slate-500 font-mono">Controls do not instantly change physics — the simulator advances toward them over simulation time (see DIAGNOSTICS for the actual state).</p>
    </div>
  );
}

function DiagnosticsTab({ unit, bp }: { unit: PlacedUnit; bp: PlacedUnit['blueprint'] }) {
  const geo = bp!.design.geometry;
  const isCAS = bp!.processType === 'activated_sludge_cas';

  const cas = isCAS
    ? casDesignPoint(unit, unit.lastInletQuality?.bod ?? 250, unit.lastInletQuality?.nh4 ?? 30, unit.lastInletQuality?.flowRate || 5000)
    : null;

  const qForward = unit.lastInletQuality?.flowRate ?? 5000;
  const clar = bp!.processType === 'secondary_clarifier'
    ? evaluateClarifierLoad(geo, qForward, unit.mlssActual ?? 3200, qForward * 1.75, (unit.sludgeBlanketHeightPercent ?? 25) / 100)
    : null;

  const eqSt = bp!.processType === 'equalization_basin' ? unit.eqStorage : undefined;
  const eqCapM3 = workingVolumeM3(geo);
  const eqLevel = eqSt ? eqSt.storedVolumeM3 / Math.max(1, eqCapM3) : 0;

  return (
    <div className="flex flex-col gap-2 text-[11px] font-mono">
      <Row k="Working volume" v={`${fmt(workingVolumeM3(geo), 0)} m³`} />
      <Row k="Plan area" v={`${fmt(planAreaM2(geo), 0)} m²`} />
      {geo.shape === 'rect' ? (
        <CalcBlock title="Working Volume"
          eq="V = L × W × h_water × n_trains"
          sub={`${fmt(geo.lengthM, 1)} × ${fmt(geo.widthM, 1)} × ${fmt(geo.waterDepthM, 1)} m × ${Math.max(1, geo.numberOfParallelTrains)} train(s)`}
          result={`${fmt(workingVolumeM3(geo), 0)} m³`} />
      ) : (
        <CalcBlock title="Working Volume"
          eq="V = π·D²/4 × hSWD × n_trains"
          sub={`π·${fmt(geo.diameterM, 1)}²/4 × ${fmt(geo.sideWaterDepthM, 1)} m × ${Math.max(1, geo.numberOfParallelTrains)} train(s)`}
          result={`${fmt(workingVolumeM3(geo), 0)} m³`} />
      )}
      {cas && (
        <>
          <Divider />
          <Row k="HRT @ design flow" v={`${fmt(cas.hrtHoursAtDesignFlow, 1)} h`} />
          <Row k="F/M" v={`${fmt(cas.fmRatioDay, 3)} d⁻¹`} />
          <CalcBlock title="Hydraulic Retention Time"
            eq="HRT = 24·V / Q_design"
            sub={`24 × ${fmt(cas.volumeM3, 0)} m³ / ${fmt(qForward, 0)} m³/d`}
            result={`${fmt(cas.hrtHoursAtDesignFlow, 1)} h`} />
          <CalcBlock title="Food-to-Microorganism Ratio"
            eq="F/M = Q·S₀ / (V · X_MLSS)"
            sub={`(${fmt(qForward, 0)} m³/d × ${fmt(unit.lastInletQuality?.bod ?? 250, 0)} mg/L) ÷ (${fmt(cas.volumeM3, 0)} m³ × ${fmt((bp!.equipment as { designMlssMgL?: number }).designMlssMgL ?? 3200, 0)} mg/L)`}
            result={`${fmt(cas.fmRatioDay, 3)} d⁻¹`} />
          <Row k="O₂ demand" v={`${fmt(cas.netDemandKgDay, 0)} kg O₂/d`} />
          <Row k="O₂ capacity (field)" v={`${fmt(cas.fieldTransferCapacityKgDay, 0)} kg O₂/d`} />
          <Row k="Capacity margin" v={`${fmt(cas.capacityMarginRatio * 100, 0)} %`} good={cas.capacityMarginRatio >= 1} bad={cas.capacityMarginRatio < 1} />
          <CalcBlock title="Oxygen Demand (simplified)"
            eq="O₂ ≈ Q·ΔS/0.68 + 4.57·N_nit − 2.86·N_denit"
            sub={`Q·ΔS/0.68 ≈ ${fmt(cas.oxygenDemandKgDay, 0)}; nitrif ${fmt(cas.nitrificationDemandKgDay, 0)}; denit −${fmt(cas.denitrificationCreditKgDay, 0)}`}
            result={`${fmt(cas.netDemandKgDay, 0)} kg O₂/d`} />
          <Divider />
          <Row k="Actual DO (live)" v={`${fmt(unit.dissolvedOxygenActual, 2)} mg/L`} good={(unit.dissolvedOxygenActual ?? 0) > 1} bad={(unit.dissolvedOxygenActual ?? 0) < 0.5} />
          <Row k="Actual MLSS (live)" v={`${fmt(unit.mlssActual, 0)} mg/L`} />
          <Row k="SRT (derived)" v={`${fmt(unit.srtDays, 1)} d`} good={(unit.srtDays ?? 0) >= 8} bad={(unit.srtDays ?? 0) > 0 && (unit.srtDays ?? 0) < 5} />
          <Row k="Commissioning" v={unit.commissioning?.phase ?? 'n/a'} />
        </>
      )}
      {clar && (
        <>
          <Divider />
          <Row k="Surface overflow rate" v={`${fmt(clar.sorM3M2Day, 1)} m/d`} good={clar.sorM3M2Day < 24} bad={clar.sorM3M2Day > 33} />
          <Row k="Solids loading" v={`${fmt(clar.slrKgM2Day, 2)} kg/m²·d`} bad={clar.slrKgM2Day > 144} />
          <CalcBlock title="Surface Overflow Rate"
            eq="SOR = Q_forward / A_plan"
            sub={`${fmt(qForward, 0)} m³/d ÷ ${fmt(clar.planAreaM2, 0)} m²`}
            result={`${fmt(clar.sorM3M2Day, 1)} m/d`}
            note="Overload thresholds: caution >24 m/d, washout >33 m/d (Metcalf & Eddy)." />
          <CalcBlock title="Peak-Diurnal SOR"
            eq={`SOR_peak = SOR × ${fmt(PEAK_FLOW_FACTOR, 3)} (shared peak basis)`}
            sub={`${fmt(clar.sorM3M2Day, 1)} m/d × ${fmt(PEAK_FLOW_FACTOR, 3)}`}
            result={`${fmt(clar.peakSorM3M2Day, 1)} m/d`} />
          <CalcBlock title="Solids Loading Rate"
            eq="SLR = Q_total · X_MLSS / (1000·A)"
            sub={`(${fmt(qForward * 1.75, 0)} m³/d feed × ${fmt(unit.mlssActual ?? 3200, 0)} mg/L) ÷ (1000 × ${fmt(clar.planAreaM2, 0)} m²)`}
            result={`${fmt(clar.slrKgM2Day, 1)} kg/m²·d`}
            note="Feed = forward flow + RAS recycle; overload ≈144 kg/m²·d (=6 kg/m²·h)." />
          <Row k="Blanket level" v={`${fmt(clar.blanketLevelFraction * 100, 0)} %`} bad={clar.blanketLevelFraction > 0.7} />
          <Row k="Escape TSS" v={`${fmt(clar.escapeTssMgL, 0)} mg/L`} bad={clar.escapeTssMgL > 20} />
        </>
      )}
      {bp!.processType === 'equalization_basin' && (
        <>
          <Divider />
          <Row k="Storage level (live)" v={`${fmt(Math.min(1.5, eqLevel) * 100, 0)} %`} good={!!eqSt && eqLevel < 0.9} bad={!!eqSt && eqLevel >= 0.999} />
          <Row k="Stored volume" v={`${fmt(eqSt?.storedVolumeM3 ?? 0, 0)} of ${fmt(eqCapM3, 0)} m³`} />
          <Row k="Stored BOD load" v={`${fmt(eqSt?.constituentMassKg['bod'] ?? 0, 0)} kg`} />
          <Row k="Stored TSS load" v={`${fmt(eqSt?.constituentMassKg['tss'] ?? 0, 0)} kg`} />
          <Row k="Min pump-out pool" v={`~${fmt(eqCapM3 * EQ_MIN_POOL_FRACTION, 0)} m³`} />
          <CalcBlock title="Storage Balance (live)"
            eq="V′ = V₀ + (Q_in − Q_out)·Δt"
            sub={`level ${fmt(Math.min(1.5, eqLevel) * 100, 0)} % of ${fmt(eqCapM3, 0)} m³ working volume`}
            result={`${fmt(eqSt?.storedVolumeM3 ?? 0, 0)} m³ stored`} />
          <p className="text-[10px] text-slate-500 font-mono">Mixed storage: V′ = V + (Qin − Qout)·dt; each pollutant integrates Qin·Cin − Qout·Ctank. Bigger basin ⇒ smoother downstream load (§J).</p>
        </>
      )}
      {bp!.processType === 'pump_station' && unit.pumpRuntime && (
        <>
          <Divider />
          <Row k="Status" v={String(unit.pumpRuntime.status)} good={unit.pumpRuntime.status === 'ok'} bad={unit.pumpRuntime.status !== 'ok' && unit.pumpRuntime.status !== 'oversized'} />
          <Row k="Duty flow" v={`${fmt(unit.pumpRuntime.dutyFlowM3h, 1)} m³/h`} />
          <Row k="Duty head" v={`${fmt(unit.pumpRuntime.dutyHeadM, 2)} m`} />
          <Row k="BEP fraction" v={`${fmt(unit.pumpRuntime.bepFraction * 100, 0)} %`} good={unit.pumpRuntime.bepFraction >= 0.7 && unit.pumpRuntime.bepFraction <= 1.15} bad={unit.pumpRuntime.bepFraction < 0.5 || unit.pumpRuntime.bepFraction > 1.3} />
          <Row k="Electrical power" v={`${fmt(unit.pumpRuntime.electricalPowerKw, 1)} kW`} />
          {(() => {
            const rt = unit.pumpRuntime;
            if (!rt || rt.dutyFlowM3h <= 0) return null;
            const qM3s = rt.dutyFlowM3h / 3600;
            const pHydKw = (1000 * 9.81 * qM3s * rt.dutyHeadM) / 1000;
            const etaWire = rt.electricalPowerKw > 0 ? pHydKw / rt.electricalPowerKw : 0;
            return (
              <CalcBlock title="Wire-to-Water Efficiency"
                eq="η = P_hyd / P_elec ; P_hyd = ρ·g·Q·H"
                sub={`9.81 × ${fmt(qM3s, 3)} m³/s × ${fmt(rt.dutyHeadM, 2)} m = ${fmt(pHydKw, 2)} kW hydraulic vs ${fmt(rt.electricalPowerKw, 1)} kW drawn`}
                result={`${fmt(etaWire * 100, 0)} %`}
                note="Low η ⇒ duty point far from BEP or oversized motor — resize impound/piping." />
            );
          })()}
          {unit.pumpRuntime.cavitating && <Row k="⚠ Cavitation risk" v="YES" bad />}
          {unit.pumpRuntime.failedUnitCount > 0 && <Row k="Failed units" v={String(unit.pumpRuntime.failedUnitCount)} bad />}
        </>
      )}
    </div>
  );
}

function EconomicsTab({ bp }: { bp: PlacedUnit['blueprint'] }) {
  const geo = bp!.design.geometry;
  const struct = estimateStructureCAPEX(
    geo,
    bp!.design.materialId,
    bp!.processType === 'activated_sludge_cas'
      ? { diffuserModelId: (bp!.equipment as any).diffuserModelId, diffuserCount: (bp!.equipment as any).diffuserCount }
      : {}
  );
  const blowerCap = bp!.processType === 'activated_sludge_cas'
    ? estimateBlowerCAPEX((bp!.equipment as any).blowerModelId, (bp!.equipment as any).blowerRedundancyId)
    : 0;

  return (
    <div className="flex flex-col gap-2 text-[11px] font-mono">
      <Row k="Civil works" v={money(struct.civil)} />
      {(() => {
        const mat = CONSTRUCTION_MATERIALS[bp!.design.materialId] ?? CONSTRUCTION_MATERIALS.reinforced_concrete;
        const cq = civilQuantities(geo);
        return (
          <CalcBlock title="Civil Works Derivation"
            eq="V_conc = A_floor·t_floor + A_wall·t_wall ; civil = V_conc·rate·shell + V_exc·$22"
            sub={`${fmt(cq.concreteVolumeM3, 0)} m³ × $${mat.concreteCostPerM3}/m³ × ${mat.shellCostFactor} shell + ${fmt(cq.excavationVolumeM3, 0)} m³ × $22/m³ excavation`}
            result={money(struct.civil)}
            note="Quantity take-off from the ACTUAL designed geometry — no fixed template price." />
        );
      })()}
      <Row k="Mechanical (eq/diffusers)" v={money(struct.mechanical + blowerCap)} />
      <Row k="Electrical" v={money(struct.electrical)} />
      <Row k="Instrumentation" v={money(struct.instrumentation)} />
      <Row k="Site work" v={money(struct.sitework)} />
      <Row k="Contingency (12%)" v={money(struct.contingency)} />
      <Divider />
      <Row k="TOTAL CAPEX" v={money(struct.total + blowerCap)} good />
      <CalcBlock title="Total CAPEX Composition"
        eq="TOTAL = civil + mech/equip + elec + instr + site + contingency(12%) + blower"
        sub={`${money(struct.civil)} + ${money(struct.mechanical + blowerCap)} + ${money(struct.electrical)} + ${money(struct.instrumentation)} + ${money(struct.sitework)} + ${money(struct.contingency)} + ${money(blowerCap)}`}
        result={money(struct.total + blowerCap)} />
      <p className="text-[10px] text-slate-500 font-mono">Cost derives from concrete volumes, equipment selections, redundancy and pipework — not a fixed template price (Prompt §T/U).</p>
    </div>
  );
}

function MaintenanceTab({ unit }: { unit: PlacedUnit }) {
  const cond = unit.condition ?? { conditionIndex: 1, operatingHours: 0, diffuserFoulingFactor: 1, lastMaintenanceDay: 0, nextServiceDay: 90 };
  const risk = (1 - cond.conditionIndex) * 0.6 + (1 - cond.diffuserFoulingFactor) * 0.4;
  return (
    <div className="flex flex-col gap-2 text-[11px] font-mono">
      <Row k="Condition index" v={`${fmt(cond.conditionIndex * 100, 0)} %`} good={cond.conditionIndex > 0.8} bad={cond.conditionIndex < 0.5} />
      <Row k="Operating hours" v={`${fmt(cond.operatingHours, 0)} h`} />
      <Row k="Diffuser fouling" v={`${fmt(cond.diffuserFoulingFactor * 100, 0)} % clean`} bad={cond.diffuserFoulingFactor < 0.8} />
      <Row k="Next service" v={`day ${fmt(cond.nextServiceDay, 0)}`} />
      <Row k="Failure risk" v={`${fmt(risk * 100, 0)} %`} good={risk < 0.2} bad={risk > 0.5} />
      <p className="text-[10px] text-slate-500 font-mono">Standby redundancy lets maintenance happen without losing process capability.</p>
    </div>
  );
}

// ── Small UI atoms ───────────────────────────────────────────────────────────

function Shell({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950 animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-900 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Calculator size={18} className="text-teal-400 shrink-0" />
            <h2 className="text-sm font-bold text-slate-100 truncate">Unit Designer — {title}</h2>
          </div>
          <button onClick={() => { SoundManager.playClick(); onClose(); }} className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 overflow-y-auto scrollbar-thin">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{label}</span>
      {children}
    </label>
  );
}

function NumberInput({ value, min, max, step, onChange }: {
  value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void;
}) {
  return (
    <input type="number" value={value} min={min} max={max} step={step}
      onChange={e => {
        let v = parseFloat(e.target.value);
        if (Number.isNaN(v)) return;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        onChange(v);
      }}
      className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 w-full font-mono" />
  );
}

function Row({ k, v, good, bad }: { k: string; v: string; good?: boolean; bad?: boolean }) {
  const color = bad ? 'text-red-300' : good ? 'text-emerald-300' : 'text-slate-200';
  return (
    <div className="flex justify-between"><span className="text-slate-400">{k}</span><span className={color}>{v}</span></div>
  );
}

function Divider() { return <div className="h-px bg-slate-800 my-1" />; }

function CalcBlock({ title, eq, sub, result, note }: { title: string; eq: string; sub: string; result: string; note?: string }) {
  return (
    <div className="bg-teal-950/20 border border-teal-700/40 rounded-lg p-2">
      <div className="text-[10px] uppercase tracking-wider text-teal-300 font-bold">{title}</div>
      <div className="text-cyan-200 font-mono text-xs mt-0.5">{eq}</div>
      <div className="text-slate-400 font-mono text-[10px]">{sub}</div>
      <div className="text-emerald-300 font-mono text-sm font-bold mt-0.5">= {result}</div>
      {note && <div className="text-slate-500 text-[10px] mt-0.5">{note}</div>}
    </div>
  );
}
