import React, { useState } from 'react';
import {
  MousePointer, Cable, Trash2, RotateCw, Filter,
  Layers, Activity, Sparkles, Recycle, ArrowRightLeft,
  Info, Star, Zap
} from 'lucide-react';
import { UnitCategory, UnitDefinition, UnitTypeId } from '../types/simulation';
import { ToolMode } from '../types/graphics';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { SoundManager } from '../audio/SoundManager';
import { TechNode } from '../types/game';

interface BuildToolbarProps {
  toolMode: ToolMode;
  onSetToolMode: (mode: ToolMode) => void;
  selectedUnitTypeId: UnitTypeId | null;
  onSelectUnitTypeId: (typeId: UnitTypeId | null) => void;
  currentRotation: 0 | 90 | 180 | 270;
  onRotate: () => void;
  techTree: TechNode[];
  playerCash: number;
  isSandbox: boolean;
  availableUnitIds: string[];
  suggestedUnitTypeId?: UnitTypeId | null;
}

const CATEGORIES: { id: UnitCategory; label: string; icon: React.ReactNode }[] = [
  { id: 'preliminary', label: '1. Preliminary', icon: <Filter size={14} /> },
  { id: 'primary', label: '2. Primary', icon: <Layers size={14} /> },
  { id: 'secondary', label: '3. Biological', icon: <Activity size={14} /> },
  { id: 'tertiary', label: '4. Tertiary / UV', icon: <Sparkles size={14} /> },
  { id: 'sludge', label: '5. Sludge & Biogas', icon: <Recycle size={14} /> },
  { id: 'hydraulics', label: '6. Hydraulics', icon: <ArrowRightLeft size={14} /> },
  { id: 'power', label: '7. Power & Site', icon: <Zap size={14} /> }
];

export const BuildToolbar: React.FC<BuildToolbarProps> = ({
  toolMode,
  onSetToolMode,
  selectedUnitTypeId,
  onSelectUnitTypeId,
  currentRotation,
  onRotate,
  techTree,
  playerCash,
  isSandbox,
  availableUnitIds,
  suggestedUnitTypeId
}) => {
  const [activeCategory, setActiveCategory] = useState<UnitCategory>('preliminary');
  const [hoveredDef, setHoveredDef] = useState<UnitDefinition | null>(null);

  // Filter units belonging to active category & level unlocked
  const categoryUnits = Object.values(UNIT_DEFINITIONS).filter(def => {
    if (def.category !== activeCategory) return false;
    if (def.id === 'influent_inlet' || def.id === 'effluent_outfall') return false; // Preplaced
    if (!isSandbox && !availableUnitIds.includes(def.id)) return false;
    return true;
  });

  const isUnitUnlocked = (def: UnitDefinition) => {
    if (isSandbox) return true;
    if (def.unlockedByDefault) return true;
    if (!def.requiredTechId) return true;
    const node = techTree.find(n => n.id === def.requiredTechId);
    return node ? node.unlocked : false;
  };

  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 pointer-events-none w-full max-w-5xl px-4">
      {/* Unit Hover Information Tooltip */}
      {hoveredDef && (
        <div className="bg-slate-900/95 backdrop-blur-md border border-cyan-500/40 rounded-xl px-4 py-2.5 shadow-2xl pointer-events-auto text-xs flex flex-col gap-1 w-full max-w-xl animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="flex items-center justify-between">
            <span className="font-bold text-cyan-300 text-sm">{hoveredDef.name}</span>
            <div className="flex items-center gap-3 font-mono text-slate-300">
              <span className="text-emerald-400 font-bold">${hoveredDef.capex.toLocaleString()}</span>
              <span className="text-slate-400">Size: {hoveredDef.footprint[0]}x{hoveredDef.footprint[1]}</span>
              <span className="text-amber-300">Power: {hoveredDef.powerConsumptionKw} kW</span>
            </div>
          </div>
          <p className="text-slate-300">{hoveredDef.description}</p>
          <div className="text-[11px] text-cyan-400/90 font-mono bg-cyan-950/40 px-2 py-1 rounded border border-cyan-800/40 flex items-start gap-1.5 mt-0.5">
            <Info size={13} className="shrink-0 mt-0.5" />
            <span>{hoveredDef.engineeringInfo}</span>
          </div>
        </div>
      )}

      {/* Main Glassmorphic Build Bar */}
      <div className="bg-slate-900/95 backdrop-blur-md border border-slate-700/80 rounded-2xl p-2 shadow-2xl pointer-events-auto flex flex-col gap-2 w-full">
        
        {/* Top: Category Tabs & Global Tool Modes */}
        <div className="flex items-center justify-between border-b border-slate-700/60 pb-2">
          {/* Tool Modes: Select, Pipe, Demolish */}
          <div className="flex items-center gap-1 bg-slate-950/90 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => {
                SoundManager.playClick();
                onSetToolMode('select');
                onSelectUnitTypeId(null);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                toolMode === 'select'
                  ? 'bg-sky-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
              title="Inspect & Configure Placed Tanks"
            >
              <MousePointer size={14} />
              <span>Inspect</span>
            </button>

            <button
              onClick={() => {
                SoundManager.playClick();
                onSetToolMode('connect_pipe');
                onSelectUnitTypeId(null);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                toolMode === 'connect_pipe'
                  ? 'bg-cyan-400 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
              title="Pipes: LMB unit A → unit B connects. LMB same unit switches output port. LMB again removes a pipe. RMB cancels. Ctrl+Z / Ctrl+Y undo/redo."
            >
              <Cable size={14} />
              <span>Pipes</span>
            </button>

            <button
              onClick={() => {
                SoundManager.playClick();
                onSetToolMode('demolish');
                onSelectUnitTypeId(null);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                toolMode === 'demolish'
                  ? 'bg-rose-500 text-slate-950 shadow-md font-bold'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
              title="Demolish Unit: Click unit to demolish (70% cash refund)"
            >
              <Trash2 size={14} />
              <span>Demolish</span>
            </button>
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto">
            {CATEGORIES.map(cat => (
              <button
                key={cat.id}
                onClick={() => {
                  SoundManager.playClick();
                  setActiveCategory(cat.id);
                }}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold transition whitespace-nowrap ${
                  activeCategory === cat.id
                    ? 'bg-slate-800 text-sky-400 border border-sky-500/40 shadow-inner'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                {cat.icon}
                <span>{cat.label}</span>
              </button>
            ))}
          </div>

          {/* Rotation Button */}
          <button
            onClick={() => {
              SoundManager.playClick();
              onRotate();
            }}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-sky-300 border border-slate-700 transition"
            title="Rotate placement direction (Shortcut: R)"
          >
            <RotateCw size={13} />
            <span>Rotate ({currentRotation}°)</span>
          </button>
        </div>

        {/* Bottom: Unit Card Palette for Active Category */}
        <div className="flex items-center gap-2 overflow-x-auto py-1 scrollbar-thin">
          {categoryUnits.map(def => {
            const unlocked = isUnitUnlocked(def);
            const canAfford = isSandbox || playerCash >= def.capex;
            const isSelected = toolMode === 'place_unit' && selectedUnitTypeId === def.id;
            const isSuggested = suggestedUnitTypeId === def.id;

            return (
              <button
                key={def.id}
                disabled={!unlocked}
                onMouseEnter={() => setHoveredDef(def)}
                onMouseLeave={() => setHoveredDef(null)}
                onClick={() => {
                  if (!unlocked) return;
                  SoundManager.playClick();
                  onSetToolMode('place_unit');
                  onSelectUnitTypeId(def.id);
                }}
                className={`group relative flex flex-col items-start p-2.5 rounded-xl min-w-[170px] max-w-[190px] border transition text-left ${
                  !unlocked
                    ? 'opacity-40 bg-slate-950/60 border-slate-800 cursor-not-allowed'
                    : isSelected
                    ? 'bg-sky-500/20 border-cyan-400 ring-2 ring-cyan-400/50 shadow-lg'
                    : isSuggested
                    ? 'bg-sky-950/40 border-sky-400/80 ring-1 ring-sky-400/40'
                    : canAfford
                    ? 'bg-slate-900/90 border-slate-700/80 hover:border-sky-500/60 hover:bg-slate-800/90'
                    : 'bg-slate-900/60 border-rose-900/40 hover:bg-slate-900/80'
                }`}
              >
                {/* Suggested Star Badge */}
                {isSuggested && (
                  <div className="absolute -top-2 right-2 px-1.5 py-0.5 rounded-full bg-gradient-to-r from-amber-500 to-yellow-400 text-slate-950 text-[9px] font-bold font-mono flex items-center gap-0.5 shadow-md animate-bounce">
                    <Star size={10} fill="currentColor" />
                    <span>Recommended</span>
                  </div>
                )}

                <div className="flex items-center justify-between w-full">
                  <span className="font-bold text-xs text-slate-200 group-hover:text-cyan-300 truncate">
                    {def.name}
                  </span>
                  {!unlocked && (
                    <span className="text-[9px] px-1 py-0.5 rounded bg-slate-800 text-amber-400 font-mono">
                      Locked
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between w-full mt-1 font-mono text-[11px]">
                  <span className={canAfford ? 'text-emerald-400 font-bold' : 'text-rose-400'}>
                    ${def.capex.toLocaleString()}
                  </span>
                  <span className="text-slate-400 text-[10px]">
                    {def.footprint[0]}x{def.footprint[1]} grid
                  </span>
                </div>

                <div className="flex items-center justify-between w-full text-[10px] text-slate-400 font-mono mt-0.5">
                  <span className="text-amber-300/90">{def.powerConsumptionKw} kW</span>
                  <span className="text-slate-400">${def.baseOpexPerDay}/d</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
