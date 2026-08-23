import React from 'react';
import { X, Map, ChevronRight, Play } from 'lucide-react';
import { CAMPAIGN_LEVELS } from '../gameplay/LevelsData';
import { SoundManager } from '../audio/SoundManager';

interface LevelModalProps {
  currentLevelId: number;
  onSelectLevel: (levelIndex: number, isSandbox: boolean) => void;
  onClose: () => void;
}

export const LevelModal: React.FC<LevelModalProps> = ({ currentLevelId, onSelectLevel, onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900/90 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400">
              <Map size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Campaign Stages & Scenarios</h2>
              <p className="text-xs text-slate-400 font-mono">
                Select an environmental engineering challenge or enter Free Sandbox Mode
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

        {/* Level List */}
        <div className="p-6 flex flex-col gap-4 overflow-y-auto scrollbar-thin">
          
          {/* Sandbox Mode Card */}
          <div className="p-4 rounded-xl bg-gradient-to-r from-cyan-950/40 via-sky-950/30 to-slate-900/80 border border-cyan-500/40 flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500 text-slate-950 font-mono uppercase">
                  Sandbox
                </span>
                <h3 className="text-sm font-bold text-slate-100">Free Engineering Sandbox</h3>
              </div>
              <p className="text-xs text-slate-300">
                Infinite budget ($9,999,999), all 22+ units unlocked, custom influent generator, weather storms & chemical spills!
              </p>
            </div>
            <button
              onClick={() => {
                SoundManager.playClick();
                onSelectLevel(0, true);
                onClose();
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold text-xs shadow-lg transition"
            >
              <Play size={14} />
              <span>Launch Sandbox</span>
            </button>
          </div>

          <div className="flex flex-col gap-3">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 font-mono">
              Campaign Levels
            </h3>

            {CAMPAIGN_LEVELS.map((lvl, index) => {
              const isCurrent = lvl.id === currentLevelId;

              return (
                <div
                  key={lvl.id}
                  className={`p-4 rounded-xl border transition flex flex-col gap-3 ${
                    isCurrent
                      ? 'bg-slate-800/90 border-sky-400 ring-1 ring-sky-400/40 shadow-lg'
                      : 'bg-slate-900/80 border-slate-800 hover:border-slate-700 hover:bg-slate-800/50'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-slate-950/80 border border-slate-700 flex items-center justify-center font-mono font-bold text-sky-400 text-sm">
                        {lvl.code}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-slate-100">{lvl.title}</h4>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-amber-400 font-mono font-bold">
                            {lvl.difficulty}
                          </span>
                        </div>
                        <p className="text-xs text-slate-400 font-mono">{lvl.subtitle}</p>
                      </div>
                    </div>

                    <button
                      onClick={() => {
                        SoundManager.playClick();
                        onSelectLevel(index, false);
                        onClose();
                      }}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-xs transition"
                    >
                      <span>Play Stage</span>
                      <ChevronRight size={14} />
                    </button>
                  </div>

                  <p className="text-xs text-slate-300 bg-slate-950/50 p-2.5 rounded-lg border border-slate-800/60">
                    {lvl.briefing}
                  </p>

                  <div className="flex items-center justify-between text-xs font-mono text-slate-400 pt-1">
                    <div className="flex items-center gap-3">
                      <span className="text-emerald-400">Budget: ${lvl.startingBudget.toLocaleString()}</span>
                      <span className="text-cyan-400">Tariff: ${lvl.tariffPerM3}/m³</span>
                      <span className="text-amber-300">Reward: +${lvl.bonusReward.toLocaleString()}</span>
                    </div>
                    <span>Map: {lvl.mapSize[0]}x{lvl.mapSize[1]} tiles</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
