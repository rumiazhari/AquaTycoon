import React from 'react';
import { X, Wind, Trash2, Droplets, Fan, Cog, Waves, AlertTriangle, CheckCircle2, Columns3 } from 'lucide-react';
import { EQUIPMENT_TYPES } from '../design/ProcessEquipment';
import type { ProcessEquipmentItem } from '../design/ProcessEquipment';
import type { BasinZone } from '../design/BasinZone';
import { SoundManager } from '../audio/SoundManager';

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  fine_bubble_diffuser: Waves,
  submersible_mixer: Fan,
  process_pump: Cog,
  rotary_blower: Wind,
};

interface EquipmentInspectorProps {
  item: ProcessEquipmentItem;
  powered: boolean;
  aerated?: boolean | null;
  zone?: BasinZone | null;
  onClose: () => void;
  onDemolish: (id: string) => void;
}

const ROLE_TONE: Record<string, string> = {
  anoxic: 'bg-sky-950/40 border-sky-500/30 text-sky-300',
  aerobic: 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300',
  settling: 'bg-amber-950/40 border-amber-500/30 text-amber-300',
  buffer: 'bg-slate-800 border-slate-600 text-slate-300',
};

export const EquipmentInspector: React.FC<EquipmentInspectorProps> = ({ item, powered, aerated, zone, onClose, onDemolish }) => {
  const def = EQUIPMENT_TYPES[item.typeId];
  if (!def) return null;
  const Icon = ICONS[item.typeId] ?? Cog;
  const refund = Math.round(def.capexUsd * 0.7);

  const isDiffuser = item.typeId === 'fine_bubble_diffuser';
  const needsPower = def.powerKw > 0;
  const live = isDiffuser ? (aerated ?? false) : powered;

  return (
    <div className="absolute top-16 right-4 z-20 w-[min(22rem,calc(100vw-2rem))] bg-slate-900/95 border border-slate-700/90 rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in slide-in-from-right-4 duration-200">
      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/80">
        <div className="flex items-center gap-2">
          <span className={`p-1.5 rounded-lg ${live ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}`}>
            <Icon size={16} />
          </span>
          <div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
              {def.mounting === 'in_basin' ? 'In-Basin' : 'Ground'} · Equipment
            </div>
            <h2 className="text-sm font-bold text-slate-100">{def.name}</h2>
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
        {/* Zone membership (Phase 5 slice 2) */}
        {zone && (
          <div className={`px-3 py-2 rounded-xl border flex items-center gap-2 text-xs font-mono ${ROLE_TONE[zone.role] ?? ROLE_TONE.buffer}`}>
            <Columns3 size={12} />
            <span className="font-bold capitalize">{zone.role}</span>
            <span className="opacity-70">zone {zone.gridI}–{zone.gridJ}</span>
            <span className="opacity-60">· {zone.w}×{zone.h} tiles</span>
          </div>
        )}

        {/* Functional status */}
        <div className={`p-3 rounded-xl border flex items-start gap-2 ${live ? 'bg-emerald-950/30 border-emerald-500/30' : 'bg-amber-950/30 border-amber-500/40'}`}>
          {live
            ? <CheckCircle2 size={16} className="text-emerald-400 mt-0.5 shrink-0" />
            : <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
          }
          <div className="flex flex-col gap-0.5">
            {isDiffuser ? (
              aerated ? (
                <>
                  <span className="text-xs font-bold text-emerald-300">Aerated — receiving air from a powered blower</span>
                  <span className="text-[11px] text-slate-400">Blue shimmer in-world. Run an air pipe from a powered Blower skid to feed it.</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Not aerated — no air pipe from a powered blower</span>
                  <span className="text-[11px] text-slate-400">Connect an Air pipe (blower → this diffuser) and power the blower with a Power cable.</span>
                </>
              )
            ) : needsPower ? (
              powered ? (
                <>
                  <span className="text-xs font-bold text-emerald-300">Powered — cable live</span>
                  <span className="text-[11px] text-slate-400">Machine will run. Cut its Power cable and it goes dark (red glow).</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Unpowered — needs a Power cable on this tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable to this tile to energize it. In-world it glows red while dark.</span>
                </>
              )
            ) : (
              <span className="text-xs font-bold text-slate-300">Passive — needs no power</span>
            )}
            {zone && def.mounting === 'in_basin' && (
              <span className="text-[10px] text-slate-400 mt-1">
                {powered || isDiffuser ? 'This compartment\'s health depends on a powered mixer in the same zone.' : 'Place a powered mixer in this zone to keep it aerobic.'}
              </span>
            )}
          </div>
        </div>

        {/* Specs */}
        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div className="p-2.5 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Installed Cost</span>
            <span className="text-sm font-bold text-emerald-400">${def.capexUsd.toLocaleString()}</span>
            <span className="text-[10px] text-slate-500">{def.powerKw} kW · ${def.opexUsdPerDay}/day</span>
          </div>
          <div className="p-2.5 rounded-xl bg-slate-800/70 border border-slate-700 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400">Tile</span>
            <span className="text-sm font-bold text-sky-300">({item.x}, {item.y})</span>
            <span className="text-[10px] text-slate-500 flex items-center gap-1">
              <Droplets size={10} /> {def.mounting === 'in_basin' ? 'Wet-mounted' : 'Dry-installed'}
            </span>
          </div>
        </div>

        <p className="text-xs text-slate-400 bg-slate-800/50 p-2.5 rounded-xl border border-slate-700/60">{def.blurb}</p>

        <button
          onClick={() => { SoundManager.playDemolish(); onDemolish(item.id); }}
          className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold transition"
        >
          <Trash2 size={14} /> <span>Remove Equipment (Refund +${refund.toLocaleString()})</span>
        </button>
      </div>
    </div>
  );
};
