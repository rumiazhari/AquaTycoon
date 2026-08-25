import React from 'react';
import { 
  X, Zap, Activity, Trash2, Gauge, 
  Droplets, Flame, Sliders, CheckCircle2 
} from 'lucide-react';
import { PlacedUnit } from '../types/simulation';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { SoundManager } from '../audio/SoundManager';

interface UnitInspectorProps {
  unit: PlacedUnit;
  onClose: () => void;
  onUpdateParams: (unitId: string, paramKey: string, value: number) => void;
  onDemolish: (unitId: string) => void;
}

export const UnitInspector: React.FC<UnitInspectorProps> = ({
  unit,
  onClose,
  onUpdateParams,
  onDemolish
}) => {
  const def = UNIT_DEFINITIONS[unit.typeId];
  if (!def) return null;

  const inlet = unit.lastInletQuality;
  const outlet = unit.lastOutletQuality;
  const hasFlow = inlet && inlet.flowRate > 0.1;

  const refund = Math.round(def.capex * 0.7);

  // Pollutant comparison bar component
  const renderComparisonBar = (label: string, inVal: number, outVal: number, unitStr: string) => {
    const maxVal = Math.max(1, inVal, outVal);
    const inPct = Math.min(100, (inVal / maxVal) * 100);
    const outPct = Math.min(100, (outVal / maxVal) * 100);
    const removal = inVal > 0 ? (((inVal - outVal) / inVal) * 100).toFixed(0) : '0';

    return (
      <div className="flex flex-col gap-1 text-xs">
        <div className="flex items-center justify-between text-slate-300 font-mono">
          <span>{label}</span>
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className="text-slate-400">{inVal.toFixed(1)}</span>
            <span className="text-slate-600">→</span>
            <span className={Number(removal) > 0 ? 'text-emerald-400 font-bold' : 'text-slate-200'}>
              {outVal.toFixed(1)} {unitStr}
            </span>
            {Number(removal) > 0 && (
              <span className="text-[10px] px-1 rounded bg-emerald-500/20 text-emerald-400 font-bold">
                -{removal}%
              </span>
            )}
          </div>
        </div>

        {/* Visual Dual Bars */}
        <div className="flex flex-col gap-0.5">
          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-amber-500/70 rounded-full" style={{ width: `${inPct}%` }} />
          </div>
          <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
            <div className="h-full bg-cyan-400 rounded-full" style={{ width: `${outPct}%` }} />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="absolute top-16 right-4 z-20 w-96 bg-cyber-card/95 border border-slate-700/90 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[82vh] animate-in fade-in slide-in-from-right-4 duration-200">
      
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 border-b border-slate-700/80">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-cyan-400 font-bold">
            {def.category} Unit
          </div>
          <h2 className="text-sm font-bold text-slate-100">{def.name}</h2>
        </div>
        <button
          onClick={() => { SoundManager.playClick(); onClose(); }}
          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition"
        >
          <X size={15} />
        </button>
      </div>

      {/* Content Body */}
      <div className="p-4 flex flex-col gap-4 overflow-y-auto scrollbar-thin">
        
        {/* Real-time Status & Removal Efficiency Card */}
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400 font-mono">Process Efficiency</span>
            <div className="flex items-center gap-1.5">
              <Activity size={16} className="text-cyan-400" />
              <span className="text-base font-extrabold font-mono text-slate-100">
                {unit.efficiencyRating}%
              </span>
            </div>
            <span className="text-[10px] text-emerald-400 flex items-center gap-1">
              <CheckCircle2 size={10} /> Active & Steady
            </span>
          </div>

          <div className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col gap-1">
            <span className="text-[10px] text-slate-400 font-mono">Power & Operating Cost</span>
            <div className="flex items-center gap-1.5">
              <Zap size={16} className="text-amber-400" />
              <span className="text-sm font-extrabold font-mono text-amber-300">
                {unit.lastPowerKwActual.toFixed(1)} kW
              </span>
            </div>
            <span className="text-[10px] text-slate-400 font-mono">
              ${(unit.lastOpexActual || 0).toFixed(0)}/day
            </span>
          </div>
        </div>

        {/* Biogas Generation (if Anaerobic Digester) */}
        {unit.typeId === 'anaerobic_digester' && unit.lastGasProducedM3Day !== undefined && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/40 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="text-amber-400 animate-pulse" size={18} />
              <div>
                <div className="text-xs font-bold text-amber-300 font-mono">
                  {unit.lastGasProducedM3Day.toFixed(1)} m³/day Biogas (CH₄)
                </div>
                <div className="text-[10px] text-emerald-400 font-mono">
                  Generating Green Renewable Power!
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Biological Metrics (MLSS / DO / SVI) */}
        {unit.dissolvedOxygenActual !== undefined && (
          <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col gap-2">
            <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Gauge size={14} className="text-cyan-400" /> Biological State Metrics
            </span>
            <div className="grid grid-cols-3 gap-2 text-center font-mono">
              <div className="p-1.5 rounded bg-slate-950/60">
                <div className="text-[10px] text-slate-400">DO</div>
                <div className="text-xs font-bold text-cyan-300">{unit.dissolvedOxygenActual.toFixed(2)} mg/L</div>
              </div>
              <div className="p-1.5 rounded bg-slate-950/60">
                <div className="text-[10px] text-slate-400">MLSS</div>
                <div className="text-xs font-bold text-amber-300">{unit.mlssActual || 3200} mg/L</div>
              </div>
              <div className="p-1.5 rounded bg-slate-950/60">
                <div className="text-[10px] text-slate-400">SVI</div>
                <div className="text-xs font-bold text-emerald-300">{unit.sviActual || 105} mL/g</div>
              </div>
            </div>
          </div>
        )}

        {/* Water Quality Mass-Balance (Inlet vs Outlet) */}
        <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-slate-900/80 border border-slate-800">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
            <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Droplets size={14} className="text-sky-400" /> Live Mass Balance
            </span>
            <span className="text-[10px] font-mono text-cyan-400">
              Flow: {inlet ? inlet.flowRate.toFixed(0) : 0} m³/d
            </span>
          </div>

          {hasFlow ? (
            <div className="flex flex-col gap-2">
              {renderComparisonBar('BOD₅', inlet.bod, outlet.bod, 'mg/L')}
              {renderComparisonBar('COD', inlet.cod, outlet.cod, 'mg/L')}
              {renderComparisonBar('TSS', inlet.tss, outlet.tss, 'mg/L')}
              {renderComparisonBar('Total Nitrogen', inlet.tn, outlet.tn, 'mg/L')}
              {renderComparisonBar('Total Phosphorus', inlet.tp, outlet.tp, 'mg/L')}
              {renderComparisonBar('Pathogens', inlet.pathogens, outlet.pathogens, 'CFU')}
            </div>
          ) : (
            <div className="text-xs text-slate-400 text-center py-3 font-mono">
              Connect pipes to feed wastewater stream
            </div>
          )}
        </div>

        {/* Engineering Parameters & Tuning Sliders */}
        {def.paramDefinitions.length > 0 && (
          <div className="flex flex-col gap-3 p-3 rounded-xl bg-slate-900/80 border border-slate-800">
            <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
              <Sliders size={14} className="text-purple-400" /> Engineering Controls
            </span>

            {def.paramDefinitions.map(param => {
              const currentVal = unit.customParams[param.key] ?? param.defaultValue;
              return (
                <div key={param.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-xs font-mono text-slate-300">
                    <span>{param.label}</span>
                    <span className="text-cyan-400 font-bold">{currentVal} {param.unit}</span>
                  </div>
                  <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={currentVal}
                    onChange={(e) => onUpdateParams(unit.instanceId, param.key, parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                  />
                  <span className="text-[10px] text-slate-400">{param.description}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Demolish Button */}
        {unit.typeId !== 'influent_inlet' && unit.typeId !== 'effluent_outfall' && (
          <button
            onClick={() => {
              SoundManager.playDemolish();
              onDemolish(unit.instanceId);
            }}
            className="flex items-center justify-center gap-2 p-2.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-bold transition"
          >
            <Trash2 size={14} />
            <span>Demolish Unit (Refund +${refund.toLocaleString()})</span>
          </button>
        )}
      </div>
    </div>
  );
};
