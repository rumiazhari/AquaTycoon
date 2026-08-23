import React from 'react';
import { X, GitBranch, ShieldCheck } from 'lucide-react';
import { GameState } from '../gameplay/GameManager';
import { UNIT_DEFINITIONS } from '../sim/UnitProcessModels';
import { SoundManager } from '../audio/SoundManager';

interface PlantFlowDiagramProps {
  gameState: GameState;
  onClose: () => void;
}

export const PlantFlowDiagram: React.FC<PlantFlowDiagramProps> = ({ gameState, onClose }) => {
  const { units, pipes, finalEffluent, currentLevel, overallStats } = gameState;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-5xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900/90 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-teal-500/20 text-teal-400">
              <GitBranch size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Process Flow Diagram (PFD / P&ID)</h2>
              <p className="text-xs text-slate-400 font-mono">
                Active Hydraulic Network Topology & Mass-Balance
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

        {/* Content */}
        <div className="p-6 flex flex-col gap-6 overflow-y-auto scrollbar-thin">
          
          {/* Top Plant Removal Summary */}
          <div className="grid grid-cols-5 gap-3">
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">BOD₅ Removal</span>
              <div className="text-base font-extrabold text-cyan-400 font-mono">
                {overallStats.overallBodRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">COD Removal</span>
              <div className="text-base font-extrabold text-sky-400 font-mono">
                {overallStats.overallCodRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">TSS Removal</span>
              <div className="text-base font-extrabold text-teal-400 font-mono">
                {overallStats.overallTssRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">Total Nitrogen</span>
              <div className="text-base font-extrabold text-purple-400 font-mono">
                {overallStats.overallTnRemoval.toFixed(1)}%
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 text-center">
              <span className="text-[10px] text-slate-400 font-mono">Total Phosphorus</span>
              <div className="text-base font-extrabold text-amber-400 font-mono">
                {overallStats.overallTpRemoval.toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Unit Train Sequence Flow */}
          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 font-mono">
              Treatment Units Train ({units.length} Placed Units, {pipes.length} Pipe Connections)
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {units.map(unit => {
                const def = UNIT_DEFINITIONS[unit.typeId];
                if (!def) return null;
                const outWater = unit.lastOutletQuality;

                return (
                  <div
                    key={unit.instanceId}
                    className="p-3.5 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-col justify-between gap-2"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[9px] font-mono uppercase text-cyan-400 font-bold">
                          {def.category}
                        </div>
                        <div className="text-xs font-bold text-slate-100">{def.name}</div>
                      </div>
                      <span className="text-xs font-bold font-mono px-2 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20">
                        {unit.efficiencyRating}% Eff.
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-1 text-[11px] font-mono p-2 rounded bg-slate-950/60 text-slate-300">
                      <div>BOD: <span className="text-cyan-300">{outWater?.bod.toFixed(1) || 0}</span></div>
                      <div>TSS: <span className="text-teal-300">{outWater?.tss.toFixed(1) || 0}</span></div>
                      <div>TN: <span className="text-purple-300">{outWater?.tn.toFixed(1) || 0}</span></div>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono">
                      <span>⚡ {unit.lastPowerKwActual.toFixed(1)} kW</span>
                      <span>💰 ${(unit.lastOpexActual || 0).toFixed(0)}/day</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Effluent Standards Comparison Table */}
          <div className="flex flex-col gap-2 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
            <h3 className="text-xs font-bold text-slate-300 font-mono uppercase flex items-center gap-2">
              <ShieldCheck size={14} className="text-emerald-400" />
              Final Outfall vs Regulatory Effluent Standards
            </h3>

            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono text-left">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="pb-2 font-medium">Parameter</th>
                    <th className="pb-2 font-medium">Raw Influent</th>
                    <th className="pb-2 font-medium">Treated Effluent</th>
                    <th className="pb-2 font-medium">Legal Limit</th>
                    <th className="pb-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-200">
                  <tr>
                    <td className="py-2 font-bold">BOD₅</td>
                    <td>{currentLevel.influentSpec.bod} mg/L</td>
                    <td className="text-cyan-300 font-bold">{finalEffluent.bod.toFixed(1)} mg/L</td>
                    <td>≤ {currentLevel.standards.maxBod} mg/L</td>
                    <td>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${finalEffluent.bod <= currentLevel.standards.maxBod ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                        {finalEffluent.bod <= currentLevel.standards.maxBod ? 'PASS' : 'FAIL'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 font-bold">COD</td>
                    <td>{currentLevel.influentSpec.cod} mg/L</td>
                    <td className="text-cyan-300 font-bold">{finalEffluent.cod.toFixed(1)} mg/L</td>
                    <td>≤ {currentLevel.standards.maxCod} mg/L</td>
                    <td>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${finalEffluent.cod <= currentLevel.standards.maxCod ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                        {finalEffluent.cod <= currentLevel.standards.maxCod ? 'PASS' : 'FAIL'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 font-bold">TSS</td>
                    <td>{currentLevel.influentSpec.tss} mg/L</td>
                    <td className="text-cyan-300 font-bold">{finalEffluent.tss.toFixed(1)} mg/L</td>
                    <td>≤ {currentLevel.standards.maxTss} mg/L</td>
                    <td>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${finalEffluent.tss <= currentLevel.standards.maxTss ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                        {finalEffluent.tss <= currentLevel.standards.maxTss ? 'PASS' : 'FAIL'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 font-bold">Total Nitrogen (TN)</td>
                    <td>{currentLevel.influentSpec.tn} mg/L</td>
                    <td className="text-cyan-300 font-bold">{finalEffluent.tn.toFixed(1)} mg/L</td>
                    <td>≤ {currentLevel.standards.maxTn} mg/L</td>
                    <td>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${finalEffluent.tn <= currentLevel.standards.maxTn ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                        {finalEffluent.tn <= currentLevel.standards.maxTn ? 'PASS' : 'FAIL'}
                      </span>
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 font-bold">Total Phosphorus (TP)</td>
                    <td>{currentLevel.influentSpec.tp} mg/L</td>
                    <td className="text-cyan-300 font-bold">{finalEffluent.tp.toFixed(2)} mg/L</td>
                    <td>≤ {currentLevel.standards.maxTp} mg/L</td>
                    <td>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${finalEffluent.tp <= currentLevel.standards.maxTp ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                        {finalEffluent.tp <= currentLevel.standards.maxTp ? 'PASS' : 'FAIL'}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
