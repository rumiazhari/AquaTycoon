import React from 'react';
import { Award, DollarSign, CheckCircle2, ArrowRight, Trophy, Map, RotateCcw } from 'lucide-react';
import { CampaignLevel } from '../types/game';
import { SoundManager } from '../audio/SoundManager';

interface VictoryModalProps {
  level: CampaignLevel;
  /** True when this was the FINAL campaign level — switches to completion state */
  isCampaignComplete?: boolean;
  onNextLevel: () => void;
  onContinuePlaying: () => void;
  onOpenLevelSelect?: () => void;
  onRestartCampaign?: () => void;
}

export const VictoryModal: React.FC<VictoryModalProps> = ({
  level,
  isCampaignComplete = false,
  onNextLevel,
  onContinuePlaying,
  onOpenLevelSelect,
  onRestartCampaign
}) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950 animate-in zoom-in-95 duration-300">
      <div className={`relative w-full max-w-md bg-cyber-card rounded-2xl shadow-2xl overflow-hidden flex flex-col p-6 text-center gap-4 border ${isCampaignComplete ? 'border-amber-400/70' : 'border-emerald-500/60'}`}>

        {/* Celebration Icon */}
        <div className={`w-16 h-16 mx-auto rounded-2xl flex items-center justify-center animate-bounce ${isCampaignComplete ? 'bg-amber-500/20 border border-amber-400/40 text-amber-300' : 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-400'}`}>
          {isCampaignComplete ? <Trophy size={36} /> : <Award size={36} />}
        </div>

        <div>
          <span className={`text-xs font-mono uppercase tracking-widest font-bold ${isCampaignComplete ? 'text-amber-300' : 'text-emerald-400'}`}>
            {isCampaignComplete ? 'CAMPAIGN COMPLETE!' : 'STAGE TARGETS COMPLETED!'}
          </span>
          <h2 className="text-xl font-black text-slate-100 mt-1">
            {isCampaignComplete ? 'All Five Districts Restored' : `${level.title} Cleared!`}
          </h2>
          <p className="text-xs text-slate-300 mt-1">
            {isCampaignComplete
              ? 'From the Emerald Coast to the desert oasis, every watershed now meets its permit. The region runs on your clean water and green energy.'
              : 'All environmental quality targets and financial criteria have been successfully achieved.'}
          </p>
        </div>

        {/* Reward Bonus Pill */}
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between font-mono">
          <span className="text-xs text-slate-400">Municipal Grant Bonus</span>
          <span className="text-sm font-bold text-emerald-400 flex items-center gap-1">
            <DollarSign size={15} /> +${level.bonusReward.toLocaleString()}
          </span>
        </div>

        {/* Objectives Check List */}
        <div className="flex flex-col gap-1.5 text-left p-3 rounded-xl bg-slate-900/60 border border-slate-800/80">
          {level.objectives.map(obj => (
            <div key={obj.id} className="flex items-center gap-2 text-xs text-emerald-300 font-mono">
              <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
              <span>{obj.description}</span>
            </div>
          ))}
        </div>

        {/* Action Buttons */}
        {isCampaignComplete ? (
          <div className="flex flex-col gap-2 mt-2">
            <button
              onClick={() => {
                SoundManager.playClick();
                onContinuePlaying();
              }}
              className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold font-mono transition"
            >
              Continue Playing
            </button>
            <div className="flex items-center gap-2">
              {onOpenLevelSelect && (
                <button
                  onClick={() => {
                    SoundManager.playClick();
                    onOpenLevelSelect();
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold font-mono transition flex items-center justify-center gap-1.5"
                >
                  <Map size={14} /> Level Select
                </button>
              )}
              {onRestartCampaign && (
                <button
                  onClick={() => {
                    SoundManager.playClick();
                    onRestartCampaign();
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold font-mono transition flex items-center justify-center gap-1.5"
                >
                  <RotateCcw size={14} /> Restart Campaign
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => {
                SoundManager.playClick();
                onContinuePlaying();
              }}
              className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold font-mono transition"
            >
              Keep Optimizing
            </button>

            <button
              onClick={() => {
                SoundManager.playVictory();
                onNextLevel();
              }}
              className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-bold font-mono shadow-lg flex items-center justify-center gap-1.5 transition"
            >
              <span>Next Stage</span>
              <ArrowRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
