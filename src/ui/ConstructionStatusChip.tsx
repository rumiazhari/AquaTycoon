import React from 'react';
import { ConstructionStats } from '../design/ConstructionNetwork';
import { BasinZoneStats } from '../design/BasinZone';
import { Zap, Waves, Droplets, Cable, Columns3, ShieldCheck, Hexagon, Gauge, FlaskConical, Filter, Cylinder, Flame } from 'lucide-react';

interface Props {
  stats: ConstructionStats;
  zoneStats?: BasinZoneStats | null;
}

export const ConstructionStatusChip: React.FC<Props> = ({ stats, zoneStats }) => {
  const hasBuild = stats.totalBasins > 0 || stats.totalEquipment > 0 || stats.totalUtilityConnections > 0 || (zoneStats && zoneStats.totalBaffles > 0);
  if (!hasBuild) return null;

  const powerTone = stats.unpoweredEquipment > 0
    ? 'text-amber-300 border-amber-500/40 bg-amber-950/30'
    : 'text-emerald-300 border-emerald-500/30 bg-emerald-950/20';
  const aerTone = stats.unaeratedDiffusers > 0
    ? 'text-amber-300 border-amber-500/40 bg-amber-950/30'
    : stats.totalDiffusers > 0 ? 'text-sky-300 border-sky-500/30 bg-sky-950/20' : 'hidden';

  return (
    <div className="absolute top-[58px] left-3 z-20 pointer-events-none flex flex-wrap gap-1.5 max-w-[min(72vw,40rem)]">
      {stats.totalBasins > 0 && (
        <span className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-200 text-[11px] font-mono shadow-lg">
          <Droplets size={12} className="text-cyan-400" />
          <span className="font-bold">{stats.totalBasins} basin{stats.totalBasins > 1 ? 's' : ''}</span>
          <span className="text-slate-400">· {stats.totalBasinVolumeM3.toLocaleString()} m³</span>
        </span>
      )}
      {stats.totalEquipment > 0 && (
        <span className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono shadow-lg ${powerTone}`}>
          <Zap size={12} />
          <span className="font-bold">{stats.poweredEquipment}/{stats.totalEquipment} powered</span>
          <span className="opacity-80">· {stats.livePowerKw} kW live</span>
        </span>
      )}
      {stats.totalDiffusers > 0 && (
        <span className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono shadow-lg ${aerTone}`}>
          <Waves size={12} />
          <span className="font-bold">{stats.aeratedDiffusers}/{stats.totalDiffusers} aerated</span>
        </span>
      )}
      {(stats.totalMembranes > 0 || stats.totalCarriers > 0) && (
        <span className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-cyan-500/30 text-cyan-200 text-[11px] font-mono shadow-lg">
          {stats.totalMembranes > 0 && <><ShieldCheck size={12} className="text-cyan-400" /><span className="font-bold">{stats.poweredMembranes}/{stats.totalMembranes} membranes</span></>}
          {stats.totalMembranes > 0 && stats.totalCarriers > 0 && <span className="opacity-50">·</span>}
          {stats.totalCarriers > 0 && <><Hexagon size={12} className={stats.totalMembranes>0?"text-sky-300":"text-cyan-400"} /><span className="font-bold">{stats.totalCarriers} carrier{stats.totalCarriers!==1?'s':''}</span></>}
        </span>
      )}
      {stats.totalSensors > 0 && (
        <span className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono shadow-lg ${stats.poweredSensors > 0 ? 'bg-teal-950/40 border-teal-500/30 text-teal-200' : 'bg-amber-950/30 border-amber-500/30 text-amber-200'}`}>
          <Gauge size={12} className={stats.poweredSensors>0 ? "text-teal-400" : "text-amber-400"} />
          <span className="font-bold">{stats.poweredSensors}/{stats.totalSensors} sensors live</span>
          <span className="opacity-70 hidden sm:inline">· {stats.totalDoProbes} DO · {stats.totalFlowMeters} flow · {stats.totalLevelSensors} level</span>
        </span>
      )}
      {stats.totalChemicalUnits > 0 && (
        <span className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono shadow-lg ${stats.poweredChemicalUnits > 0 ? 'bg-lime-950/30 border-lime-500/30 text-lime-200' : 'bg-amber-950/30 border-amber-500/30 text-amber-200'}`}>
          <FlaskConical size={12} className={stats.poweredChemicalUnits>0 ? "text-lime-400" : "text-amber-400"} />
          <span className="font-bold">{stats.poweredChemicalUnits}/{stats.totalChemicalUnits} dosing live</span>
          <span className="opacity-70 hidden sm:inline">· {stats.totalStorageTanks} tank{stats.totalStorageTanks!==1?'s':''} · {stats.totalDosingPumps} pump{stats.totalDosingPumps!==1?'s':''}</span>
        </span>
      )}
      {stats.totalRoUnits > 0 && (
        <span className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono shadow-lg ${stats.poweredRoUnits > 0 ? 'bg-sky-950/40 border-sky-500/30 text-sky-200' : 'bg-amber-950/30 border-amber-500/30 text-amber-200'}`}>
          <Filter size={12} className={stats.poweredRoUnits>0 ? "text-sky-400" : "text-amber-400"} />
          <span className="font-bold">{stats.poweredRoSkids}/{stats.totalRoSkids} RO skid{stats.totalRoSkids!==1?'s':''} live</span>
          {stats.totalBrineTanks>0 && <><span className="opacity-50">·</span><Cylinder size={12} className={stats.poweredBrineTanks>0 ? "text-amber-300" : "text-amber-400"} /><span className="font-bold">{stats.poweredBrineTanks}/{stats.totalBrineTanks} brine</span></>}
        </span>
      )}
      {stats.totalChpUnits > 0 && (
        <span className={`pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-mono shadow-lg ${stats.poweredChpUnits > 0 ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-200' : 'bg-amber-950/30 border-amber-500/30 text-amber-200'}`}>
          <Flame size={12} className={stats.poweredChpUnits>0 ? "text-emerald-400" : "text-amber-400"} />
          <span className="font-bold">{stats.poweredChpUnits}/{stats.totalChpUnits} CHP live</span>
          <span className="opacity-70 hidden sm:inline">· {stats.poweredChpUnits * 14} kW green</span>
        </span>
      )}
      {stats.totalUtilityConnections > 0 && (
        <span className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900 border border-slate-700 text-slate-300 text-[11px] font-mono shadow-lg">
          <Cable size={12} className="text-slate-400" />
          <span>{stats.totalUtilityConnections} utility line{stats.totalUtilityConnections > 1 ? 's' : ''}</span>
        </span>
      )}
      {zoneStats && (zoneStats.totalBaffles > 0 || zoneStats.totalZones !== zoneStats.totalBasins) && (
        <span className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-950/40 border border-violet-500/30 text-violet-300 text-[11px] font-mono shadow-lg">
          <Columns3 size={12} className="text-violet-400" />
          <span className="font-bold">{zoneStats.totalZones} zone{zoneStats.totalZones>1?'s':''}</span>
          <span className="opacity-80">· {zoneStats.totalBaffles} baffle{zoneStats.totalBaffles!==1?'s':''}</span>
        </span>
      )}
    </div>
  );
};
