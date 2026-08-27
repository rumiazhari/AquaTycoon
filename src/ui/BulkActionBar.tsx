import React from 'react';
import { Trash2, X, Layers, Cpu, Columns3, Cable, BoxSelect } from 'lucide-react';
import type { ConstructionSelection } from '../design/ConstructionSelection';
import { selectionCount, selectionSummaryLine } from '../design/ConstructionSelection';
import { SoundManager } from '../audio/SoundManager';

interface BulkActionBarProps {
  selection: ConstructionSelection;
  refundEstimate: number;
  onBulkDemolish: () => void;
  onClear: () => void;
}

export const BulkActionBar: React.FC<BulkActionBarProps> = ({ selection, refundEstimate, onBulkDemolish, onClear }) => {
  const count = selectionCount(selection);
  if (count <= 1) return null;
  return (
    <div className="absolute top-[124px] left-1/2 -translate-x-1/2 z-20 pointer-events-auto
                    flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-950/90 border border-amber-500/40
                    shadow-2xl backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-150">
      <div className="p-1.5 rounded-lg bg-amber-500 text-slate-950">
        <BoxSelect size={14} />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-xs font-black tracking-wide text-amber-300 leading-none flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded bg-amber-500 text-slate-900 text-[10px]">{count} selected</span>
          <span className="hidden sm:inline text-amber-200/80 font-mono text-[11px]">{selectionSummaryLine(selection)}</span>
        </span>
        <span className="text-[10px] font-mono text-amber-200/70 hidden md:inline">
          Shift+Click to add · Ctrl+A select all · Esc clears · cascade removes attached pipes/cables
        </span>
      </div>
      <div className="flex items-center gap-1.5 ml-2 shrink-0">
        <span className="text-[11px] font-mono text-emerald-300 hidden lg:inline">+${refundEstimate.toLocaleString()} salvage</span>
        <button
          onClick={() => { SoundManager.playDemolish(); onBulkDemolish(); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-white text-xs font-bold transition shadow-md"
          title={`Demolish all ${count} items — refunds ~$${refundEstimate.toLocaleString()} (50% basins · 70% kit · 60% baffles/utilities)`}
        >
          <Trash2 size={13} /> Bulk Demolish
        </button>
        <button
          onClick={() => { SoundManager.playClick(); onClear(); }}
          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition"
          title="Clear selection (Esc)"
        >
          <X size={13} />
        </button>
      </div>
      {/* grouping cue pills */}
      <div className="hidden xl:flex items-center gap-1 ml-1 pl-2 border-l border-amber-700/30">
        {selection.basins.length > 0 && <span className="px-1.5 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/30 text-emerald-300 text-[10px] font-mono flex items-center gap-1"><Layers size={10} />{selection.basins.length}</span>}
        {selection.equipment.length > 0 && <span className="px-1.5 py-0.5 rounded bg-orange-900/30 border border-orange-700/30 text-orange-300 text-[10px] font-mono flex items-center gap-1"><Cpu size={10} />{selection.equipment.length}</span>}
        {selection.baffles.length > 0 && <span className="px-1.5 py-0.5 rounded bg-violet-900/30 border border-violet-700/30 text-violet-300 text-[10px] font-mono flex items-center gap-1"><Columns3 size={10} />{selection.baffles.length}</span>}
        {selection.utilities.length > 0 && <span className="px-1.5 py-0.5 rounded bg-sky-900/30 border border-sky-700/30 text-sky-300 text-[10px] font-mono flex items-center gap-1"><Cable size={10} />{selection.utilities.length}</span>}
      </div>
    </div>
  );
};
