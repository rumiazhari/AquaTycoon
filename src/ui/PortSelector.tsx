import React from 'react';
import { ArrowUpFromLine, ArrowDownToLine, Droplets, Flame, Recycle, CircleDot, Check, X } from 'lucide-react';
import { UnitPort } from '../types/simulation';

export interface PortChoice {
  port: UnitPort;
  connected: boolean; // already has a pipe attached on the relevant side
}

interface PortSelectorProps {
  title: string;
  subtitle?: string;
  choices: PortChoice[];
  /** id of the pre-selected source port when choosing a destination */
  highlightId?: string | null;
  onSelect: (port: UnitPort) => void;
  onCancel: () => void;
  anchor: { x: number; y: number }; // canvas px
}

const TYPE_ICON: Record<string, React.ReactNode> = {
  inlet: <ArrowDownToLine size={13} />,
  outlet: <ArrowUpFromLine size={13} />,
  sludge_outlet: <Droplets size={13} />,
  ras_inlet: <Recycle size={13} />,
  recycle_outlet: <Recycle size={13} />,
  gas_outlet: <Flame size={13} />
};

const TYPE_STYLE: Record<string, string> = {
  inlet: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  ras_inlet: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  outlet: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  sludge_outlet: 'bg-yellow-900/40 text-yellow-600 border-yellow-800/50',
  recycle_outlet: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  gas_outlet: 'bg-amber-400/10 text-amber-300 border-amber-500/40'
};

/**
 * Contextual port selector — appears next to a unit in Pipe Mode whenever it
 * exposes multiple valid source (or target) ports. Shows name, type and live
 * connection status so players always know which physical port they pick.
 */
export const PortSelector: React.FC<PortSelectorProps> = ({
  title,
  subtitle,
  choices,
  highlightId,
  onSelect,
  onCancel,
  anchor
}) => {
  // Keep the card on-screen near the unit/cursor
  const left = Math.min(Math.max(8, anchor.x - 130), window.innerWidth - 290);
  const top = Math.min(Math.max(64, anchor.y - 20), window.innerHeight - 260);

  return (
    <div
      className="absolute z-40 w-[272px] rounded-xl bg-slate-900 border border-cyan-500/50 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      style={{ left, top }}
    >
      <div className="px-3 py-2 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-bold text-slate-100 truncate">{title}</div>
          {subtitle && (
            <div className="text-[9px] font-mono text-cyan-400 truncate">{subtitle}</div>
          )}
        </div>
        <button
          onClick={onCancel}
          className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition shrink-0"
          title="Cancel"
        >
          <X size={12} />
        </button>
      </div>

      <div className="p-1.5 flex flex-col gap-1 max-h-[240px] overflow-y-auto scrollbar-thin">
        {choices.length === 0 && (
          <div className="text-[11px] text-slate-400 font-mono text-center py-2.5 px-1">
            No compatible ports available.
          </div>
        )}
        {choices.map(({ port, connected }) => {
          const highlighted = highlightId === port.id;
          return (
            <button
              key={port.id}
              onClick={() => onSelect(port)}
              disabled={connected && !highlighted}
              className={`w-full text-left px-2 py-1.5 rounded-lg border transition group ${
                highlighted
                  ? 'bg-amber-500/15 border-amber-400/60 ring-1 ring-amber-400/40'
                  : connected
                  ? 'opacity-40 cursor-not-allowed border-slate-800 bg-slate-950/60'
                  : 'border-slate-800 bg-slate-950/60 hover:border-cyan-400/60 hover:bg-slate-800/80'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`p-1 rounded border ${TYPE_STYLE[port.type] ?? ''}`}>
                  {TYPE_ICON[port.type] ?? <CircleDot size={13} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-bold text-slate-100 truncate">{port.name}</div>
                  <div className="text-[9px] font-mono text-slate-400 uppercase tracking-wide">
                    {port.type.replace(/_/g, ' ')}
                  </div>
                </div>
                {highlighted ? (
                  <span className="flex items-center gap-0.5 text-[9px] font-bold font-mono text-amber-300 shrink-0">
                    <Check size={10} /> CHOSEN
                  </span>
                ) : connected ? (
                  <span className="text-[9px] font-mono text-rose-300 shrink-0">IN USE</span>
                ) : (
                  <span className="text-[9px] font-mono text-emerald-400 shrink-0">FREE</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};
