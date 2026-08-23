import React from 'react';
import { Sparkles, Wand2, CheckCircle2, ChevronRight } from 'lucide-react';
import { NextStepSuggestion } from '../gameplay/GameManager';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { SoundManager } from '../audio/SoundManager';
import { UnitTypeId } from '../types/simulation';

interface NextStepGuideProps {
  suggestion: NextStepSuggestion | null;
  onSelectSuggestion: (typeId: UnitTypeId, gridX: number, gridY: number) => void;
  onAutoPipe: () => void;
  unitsCount: number;
  pipesCount: number;
}

export const NextStepGuide: React.FC<NextStepGuideProps> = ({
  suggestion,
  onSelectSuggestion,
  onAutoPipe,
  unitsCount,
  pipesCount
}) => {
  if (!suggestion) {
    return (
      <div className="absolute top-20 left-4 z-20 pointer-events-auto bg-slate-900/90 backdrop-blur-md border border-emerald-500/40 rounded-2xl p-3 shadow-2xl max-w-xs animate-in fade-in slide-in-from-left-2 duration-200">
        <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs">
          <CheckCircle2 size={16} />
          <span>Core Treatment Train Complete!</span>
        </div>
        <p className="text-[11px] text-slate-300 mt-1">
          {pipesCount === 0 
            ? 'Connect pipes between your units and to the Outfall to start treating wastewater!'
            : 'All major units placed. Monitor effluent water quality to meet EPA regulatory standards.'}
        </p>
        <button
          onClick={() => {
            SoundManager.playConnect();
            onAutoPipe();
          }}
          className="mt-2 w-full py-1.5 px-3 rounded-xl bg-gradient-to-r from-teal-500/20 to-cyan-500/20 hover:from-teal-500/30 hover:to-cyan-500/30 border border-cyan-500/40 text-[11px] font-mono text-cyan-300 font-bold flex items-center justify-center gap-1.5 transition"
        >
          <Wand2 size={13} />
          <span>Auto-Connect All Pipes</span>
        </button>
      </div>
    );
  }

  const def = UNIT_DEFINITIONS[suggestion.unitTypeId];

  return (
    <div className="absolute top-20 left-4 z-20 pointer-events-auto bg-slate-900/95 backdrop-blur-md border border-sky-500/50 rounded-2xl p-3 shadow-2xl max-w-sm flex flex-col gap-2 animate-in fade-in slide-in-from-left-2 duration-200">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sky-400 font-bold text-xs uppercase tracking-wider font-mono">
          <Sparkles size={14} className="text-amber-400 animate-pulse" />
          <span>Next Recommended Step</span>
        </div>
        <span className="text-[9px] px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 font-mono border border-sky-500/30">
          Guide
        </span>
      </div>

      {/* Description Hint */}
      <p className="text-xs text-slate-200 leading-snug">
        {suggestion.hint}
      </p>

      {/* Recommended Unit Card */}
      {def && (
        <div className="flex items-center justify-between p-2 rounded-xl bg-slate-800/80 border border-slate-700/80">
          <div>
            <div className="font-bold text-xs text-cyan-300">{def.name}</div>
            <div className="text-[10px] text-emerald-400 font-mono">${def.capex.toLocaleString()} • {def.footprint[0]}x{def.footprint[1]} grid</div>
          </div>
          <button
            onClick={() => {
              SoundManager.playClick();
              onSelectSuggestion(suggestion.unitTypeId, suggestion.gridX, suggestion.gridY);
            }}
            className="px-3 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs flex items-center gap-1 shadow-md transition"
          >
            <span>Select</span>
            <ChevronRight size={14} />
          </button>
        </div>
      )}

      {/* Pipe Assist if units placed */}
      {unitsCount > 2 && (
        <button
          onClick={() => {
            SoundManager.playConnect();
            onAutoPipe();
          }}
          className="w-full py-1.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-cyan-500/30 text-[10px] font-mono text-cyan-300 flex items-center justify-center gap-1.5 transition"
        >
          <Wand2 size={12} />
          <span>Auto-Route Pipes ({pipesCount} connected)</span>
        </button>
      )}
    </div>
  );
};
