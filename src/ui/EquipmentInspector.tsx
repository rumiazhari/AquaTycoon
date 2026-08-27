import React from 'react';
import { X, Wind, Trash2, Droplets, Fan, Cog, Waves, AlertTriangle, CheckCircle2, Columns3, ShieldCheck, Hexagon, Gauge, Activity, Ruler, FlaskConical, Beaker, Filter, Cylinder, Move, RotateCw, Flame } from 'lucide-react';
import { EQUIPMENT_TYPES } from '../design/ProcessEquipment';
import type { ProcessEquipmentItem } from '../design/ProcessEquipment';
import type { BasinZone } from '../design/BasinZone';
import { SoundManager } from '../audio/SoundManager';

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  fine_bubble_diffuser: Waves,
  submersible_mixer: Fan,
  process_pump: Cog,
  rotary_blower: Wind,
  membrane_cassette: ShieldCheck,
  mbbr_carrier: Hexagon,
  do_probe: Activity,
  flow_meter: Gauge,
  level_sensor: Ruler,
  chemical_storage_tank: FlaskConical,
  chemical_dosing_pump: Beaker,
  ro_skid: Filter,
  brine_tank: Cylinder,
  biogas_chp_skid: Flame,
};

interface EquipmentInspectorProps {
  item: ProcessEquipmentItem;
  powered: boolean;
  aerated?: boolean | null;
  zone?: BasinZone | null;
  filtrationLive?: boolean | null;
  filtrationDegraded?: boolean | null;
  carrierActive?: boolean | null;
  carrierAerated?: boolean | null;
  dosingActive?: boolean | null;
  dosingPowered?: boolean | null;
  storagePowered?: boolean | null;
  flowM3d?: number;
  moving?: boolean;
  onClose: () => void;
  onDemolish: (id: string) => void;
  onMove?: (id: string) => void;
  onRotate?: (id: string) => void;
}

const ROLE_TONE: Record<string, string> = {
  anoxic: 'bg-sky-950/40 border-sky-500/30 text-sky-300',
  aerobic: 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300',
  settling: 'bg-amber-950/40 border-amber-500/30 text-amber-300',
  buffer: 'bg-slate-800 border-slate-600 text-slate-300',
};

export const EquipmentInspector: React.FC<EquipmentInspectorProps> = ({ item, powered, aerated, zone, filtrationLive, filtrationDegraded, carrierActive, carrierAerated, dosingActive, dosingPowered, storagePowered: _storagePowered, flowM3d, moving, onClose, onDemolish, onMove, onRotate }) => {
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
            ) : item.typeId === 'membrane_cassette' ? (
              !powered ? (
                <>
                  <span className="text-xs font-bold text-amber-300">Unpowered — needs a Power cable on this tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable here to energize the permeate pump.</span>
                </>
              ) : filtrationLive ? (
                <>
                  <span className="text-xs font-bold text-cyan-300">Filtering — membrane live (cyan shimmer)</span>
                  <span className="text-[11px] text-slate-400">Absolute barrier: TSS → near-zero in this zone. Keep the zone mixed to prevent fouling.</span>
                </>
              ) : filtrationDegraded ? (
                <>
                  <span className="text-xs font-bold text-amber-300">Fouled — zone needs a powered mixer</span>
                  <span className="text-[11px] text-slate-400">Membrane is powered but this zone is septic — add a mixer + power cable here to restore full filtration (amber → cyan).</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-emerald-300">Powered — filtration live</span>
                  <span className="text-[11px] text-slate-400">Membrane is filtering. Keep its zone mixed & aerated to prevent fouling.</span>
                </>
              )
            ) : item.typeId === 'mbbr_carrier' ? (
              carrierAerated ? (
                <>
                  <span className="text-xs font-bold text-cyan-300">Biofilm active — aerated zone (cyan shimmer)</span>
                  <span className="text-[11px] text-slate-400">Carriers are fluidised and aerated — BOD & TN removal boosted in this zone.</span>
                </>
              ) : carrierActive ? (
                <>
                  <span className="text-xs font-bold text-sky-300">Biofilm active — mixed zone (sky shimmer)</span>
                  <span className="text-[11px] text-slate-400">Carriers fluidised. Add an aerated diffuser in this zone for extra BOD/TN polish.</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Dormant — zone needs a powered mixer</span>
                  <span className="text-[11px] text-slate-400">Carriers settled on the floor — not fluidised. Place a powered mixer in this zone to activate biofilm.</span>
                </>
              )
            ) : (item.typeId === 'do_probe' || item.typeId === 'flow_meter' || item.typeId === 'level_sensor') ? (
              powered ? (
                <>
                  <span className="text-xs font-bold text-teal-300">Telemetry live — sensor powered (teal shimmer)</span>
                  <span className="text-[11px] text-slate-400">{item.typeId === 'do_probe' ? 'Reporting DO mg/L in this zone — feeds the Instrumented badge.' : item.typeId === 'flow_meter' ? 'Reporting m³/d on this ground tile — part of the instrumented plant.' : 'Reporting level/freeboard over this basin — part of the instrumented plant.'}</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Dark — needs a Power cable on this tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable here to bring this sensor online (red glow while dark, teal when live).</span>
                </>
              )
            ) : item.typeId === 'chemical_storage_tank' ? (
              powered ? (
                <>
                  <span className="text-xs font-bold text-lime-300">Chemical live — tank powered (lime shimmer)</span>
                  <span className="text-[11px] text-slate-400">Bulk ferric/alum feed online — boosts TP precipitation. Pair with a powered dosing pump in a mixed zone for full polish.</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Dark — needs a Power cable on this ground tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable here to keep the recirculation skid energized (red while dark, lime when live).</span>
                </>
              )
            ) : item.typeId === 'chemical_dosing_pump' ? (
              dosingActive ? (
                <>
                  <span className="text-xs font-bold text-lime-300">Dosing active — injecting coagulant (lime shimmer)</span>
                  <span className="text-[11px] text-slate-400">Coagulant precipitates TP in this mixed zone. Keep the zone mixed and powered for full 22% TP removal per pump.</span>
                  {flowM3d != null && flowM3d > 10 && (
                    <span className="text-[10px] font-mono text-lime-400 mt-1">Reagent {Math.round(flowM3d * 0.033).toLocaleString()} $/d at {Math.round(flowM3d).toLocaleString()} m³/d (60 mg/L × $0.55/kg) — scales with flow & pumps</span>
                  )}
                  {(!flowM3d || flowM3d <= 10) && (
                    <span className="text-[10px] font-mono text-slate-500 mt-1">Reagent cost scales with flow — connect influent to start dosing ($0.033/m³ per active pump)</span>
                  )}
                </>
              ) : dosingPowered ? (
                <>
                  <span className="text-xs font-bold text-amber-300">Dormant — zone needs a powered mixer</span>
                  <span className="text-[11px] text-slate-400">Pump is powered but its zone is septic — add a powered mixer in this zone to activate chemical TP polishing (amber → lime).</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Dark — needs a Power cable on this tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable here to energize the dosing skid (red while dark, lime when injecting).</span>
                </>
              )
            ) : item.typeId === 'ro_skid' ? (
              powered ? (
                <>
                  <span className="text-xs font-bold text-sky-300">RO live — tertiary barrier (cyan shimmer)</span>
                  <span className="text-[11px] text-slate-400">Spiral-wound RO polishing TSS/TP/salts to near-zero when powered. Pair with a brine tank for concentrate handling.</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Dark — needs a Power cable on this ground tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable here to energize the HP pump (red while dark, cyan when polishing). High power: 12 kW.</span>
                </>
              )
            ) : item.typeId === 'brine_tank' ? (
              powered ? (
                <>
                  <span className="text-xs font-bold text-amber-300">Brine handling live — tank recirculating (amber shimmer)</span>
                  <span className="text-[11px] text-slate-400">Bunded brine storage recirculating — handles RO concentrate for evaporation/hauling.</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Dark — needs a Power cable on this ground tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable here to keep the recirculation agitator live (red while dark, amber when active).</span>
                </>
              )
            ) : item.typeId === 'biogas_chp_skid' ? (
              powered ? (
                <>
                  <span className="text-xs font-bold text-emerald-300">CHP live — biogas to green power (emerald shimmer)</span>
                  <span className="text-[11px] text-slate-400">Containerized CHP burning digester biogas — ~14 kW green when grid-connected via Power cable and sludge loop closed (needs a digester + basin + flow). Stack to push over 50% self-sufficiency for the green dividend.</span>
                </>
              ) : (
                <>
                  <span className="text-xs font-bold text-amber-300">Dark — needs a Power cable on this ground tile</span>
                  <span className="text-[11px] text-slate-400">Run a Power cable here to export biogas power (red while dark, emerald when live). Ground-installed outside basins.</span>
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

        {/* P2: direct manipulation — relocate + rotate (free, same tile rules as placement; utilities must be removed first) */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => { SoundManager.playClick(); onMove?.(item.id); }}
            className={`flex items-center justify-center gap-1.5 p-2.5 rounded-xl border text-xs font-bold transition ${moving ? 'bg-cyan-600 border-cyan-500 text-white animate-pulse' : 'bg-sky-500/10 hover:bg-sky-500/20 border-sky-500/30 text-sky-300'}`}
          >
            <Move size={14} /> <span>{moving ? 'Click destination...' : 'Move'}</span>
          </button>
          <button
            onClick={() => { SoundManager.playClick(); onRotate?.(item.id); }}
            className="flex items-center justify-center gap-1.5 p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 text-xs font-bold transition"
          >
            <RotateCw size={14} /> <span>Rotate 90°</span>
          </button>
        </div>
        {moving && <span className="text-[10px] text-cyan-400 font-mono text-center">Click a valid tile to relocate — green = OK · red = blocked. Esc cancels. {(item.rotation ?? 0) !== 0 ? `Now at ${item.rotation}°` : `Facing ${item.rotation ?? 0}° — Rotate to turn.`}</span>}
        {!moving && (item.rotation ?? 0) !== 0 && <span className="text-[10px] text-slate-500 font-mono text-center">Facing {item.rotation}° · use Rotate to re-orient the machine in-world.</span>}
        {!moving && <span className="text-[10px] text-amber-400/80 font-mono text-center">Tip: drag the amber handle above the selected machine to move directly — free reposition with live green/red ghost (Esc cancels). Shift+Click to select multiple, then drag any handle to move the block as one ($/kW aggregated in ghost).</span>}

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
