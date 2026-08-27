import React from 'react';
import { Bookmark, Stamp, Trash2, Layers, Cpu, Columns3 } from 'lucide-react';
import type { ConstructionTemplate } from '../design/ConstructionLibrary';
import { estimateTemplateCAPEX, templateSummaryLine } from '../design/ConstructionLibrary';
import { SoundManager } from '../audio/SoundManager';

interface ConstructionLibraryStripProps {
  templates: ConstructionTemplate[];
  onStamp: (id: string) => void;
  onRemove: (id: string) => void;
}

export const ConstructionLibraryStrip: React.FC<ConstructionLibraryStripProps> = ({ templates, onStamp, onRemove }) => {
  if (!templates || templates.length === 0) return null;
  return (
    <div className="absolute top-[162px] left-1/2 -translate-x-1/2 z-20 pointer-events-auto
                    flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900/90 border border-indigo-500/30
                    shadow-2xl backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-150 max-w-[92vw]">
      <div className="p-1.5 rounded-lg bg-indigo-500 text-white">
        <Bookmark size={14} />
      </div>
      <div className="flex flex-col min-w-0">
        <span className="text-xs font-black tracking-wide text-indigo-300 leading-none flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded bg-indigo-500 text-white text-[10px]">{templates.length} skid template{templates.length>1?'s':''}</span>
          <span className="hidden sm:inline text-indigo-200/70 font-mono text-[10px]">Library — stamp to clone a skid anywhere (reuses civil + kit)</span>
        </span>
      </div>
      <div className="flex items-center gap-1.5 ml-2 shrink-0 flex-wrap">
        {templates.map(t => {
          const cost = estimateTemplateCAPEX(t);
          return (
            <div key={t.id} className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-800 border border-slate-700">
              <span className="text-[11px] font-bold text-slate-100 max-w-[120px] truncate" title={templateSummaryLine(t)}>{t.name}</span>
              <span className="hidden md:inline-flex items-center gap-1 text-[10px] font-mono text-slate-400">
                {t.basins.length>0 && <span className="flex items-center gap-0.5"><Layers size={10} className="text-emerald-400"/>{t.basins.length}</span>}
                {t.equipment.length>0 && <span className="flex items-center gap-0.5"><Cpu size={10} className="text-orange-400"/>{t.equipment.length}</span>}
                {t.baffles.length>0 && <span className="flex items-center gap-0.5"><Columns3 size={10} className="text-violet-400"/>{t.baffles.length}</span>}
                <span className="text-emerald-300">${cost.toLocaleString()}</span>
              </span>
              <button
                onClick={() => { SoundManager.playClick(); onStamp(t.id); }}
                className="flex items-center gap-1 px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold transition"
                title={`Stamp ${t.name} — clone skid with fresh ids at next free offset (cash-gated $${cost.toLocaleString()})`}
              >
                <Stamp size={11} /> Stamp
              </button>
              <button
                onClick={() => { SoundManager.playDemolish(); onRemove(t.id); }}
                className="p-1 rounded bg-slate-700 hover:bg-rose-600 text-slate-300 hover:text-white transition"
                title={`Remove template ${t.name} from library`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
