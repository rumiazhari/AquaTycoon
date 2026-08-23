import React, { useState } from 'react';
import { X, BookOpen, Filter, Activity, Sparkles, Recycle } from 'lucide-react';
import { SoundManager } from '../audio/SoundManager';

interface TutorialGuideModalProps {
  onClose: () => void;
}

const GUIDE_SECTIONS = [
  {
    id: 'overview',
    title: '1. Wastewater Engineering Overview',
    icon: <BookOpen size={16} />,
    content: (
      <div className="flex flex-col gap-2.5 text-xs text-slate-300">
        <p>
          Wastewater treatment plants (WWTP) protect public health and aquatic ecosystems by transforming contaminated municipal and industrial sewage into clean, reusable water.
        </p>
        <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 flex flex-col gap-1 font-mono text-[11px]">
          <span className="text-cyan-400 font-bold">Standard Treatment Train:</span>
          <span>Raw Sewage ➔ Preliminary (Screens/Grit) ➔ Primary Clarifiers ➔ Secondary Bioreactors & Clarifiers ➔ Tertiary Filters/UV ➔ Outfall Discharge</span>
        </div>
        <p>
          In AquaTycoon 3D, each tank is modeled according to authentic biokinetic & mass-balance differential equations (Metcalf & Eddy standards).
        </p>
      </div>
    )
  },
  {
    id: 'preliminary',
    title: '2. Preliminary & Primary Treatment',
    icon: <Filter size={16} />,
    content: (
      <div className="flex flex-col gap-2.5 text-xs text-slate-300">
        <p>
          <strong>Mechanical Bar Screens</strong> remove rags, plastics, and large debris to protect downstream pumps. <strong>Vortex Grit Chambers</strong> settle heavy sand and stones (particles &gt;0.2mm).
        </p>
        <p>
          <strong>Primary Clarifiers</strong> use gravity to settle 50-70% of Total Suspended Solids (TSS) and 30% of particulate BOD as raw primary sludge, greatly reducing the organic load on biological aeration basins!
        </p>
      </div>
    )
  },
  {
    id: 'secondary',
    title: '3. Biological Secondary Treatment',
    icon: <Activity size={16} />,
    content: (
      <div className="flex flex-col gap-2.5 text-xs text-slate-300">
        <p>
          <strong>Conventional Activated Sludge (CAS):</strong> Aerobic bacteria consume dissolved organic matter (BOD/COD). Fine-bubble diffusers maintain Dissolved Oxygen (DO &gt; 2.0 mg/L).
        </p>
        <p>
          <strong>A2O / Bardenpho (BNR):</strong> 3-stage Anaerobic-Anoxic-Aerobic configuration. Nitrifies Ammonia (NH₄ ➔ NO₃) and Denitrifies Nitrates into harmless Nitrogen gas (NO₃ ➔ N₂), alongside luxury biological phosphorus uptake.
        </p>
        <p>
          <strong>MBBR & MBR:</strong> MBBR uses fluidized plastic carriers resilient to toxic shocks. MBR uses 0.04 μm ultrafiltration membranes to completely eliminate secondary clarifiers and produce zero-turbidity water.
        </p>
      </div>
    )
  },
  {
    id: 'tertiary',
    title: '4. Tertiary Polishing & Disinfection',
    icon: <Sparkles size={16} />,
    content: (
      <div className="flex flex-col gap-2.5 text-xs text-slate-300">
        <p>
          <strong>Rapid Sand Filters:</strong> Granular media traps residual micro-flocs to achieve turbidity &lt; 1 NTU.
        </p>
        <p>
          <strong>Chemical P-Precipitation:</strong> Doses Alum or FeCl₃ to precipitate phosphates below 0.1 mg/L, preventing algal blooms in receiving lakes.
        </p>
        <p>
          <strong>UV Disinfection & Reverse Osmosis:</strong> Germicidal 254nm UV light achieves 4-log pathogen inactivation without chemical byproducts. Reverse Osmosis (RO) removes 99.5% of dissolved salts for direct potable reuse (NEWater standard).
        </p>
      </div>
    )
  },
  {
    id: 'sludge',
    title: '5. Sludge Digestion & Renewable Energy',
    icon: <Recycle size={16} />,
    content: (
      <div className="flex flex-col gap-2.5 text-xs text-slate-300">
        <p>
          Sludge is thickened from 1% to 4% solids in <strong>Gravity Thickeners</strong>, then fed to <strong>Mesophilic (37°C) Anaerobic Digesters</strong>.
        </p>
        <p>
          Methanogens convert volatile solids into <strong>Methane Biogas (CH₄)</strong>, which is burned in Combined Heat & Power (CHP) engines to generate green electricity—offsetting plant operating bills and earning green energy credits!
        </p>
      </div>
    )
  }
];

export const TutorialGuideModal: React.FC<TutorialGuideModalProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState(0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl bg-cyber-card border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900/90 border-b border-slate-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/20 text-cyan-400">
              <BookOpen size={20} />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-100">Wastewater Engineering Handbook</h2>
              <p className="text-xs text-slate-400 font-mono">
                Technical principles, unit operations & process optimization guide
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

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-6 py-2 bg-slate-900/60 border-b border-slate-800 overflow-x-auto">
          {GUIDE_SECTIONS.map((sec, idx) => (
            <button
              key={sec.id}
              onClick={() => { SoundManager.playClick(); setActiveTab(idx); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition ${
                activeTab === idx
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {sec.icon}
              <span>{sec.title.split('. ')[1]}</span>
            </button>
          ))}
        </div>

        {/* Body Content */}
        <div className="p-6 overflow-y-auto scrollbar-thin flex flex-col gap-4">
          <h3 className="text-sm font-bold text-cyan-400 font-mono">
            {GUIDE_SECTIONS[activeTab].title}
          </h3>
          {GUIDE_SECTIONS[activeTab].content}
        </div>
      </div>
    </div>
  );
};
