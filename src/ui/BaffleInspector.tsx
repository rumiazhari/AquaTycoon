import React from 'react';
import { X, Trash2, Columns3, Rows3 } from 'lucide-react';
import type { BaffleWall } from '../design/BasinZone';
import { estimateBaffleCAPEX } from '../design/BasinZone';
import type { CustomBasin } from '../design/CustomBasin';
import { SoundManager } from '../audio/SoundManager';

interface BaffleInspectorProps {
  baffle: BaffleWall;
  basin: CustomBasin;
  onClose: () => void;
  onDemolish: (id: string) => void;
}

export const BaffleInspector: React.FC<BaffleInspectorProps> = ({ baffle, basin, onClose, onDemolish }) => {
  const isVertical = baffle.orientation === 'vertical';
  const Icon = isVertical ? Columns3 : Rows3;
  const cost = estimateBaffleCAPEX(basin, baffle.orientation);
  const refund = Math.round(cost * 0.6);
  const lengthM = (isVertical ? basin.h : basin.w) * 6;

  return (
    <div className="absolute top-16 right-4 z-20 w-[min(22rem,calc(100vw-2rem))] bg-slate-900/95 border border-violet-500/30 rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in slide-in-from-right-4 duration-200">
      <div className="flex items-center justify-between px-4 py-3 bg-violet-950/40 border-b border-violet-800/40">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg bg-violet-500/20 text-violet-300">
            <Icon size={16} />
          </span>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-violet-400 font-bold">
              Interior Baffle · {isVertical ? 'Vertical' : 'Horizontal'}
            </div>
            <h2 className="text-sm font-bold text-slate-100">{isVertical ? 'Vertical Baffle Wall' : 'Horizontal Baffle Wall'}</h2>
          </div>
        </div>
        <button
          onClick={() => { SoundManager.playClick(); onClose(); }}
          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
        >
          <X size={15} />
        </button>
      </div>

      <div className="p-4 flex flex-col gap-3">
        <div className="p-3 rounded-xl bg-violet-950/20 border border-violet-500/20 flex flex-col gap-1.5">
          <span className="text-xs font-bold text-violet-300">Compartmentalises basin into functional zones</span>
          <span className="text-[11px] text-slate-400">Partitions {basin.w}×{basin.h} basin at offset {baffle.offsetTiles} ({lengthM} m wall, {basin.depthM} m deep). Zones derive automatically — each cell becomes an anoxic/aerobic compartment for the next membrane/media phases.</span>
          <div className="flex gap-2 mt-1 font-mono text-[11px]">
            <span className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">Basin {basin.x},{basin.y}</span>
            <span className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">{isVertical ? `│ x+${baffle.offsetTiles}` : `─ y+${baffle.offsetTiles}`}</span>
            <span className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">{lengthM} m span</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div className="p-2.5 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Installed Cost</span>
            <span className="text-sm font-bold text-emerald-400">${cost.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500">{lengthM} m × {basin.depthM} m @ $55/m² + $450</span>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Salvage</span>
            <span className="text-sm font-bold text-amber-300">+${refund.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500">60% on demolish</span>
          </div>
        </div>

        <button
          onClick={() => { SoundManager.playDemolish(); onDemolish(baffle.id); }}
          className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold transition"
        >
          <Trash2 size={14} /> <span>Remove Baffle (Refund +${refund.toLocaleString()})</span>
        </button>
      </div>
    </div>
  );
};
