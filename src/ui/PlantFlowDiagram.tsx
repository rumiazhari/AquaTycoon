import React, { useMemo } from 'react';
import { X, GitBranch, ShieldCheck, AlertTriangle } from 'lucide-react';
import { GameState } from '../gameplay/GameManager';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import type { UnitTypeId } from '../types/simulation';
import { permitRows } from '../sim/PermitEngine';
import {
  resolveTrainTopology,
  UnitFlowState,
  TrainBranchKind,
} from '../ui/TrainTopology';
import { SoundManager } from '../audio/SoundManager';

interface PlantFlowDiagramProps {
  gameState: GameState;
  onClose: () => void;
}

/** Branch kinds that get a chip (main-line 'liquid' is the diagram spine). */
type BranchChipKind = Exclude<TrainBranchKind, 'liquid'>;

/**
 * Honest numeric formatting: missing/uncomputed data renders as "—", never a
 * fabricated perfect `0 mg/L`. (`outWater?.bod.toFixed(1) || 0` was the bug.)
 */
const fmtNum = (v: number | undefined | null, d: number): string =>
  v === undefined || v === null || !Number.isFinite(v)
    ? '—'
    : v.toLocaleString(undefined, { maximumFractionDigits: d });

/** Chips for non-main-line branches leaving a unit (sludge/RAS/recycle/gas). */
const BRANCH_CHIP: Record<BranchChipKind, string> = {
  sludge: 'bg-yellow-900/40 text-yellow-500 border-yellow-800/60',
  ras: 'bg-amber-900/40 text-amber-400 border-amber-700/60',
  recycle: 'bg-violet-500/15 text-violet-300 border-violet-500/40',
  gas: 'bg-orange-500/10 text-orange-300 border-orange-500/40',
};

export const PlantFlowDiagram: React.FC<PlantFlowDiagramProps> = ({ gameState, onClose }) => {
  const { units, pipes, finalEffluent, currentLevel, overallStats } = gameState;

  // REAL hydraulic topology from pipe connections — never `units.map(...)`.
  const topo = useMemo(() => resolveTrainTopology(units, pipes), [units, pipes]);
  // THE authoritative permit table (shared with HUD + Operator Console).
  const rows = useMemo(
    () => permitRows(finalEffluent, currentLevel.standards),
    [finalEffluent, currentLevel.standards]
  );
  const passCount = rows.filter(r => r.pass).length;
  const hasOutfallFlow = finalEffluent.flowRate > 10;

  const trainStates = topo.mainTrainOrder
    .map(id => topo.byUnit.get(id))
    .filter((s): s is UnitFlowState => !!s);
  const offTrainStates = topo.offTrainIds
    .map(id => topo.byUnit.get(id))
    .filter((s): s is UnitFlowState => !!s);

  /** Branch chips (sludge/RAS/recycle/gas lines) leaving this unit. */
  const branchChipsFor = (unitId: string) =>
    topo.links
      .filter((l): l is typeof l & { kind: BranchChipKind } =>
        l.fromUnitId === unitId && l.kind !== 'liquid')
      .map(l => (
        <span
          key={l.pipeId}
          className={`text-[9px] font-mono px-1.5 py-0.5 rounded border uppercase ${BRANCH_CHIP[l.kind]}`}
        >
          {l.kind}
        </span>
      ));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950 animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] sm:max-h-[88vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-slate-800 shrink-0 gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-xl bg-teal-500/20 text-teal-400 shrink-0">
              <GitBranch size={20} />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-slate-100 truncate">Process Flow Diagram (PFD / P&amp;ID)</h2>
              <p className="text-xs text-slate-400 font-mono truncate">
                Real Pipe Topology &amp; Mass-Balance — {pipes.length} connection{pipes.length === 1 ? '' : 's'}
              </p>
            </div>
          </div>
          <button
            onClick={() => { SoundManager.playClick(); onClose(); }}
            className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 flex flex-col gap-6 overflow-y-auto scrollbar-thin">

          {/* Top Plant Removal Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">BOD₅ Removal</span>
              <div className="text-base font-extrabold text-cyan-400 font-mono">
                {overallStats.overallBodRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">COD Removal</span>
              <div className="text-base font-extrabold text-sky-400 font-mono">
                {overallStats.overallCodRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">TSS Removal</span>
              <div className="text-base font-extrabold text-teal-400 font-mono">
                {overallStats.overallTssRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">Total Nitrogen</span>
              <div className="text-base font-extrabold text-purple-400 font-mono">
                {overallStats.overallTnRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">Total Phosphorus</span>
              <div className="text-base font-extrabold text-amber-400 font-mono">
                {overallStats.overallTpRemoval.toFixed(1)}%
              </div>
            </div>
          </div>

          {/* ── ACTIVE hydraulic treatment train (real reachability) ── */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
              Active Hydraulic Treatment Train ({trainStates.length} unit{trainStates.length === 1 ? '' : 's'} on the liquid path)
            </h3>

            {trainStates.length <= 1 && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-950/30 border border-amber-600/40 text-[11px] text-amber-200 font-mono">
                <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-400" />
                <span>
                  No active treatment train yet. Open the Pipes tool and connect units from the Inlet onward —
                  only units reachable from the Inlet through liquid pipes appear here.
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-stretch gap-1.5">
              {trainStates.map((s, i) => {
                const def = UNIT_DEFINITIONS[s.unit.typeId];
                if (!def) return null;
                const flowing = s.inflowM3d > 0.5 || s.unit.typeId === 'influent_inlet';
                const chips = branchChipsFor(s.unit.instanceId);
                // Real downstream edges from THIS unit (not a fake linear chain).
                const downstream = topo.links.filter(
                  l => l.fromUnitId === s.unit.instanceId && l.kind === 'liquid'
                );
                return (
                  <React.Fragment key={s.unit.instanceId}>
                    {i > 0 && (
                      <span className="self-center text-cyan-400 font-bold px-0.5 select-none">→</span>
                    )}
                    <div
                      className={`p-2.5 rounded-xl border flex flex-col gap-1.5 min-w-[168px] max-w-[196px] flex-1 ${
                        flowing
                          ? 'bg-slate-900 border-cyan-700/50'
                          : 'bg-slate-900/60 border-amber-700/40'
                      }`}
                    >
                      <div>
                        <div className="text-[8px] font-mono uppercase text-cyan-400 font-bold truncate">{def.category}</div>
                        <div className="text-[11px] font-bold text-slate-100 leading-tight">{def.name}</div>
                      </div>

                      {!flowing && (
                        <span className="text-[9px] font-mono font-bold px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-600/40 w-fit">
                          NO FLOW
                        </span>
                      )}

                      <div className="text-[10px] font-mono text-slate-300 grid grid-cols-2 gap-x-2">
                        <span>In: <span className="text-sky-300">{fmtNum(flowing ? s.inflowM3d : undefined, 0)}</span></span>
                        <span>Out: <span className="text-cyan-300">{fmtNum(flowing && s.outflowM3d > 0 ? s.outflowM3d : undefined, 0)}</span> m³/d</span>
                        <span>BOD: <span className="text-cyan-300">{flowing && s.hasOutletData ? fmtNum(s.unit.lastOutletQuality.bod, 1) : '—'}</span></span>
                        <span>TSS: <span className="text-teal-300">{flowing && s.hasOutletData ? fmtNum(s.unit.lastOutletQuality.tss, 1) : '—'}</span></span>
                      </div>

                      {(chips.length > 0 || (s.unit.gasStreams && Object.values(s.unit.gasStreams).some(g => g.flowRate > 0.01))) && (
                        <div className="flex flex-wrap gap-1">
                          {chips}
                          {s.unit.gasStreams && Object.values(s.unit.gasStreams).some(g => g.flowRate > 0.01) && (
                            <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-orange-500/10 text-orange-300 border-orange-500/40">
                              🔥 biogas
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* A real splitter fans OUT to multiple units, NOT a linear chain. */}
                    {downstream.length > 1 && (
                      <div className="flex flex-col items-center text-slate-500 text-[9px] font-mono py-0.5">
                        <span>├─ Train A → {UNIT_DEFINITIONS[downstream[0].toUnitId as UnitTypeId]?.name ?? downstream[0].toUnitId}</span>
                        <span>└─ Train B → {UNIT_DEFINITIONS[downstream[1].toUnitId as UnitTypeId]?.name ?? downstream[1].toUnitId}</span>
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          </div>

          {/* ── Off-train / disconnected units — clearly separated ── */}
          {offTrainStates.length > 0 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono flex items-center gap-1.5">
                <AlertTriangle size={13} className="text-amber-400" />
                Unconnected / Auxiliary Units ({offTrainStates.length}) — not part of the active liquid train
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {offTrainStates.map(s => {
                  const def = UNIT_DEFINITIONS[s.unit.typeId];
                  if (!def) return null;
                  const reason = s.fullyDisconnected
                    ? 'No pipes attached'
                    : s.hasLiquidInfeed
                    ? 'Liquid feed present but unreachable from the Inlet'
                    : 'Only sludge/gas/recycle connections';
                  return (
                    <div
                      key={s.unit.instanceId}
                      className="p-3.5 rounded-xl bg-slate-950/50 border border-dashed border-slate-700/70 opacity-90 flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-[9px] font-mono uppercase text-slate-500 font-bold">{def.category}</div>
                          <div className="text-xs font-bold text-slate-300">{def.name}</div>
                        </div>
                        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                          OFF-TRAIN
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-slate-500">{reason}</div>
                      <div className="grid grid-cols-3 gap-1 text-[11px] font-mono p-2 rounded bg-slate-900/60 text-slate-400">
                        <div>BOD: <span className="text-slate-500">—</span></div>
                        <div>TSS: <span className="text-slate-500">—</span></div>
                        <div>TN: <span className="text-slate-500">—</span></div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                        <span>⚡ {s.unit.lastPowerKwActual.toFixed(1)} kW</span>
                        <span>💰 ${fmtNum(s.unit.lastOpexActual, 0)}/day</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Effluent Standards Comparison — FULL authoritative permit set */}
          <div className="flex flex-col gap-2 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h3 className="text-xs font-bold text-slate-300 font-mono uppercase flex items-center gap-2">
                <ShieldCheck size={14} className="text-emerald-400" />
                Final Outfall vs Regulatory Effluent Standards
              </h3>
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
                passCount === rows.length
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-rose-500/20 text-rose-400'
              }`}>
                {passCount}/{rows.length} parameters passing
              </span>
            </div>

            {!hasOutfallFlow && (
              <div className="flex items-center gap-2 text-[11px] font-mono text-amber-300 bg-amber-950/30 border border-amber-700/40 rounded-lg px-3 py-2">
                <AlertTriangle size={13} className="shrink-0" />
                No treated outfall flow — readings below are the last computed sample, not live discharge.
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono text-left">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-2 font-medium">Parameter</th>
                    <th className="pb-2 font-medium">Raw Influent</th>
                    <th className="pb-2 font-medium">Treated Effluent</th>
                    <th className="pb-2 font-medium">Legal Limit</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  {rows.map(r => {
                    const rawIn = (currentLevel.influentSpec as unknown as Record<string, number>)[r.key];
                    return (
                      <tr key={r.key}>
                        <td className="py-2 font-bold whitespace-nowrap">{r.label}</td>
                        <td>{rawIn !== undefined ? `${fmtNum(rawIn, r.decimals)}${r.unit ? ' ' + r.unit : ''}` : '—'}</td>
                        <td className={`${r.pass ? 'text-cyan-300' : 'text-rose-300'} font-bold`}>
                          {fmtNum(r.value, r.decimals)}{r.unit ? ` ${r.unit}` : ''}
                        </td>
                        <td className="whitespace-nowrap">{r.limitText}</td>
                        <td>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            r.pass ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                          }`}>
                            {r.pass ? 'PASS' : 'FAIL'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
