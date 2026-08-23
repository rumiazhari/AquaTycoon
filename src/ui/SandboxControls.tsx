import React from 'react';
import { X, Sliders, CloudRain, AlertTriangle, RefreshCw } from 'lucide-react';
import { WaterQuality } from '../types/simulation';
import { SoundManager } from '../audio/SoundManager';
import { createInfluentWater } from '../sim/WaterStream';

interface SandboxControlsProps {
  influent: WaterQuality;
  onUpdateInfluent: (updated: WaterQuality) => void;
  onClose: () => void;
}

export const SandboxControls: React.FC<SandboxControlsProps> = ({
  influent,
  onUpdateInfluent,
  onClose
}) => {
  const triggerStormEvent = () => {
    SoundManager.playWarning();
    onUpdateInfluent({
      ...influent,
      flowRate: influent.flowRate * 2.5,
      tss: influent.tss * 1.8,
      bod: influent.bod * 0.7 // Dilution by storm
    });
  };

  const triggerChemicalSpill = () => {
    SoundManager.playWarning();
    onUpdateInfluent({
      ...influent,
      toxicIndex: 85,
      cod: influent.cod * 2.8,
      ph: 4.5
    });
  };

  const resetToStandardDomestic = () => {
    SoundManager.playClick();
    onUpdateInfluent(createInfluentWater());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900/90 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/20 text-amber-400">
              <Sliders size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Sandbox Simulator Controls</h2>
              <p className="text-xs text-slate-400 font-mono">
                Tune raw wastewater influent characteristics & trigger environmental stress events
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

        {/* Sliders & Stress Triggers */}
        <div className="p-6 flex flex-col gap-5 overflow-y-auto scrollbar-thin">
          
          {/* Quick Scenario Buttons */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-bold text-slate-400 uppercase font-mono">Environmental Stress Events</span>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={triggerStormEvent}
                className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 text-xs font-bold font-mono transition"
              >
                <CloudRain size={15} />
                <span>Storm Surge (2.5x Q)</span>
              </button>

              <button
                onClick={triggerChemicalSpill}
                className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold font-mono transition"
              >
                <AlertTriangle size={15} />
                <span>Toxic Spill (pH 4.5)</span>
              </button>

              <button
                onClick={resetToStandardDomestic}
                className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold font-mono transition"
              >
                <RefreshCw size={15} />
                <span>Reset Standard</span>
              </button>
            </div>
          </div>

          {/* Influent Parameters */}
          <div className="flex flex-col gap-4 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
            <span className="text-xs font-bold text-slate-300 uppercase font-mono">Raw Influent Properties</span>

            {/* Flow Rate */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-300">Flow Rate (Q)</span>
                <span className="text-cyan-400 font-bold">{influent.flowRate.toLocaleString()} m³/day</span>
              </div>
              <input
                type="range"
                min={500}
                max={30000}
                step={500}
                value={influent.flowRate}
                onChange={e => onUpdateInfluent({ ...influent, flowRate: parseFloat(e.target.value) })}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            {/* BOD */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-300">Biochemical Oxygen Demand (BOD₅)</span>
                <span className="text-cyan-400 font-bold">{influent.bod} mg/L</span>
              </div>
              <input
                type="range"
                min={50}
                max={2500}
                step={25}
                value={influent.bod}
                onChange={e => onUpdateInfluent({ ...influent, bod: parseFloat(e.target.value), cod: parseFloat(e.target.value) * 2.1 })}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            {/* TSS */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-300">Total Suspended Solids (TSS)</span>
                <span className="text-cyan-400 font-bold">{influent.tss} mg/L</span>
              </div>
              <input
                type="range"
                min={30}
                max={1500}
                step={20}
                value={influent.tss}
                onChange={e => onUpdateInfluent({ ...influent, tss: parseFloat(e.target.value) })}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            {/* Ammonia Nitrogen */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-300">Ammonia Nitrogen (NH₄-N)</span>
                <span className="text-cyan-400 font-bold">{influent.nh4} mg/L</span>
              </div>
              <input
                type="range"
                min={5}
                max={120}
                step={2}
                value={influent.nh4}
                onChange={e => onUpdateInfluent({ ...influent, nh4: parseFloat(e.target.value), tn: parseFloat(e.target.value) * 1.3 })}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            {/* Total Phosphorus */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-300">Total Phosphorus (TP)</span>
                <span className="text-cyan-400 font-bold">{influent.tp} mg/L</span>
              </div>
              <input
                type="range"
                min={1}
                max={25}
                step={0.5}
                value={influent.tp}
                onChange={e => onUpdateInfluent({ ...influent, tp: parseFloat(e.target.value) })}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
              />
            </div>

            {/* Toxic Index */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-slate-300">Toxic Shock Index</span>
                <span className="text-rose-400 font-bold">{influent.toxicIndex}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={influent.toxicIndex}
                onChange={e => onUpdateInfluent({ ...influent, toxicIndex: parseFloat(e.target.value) })}
                className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-400"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
