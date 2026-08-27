import React, { useState } from 'react';
import { X, Trash2, Droplets, Ruler, Move, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Expand, Columns3, Mountain } from 'lucide-react';
import type { CustomBasin } from '../design/CustomBasin';
import { basinLengthM, basinWidthM, basinVolumeM3, basinDimensionLabel, estimateBasinCAPEX, BASIN_MIN_DEPTH_M, BASIN_MAX_DEPTH_M, BASIN_MIN_TILES } from '../design/CustomBasin';
import { basinFoundationBreakdown } from '../design/TerrainFoundation';
import { SoundManager } from '../audio/SoundManager';

interface BasinInspectorProps {
  basin: CustomBasin;
  zoneCount: number;
  equipmentInside: number;
  onClose: () => void;
  onDemolish: (id: string) => void;
  onUpdateDepth: (id: string, depthM: number) => void;
  onResize: (id: string, rect: { x: number; y: number; w: number; h: number }) => void;
}

export const BasinInspector: React.FC<BasinInspectorProps> = ({ basin, zoneCount, equipmentInside, onClose, onDemolish, onUpdateDepth, onResize }) => {
  const [depthDraft, setDepthDraft] = useState(basin.depthM);
  // keep draft synced when basin prop changes (external edits)
  React.useEffect(() => { setDepthDraft(basin.depthM); }, [basin.depthM]);

  const lenM = basinLengthM(basin);
  const widM = basinWidthM(basin);
  const vol = basinVolumeM3(basin);
  const areaM2 = lenM * widM;
  const capex = estimateBasinCAPEX(basin);
  const foundation = basinFoundationBreakdown(basin);
  const adjustedCapex = foundation.adjustedCost;
  const refund = Math.round(adjustedCapex * 0.5);
  const dimLabel = basinDimensionLabel(basin);

  const draftFoundation = basinFoundationBreakdown({ x: basin.x, y: basin.y, w: basin.w, h: basin.h, depthM: depthDraft } as any);
  const draftAdjusted = draftFoundation.adjustedCost;
  const depthDelta = draftAdjusted - adjustedCapex;
  const depthRefund = depthDelta < 0 ? Math.round(-depthDelta * 0.5) : 0;

  const resize = (edge: 'west' | 'east' | 'north' | 'south', delta: 1 | -1) => {
    let nx = basin.x, ny = basin.y, nw = basin.w, nh = basin.h;
    if (edge === 'west') { nx = basin.x - delta; nw = basin.w + delta; }
    if (edge === 'east') { nw = basin.w + delta; }
    if (edge === 'north') { ny = basin.y - delta; nh = basin.h + delta; }
    if (edge === 'south') { nh = basin.h + delta; }
    // clamp_min is validated in domain — still trim to avoid 1×N nonsense
    if (nw < BASIN_MIN_TILES || nh < BASIN_MIN_TILES) {
      SoundManager.playWarning();
      return;
    }
    onResize(basin.id, { x: nx, y: ny, w: nw, h: nh });
  };

  return (
    <div className="absolute top-16 right-4 z-20 w-[min(26rem,calc(100vw-2rem))] bg-slate-900/95 border border-cyan-500/30 rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in slide-in-from-right-4 duration-200">
      <div className="flex items-center justify-between px-4 py-3 bg-cyan-950/40 border-b border-cyan-800/40">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-300">
            <Droplets size={16} />
          </span>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-400 font-bold">Custom Basin · Direct Edit</div>
            <h2 className="text-sm font-bold text-slate-100">{basin.w}×{basin.h} tiles · {dimLabel.split('·')[0]?.trim()}</h2>
          </div>
        </div>
        <button onClick={() => { SoundManager.playClick(); onClose(); }} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"><X size={15} /></button>
      </div>

      <div className="p-4 flex flex-col gap-4 max-h-[min(72vh,42rem)] overflow-y-auto">
        {/* In-world dimensions banner — mirrors what the 3D view highlights */}
        <div className="p-3 rounded-xl bg-cyan-950/20 border border-cyan-500/20 flex flex-col gap-1.5">
          <span className="text-xs font-bold text-cyan-300 flex items-center gap-1.5"><Ruler size={12} /> Engineered dimensions</span>
          <span className="text-[11px] font-mono text-slate-300 bg-slate-900/60 px-2 py-1 rounded border border-slate-700/60">{dimLabel}</span>
          <div className="flex flex-wrap gap-1.5 mt-0.5 font-mono text-[11px]">
            <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{lenM}×{widM} m</span>
            <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{areaM2.toLocaleString()} m²</span>
            <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">{Math.round(vol).toLocaleString()} m³</span>
            <span className={"px-2 py-0.5 rounded border font-bold " + (foundation.conditionTone==='emerald' ? 'bg-emerald-900/40 border-emerald-700/40 text-emerald-300' : foundation.conditionTone==='sky' ? 'bg-sky-900/30 border-sky-700/40 text-sky-300' : foundation.conditionTone==='amber' ? 'bg-amber-900/30 border-amber-700/40 text-amber-300' : 'bg-rose-900/30 border-rose-700/40 text-rose-300')} title={"Base $" + capex.toLocaleString() + " × " + foundation.factor.toFixed(3) + " terrain"}>{adjustedCapex.toLocaleString()} build</span>
            {zoneCount > 1 && <span className="px-2 py-0.5 rounded bg-violet-900/30 border border-violet-700/40 text-violet-300 flex items-center gap-1"><Columns3 size={10} />{zoneCount} zones</span>}
            {equipmentInside > 0 && <span className="px-2 py-0.5 rounded bg-amber-900/30 border border-amber-700/40 text-amber-300">{equipmentInside} machine{equipmentInside>1?'s':''} inside</span>}
          </div>
          <div className={"flex items-center gap-1.5 mt-1 px-2 py-1 rounded border text-[10px] font-mono " + (foundation.conditionTone==='emerald' ? 'bg-emerald-950/30 border-emerald-800/40 text-emerald-300' : foundation.conditionTone==='sky' ? 'bg-sky-950/30 border-sky-800/40 text-sky-300' : foundation.conditionTone==='amber' ? 'bg-amber-950/30 border-amber-800/40 text-amber-300' : 'bg-rose-950/30 border-rose-800/40 text-rose-300')}>
            <Mountain size={11} />
            <span className="font-bold">{foundation.conditionLabel} {foundation.pctLabel}</span>
            <span className="text-slate-500">·</span>
            <span>{"base $" + capex.toLocaleString() + " × " + foundation.factor.toFixed(3) + " → $" + adjustedCapex.toLocaleString()}</span>
            <span className="text-slate-500">·</span>
            <span>{foundation.delta>=0 ? "+$" + foundation.delta.toLocaleString() + " surcharge" : "−$" + Math.abs(foundation.delta).toLocaleString() + " discount"}</span>
          </div>
          <span className="text-[10px] text-slate-500">Selected basin glows emerald in-world — wall-top amber handles show grip points. Drag wall/corner in-world to resize. Ground varies per tile (soft 0.92× → rocky 1.18×) — cheap ground saves excavation.</span>
        </div>

        {/* Depth control — P1 headline feature */}
        <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-sky-300 flex items-center gap-1.5"><Expand size={12} /> Depth retune</span>
            <span className="text-[11px] font-mono text-slate-400">{BASIN_MIN_DEPTH_M.toFixed(1)}–{BASIN_MAX_DEPTH_M.toFixed(1)} m · step 0.5 m</span>
          </div>
          <div className="flex items-center gap-3">
            <input type="range" min={BASIN_MIN_DEPTH_M} max={BASIN_MAX_DEPTH_M} step={0.5} value={depthDraft}
              onChange={e => setDepthDraft(parseFloat(e.target.value))}
              className="flex-1 accent-cyan-500 h-2" />
            <span className="text-sm font-bold font-mono text-cyan-300 w-16 text-right">{depthDraft.toFixed(1)} m</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono text-slate-400 flex-1">
              {Math.abs(depthDelta) < 1
                ? 'No cost change'
                : depthDelta > 0
                  ? `+$${depthDelta.toLocaleString()} deeper`
                  : `Refund +$${depthRefund.toLocaleString()} shallower (50% salvage)`}
            </span>
            <button
              disabled={Math.abs(depthDraft - basin.depthM) < 0.001}
              onClick={() => { SoundManager.playClick(); onUpdateDepth(basin.id, depthDraft); }}
              className="px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs font-bold transition"
            >Apply depth</button>
          </div>
          {depthDelta > 0 && <span className="text-[10px] text-amber-400/80">Deeper = more excavation + taller walls (wall area scales with perimeter × depth).</span>}
        </div>

        {/* Resize — direct footprint editing (cardinal expansions) */}
        <div className="p-3 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-sky-300 flex items-center gap-1.5"><Move size={12} /> Footprint resize</span>
            <span className="text-[11px] font-mono text-slate-400">±1 tile (6 m) per edge</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            <button onClick={() => resize('north', 1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-mono" title="Expand north (+1 tile)"><ArrowUp size={14} /><span>North +1</span></button>
            <button onClick={() => resize('south', 1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-mono" title="Expand south"><ArrowDown size={14} /><span>South +1</span></button>
            <button onClick={() => resize('west', 1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-mono" title="Expand west"><ArrowLeft size={14} /><span>West +1</span></button>
            <button onClick={() => resize('east', 1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 text-[11px] font-mono" title="Expand east"><ArrowRight size={14} /><span>East +1</span></button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            <button onClick={() => resize('north', -1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-amber-950/20 hover:bg-amber-900/30 border border-amber-700/30 text-amber-300 text-[11px] font-mono" title="Shrink north (remove row)"><ArrowDown size={14} className="rotate-180" /><span>North −1</span></button>
            <button onClick={() => resize('south', -1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-amber-950/20 hover:bg-amber-900/30 border border-amber-700/30 text-amber-300 text-[11px] font-mono" title="Shrink south"><ArrowUp size={14} className="rotate-180" /><span>South −1</span></button>
            <button onClick={() => resize('west', -1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-amber-950/20 hover:bg-amber-900/30 border border-amber-700/30 text-amber-300 text-[11px] font-mono" title="Shrink west"><ArrowRight size={14} className="rotate-180" /><span>West −1</span></button>
            <button onClick={() => resize('east', -1)} className="flex flex-col items-center gap-1 p-2 rounded-lg bg-amber-950/20 hover:bg-amber-900/30 border border-amber-700/30 text-amber-300 text-[11px] font-mono" title="Shrink east"><ArrowLeft size={14} className="rotate-180" /><span>East −1</span></button>
          </div>
          <span className="text-[10px] text-slate-500">Expand charges the extra concrete at full price; shrink refunds 50% of the saved volume. Blocked if it would strand equipment or invalidate a baffle — remove kit first.</span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div className="p-2.5 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Installed Cost</span>
            <span className="text-sm font-bold text-emerald-400">${adjustedCapex.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500">{lenM} m × {widM} m × {basin.depthM} m · base {capex.toLocaleString()} {foundation.pctLabel}</span>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Salvage on demolish</span>
            <span className="text-sm font-bold text-amber-300">+${refund.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500">{"50% of $" + adjustedCapex.toLocaleString() + " (terrain-adjusted)"}</span>
          </div>
        </div>

        <button onClick={() => { SoundManager.playDemolish(); onDemolish(basin.id); }} className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold transition">
          <Trash2 size={14} /> <span>Demolish Basin (Refund +${refund.toLocaleString()})</span>
        </button>
      </div>
    </div>
  );
};
