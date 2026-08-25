import React from 'react';
import { X, Zap, CheckCircle2, Lock, Sparkles } from 'lucide-react';
import { TechNode } from '../types/game';
import { SoundManager } from '../audio/SoundManager';

interface TechTreeModalProps {
  techTree: TechNode[];
  playerCash: number;
  isSandbox: boolean;
  onUnlockTech: (techId: string) => void;
  onClose: () => void;
}

export const TechTreeModal: React.FC<TechTreeModalProps> = ({
  techTree,
  playerCash,
  isSandbox,
  onUnlockTech,
  onClose
}) => {
  const canUnlock = (node: TechNode) => {
    if (node.unlocked) return false;
    if (node.prerequisites.length > 0) {
      const allPrereqsMet = node.prerequisites.every(preId => {
        const pNode = techTree.find(n => n.id === preId);
        return pNode ? pNode.unlocked : false;
      });
      if (!allPrereqsMet) return false;
    }
    return isSandbox || playerCash >= node.cost;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950 animate-in fade-in duration-200">
      <div className="relative w-full max-w-4xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-purple-500/20 text-purple-400">
              <Zap size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Engineering Technology Tree</h2>
              <p className="text-xs text-slate-400 font-mono">
                Invest capital to research and unlock advanced bioreactors, membranes & resource recovery systems
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

        {/* Nodes Grid */}
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto scrollbar-thin">
          {techTree.map(node => {
            const unlockable = canUnlock(node);

            return (
              <div
                key={node.id}
                className={`p-4 rounded-xl border flex flex-col justify-between gap-3 transition ${
                  node.unlocked
                    ? 'bg-emerald-950/20 border-emerald-500/40 shadow-inner'
                    : unlockable
                    ? 'bg-slate-900 border-purple-500/60 ring-1 ring-purple-500/30'
                    : 'bg-slate-950/40 border-slate-800/80 opacity-60'
                }`}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider text-purple-400 font-bold">
                      {node.category}
                    </span>
                    {node.unlocked ? (
                      <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 font-mono">
                        <CheckCircle2 size={13} /> Unlocked
                      </span>
                    ) : (
                      <span className="text-xs font-mono font-bold text-amber-400">
                        ${node.cost.toLocaleString()}
                      </span>
                    )}
                  </div>

                  <h3 className="text-sm font-bold text-slate-100">{node.title}</h3>
                  <p className="text-xs text-slate-300">{node.description}</p>

                  {node.passiveBonus && (
                    <div className="text-[11px] text-emerald-300 font-mono bg-emerald-950/40 px-2 py-1 rounded border border-emerald-800/40 flex items-center gap-1.5 mt-1">
                      <Sparkles size={13} />
                      <span>{node.passiveBonus.label}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                  <span className="text-[10px] text-slate-400 font-mono">
                    Unlocks: {node.unlocksUnits.join(', ')}
                  </span>

                  {!node.unlocked && (
                    <button
                      disabled={!unlockable}
                      onClick={() => {
                        SoundManager.playVictory();
                        onUnlockTech(node.id);
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold font-mono transition ${
                        unlockable
                          ? 'bg-purple-500 hover:bg-purple-400 text-slate-950 shadow-md'
                          : 'bg-slate-800 text-slate-500 cursor-not-allowed'
                      }`}
                    >
                      {unlockable ? <Sparkles size={13} /> : <Lock size={13} />}
                      <span>{unlockable ? 'Research & Unlock' : 'Prerequisites Locked'}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
