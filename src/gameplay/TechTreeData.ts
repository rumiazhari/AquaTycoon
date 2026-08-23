import { TechNode } from '../types/game';

export const TECH_TREE_NODES: TechNode[] = [
  {
    id: 'tech_basics',
    title: 'Basic Municipal Treatment',
    category: 'preliminary',
    description: 'Fundamental mechanical screening, gravity sedimentation, and conventional activated sludge aeration.',
    cost: 0,
    unlocked: true,
    prerequisites: [],
    unlocksUnits: ['bar_screen', 'grit_chamber', 'primary_clarifier_circular', 'activated_sludge_cas', 'secondary_clarifier', 'uv_disinfection', 'sludge_thickener', 'pump_station', 'pipe_junction']
  },
  {
    id: 'tech_compact_tanks',
    title: 'Rectangular Lamella & Compact Tanks',
    category: 'preliminary',
    description: 'Chain-and-flight settling tanks engineered for high-density urban footprint efficiency.',
    cost: 25000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['primary_clarifier_rect']
  },
  {
    id: 'tech_daf_flotation',
    title: 'Dissolved Air Flotation (DAF)',
    category: 'preliminary',
    description: 'Micro-bubble pressurized flotation system targeting grease, dairy oils, and low-density flocs.',
    cost: 40000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['daf_unit']
  },
  {
    id: 'tech_biological_nutrients',
    title: '3-Stage Biological Nutrient Removal (A2O / Bardenpho)',
    category: 'biological',
    description: 'Anaerobic-Anoxic-Aerobic configuration achieving simultaneous Nitrification, Denitrification, and Bio-P removal.',
    cost: 85000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['a2o_bardenpho']
  },
  {
    id: 'tech_mbbr_biofilm',
    title: 'Moving Bed Biofilm Reactor (MBBR)',
    category: 'biological',
    description: 'Protected fluidized carrier media providing extreme resilience to industrial toxic spikes.',
    cost: 75000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['mbbr_reactor']
  },
  {
    id: 'tech_membrane_mbr',
    title: 'Membrane Bioreactors (MBR Ultrafiltration)',
    category: 'biological',
    description: '0.04 μm submerged hollow-fiber cassettes replacing secondary clarifiers and delivering zero-turbidity effluent.',
    cost: 150000,
    unlocked: false,
    prerequisites: ['tech_biological_nutrients'],
    unlocksUnits: ['mbr_membrane']
  },
  {
    id: 'tech_fixed_film',
    title: 'Attached Growth Trickling Filters',
    category: 'biological',
    description: 'Low-energy biological trickling towers with rotating distribution arms.',
    cost: 35000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['trickling_filter']
  },
  {
    id: 'tech_batch_reactors',
    title: 'Sequencing Batch Reactors (SBR)',
    category: 'biological',
    description: 'Cycle-based cyclic aeration and settling in a single tank footprint.',
    cost: 50000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['sbr_reactor']
  },
  {
    id: 'tech_granular_filtration',
    title: 'Rapid Dual-Media Sand Filtration',
    category: 'tertiary',
    description: 'Granular anthracite and quartz sand polishing for crystal clarity.',
    cost: 45000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['sand_filter']
  },
  {
    id: 'tech_chemical_removal',
    title: 'Chemical Coagulation & P-Precipitation',
    category: 'tertiary',
    description: 'Precision chemical flash mixing of Alum/FeCl3 to precipitate orthophosphates < 0.1 mg/L.',
    cost: 35000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['chemical_phosphorus']
  },
  {
    id: 'tech_chlorination',
    title: 'Chlorine Contact Basins',
    category: 'tertiary',
    description: 'Serpentine sodium hypochlorite disinfection basins for persistent pathogen inactivation.',
    cost: 20000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['chlorination_basin']
  },
  {
    id: 'tech_reverse_osmosis',
    title: 'Reverse Osmosis (RO) Desalination & Reuse',
    category: 'tertiary',
    description: 'Semi-permeable polyamide membranes generating direct potable reuse water quality.',
    cost: 220000,
    unlocked: false,
    prerequisites: ['tech_membrane_mbr', 'tech_granular_filtration'],
    unlocksUnits: ['reverse_osmosis']
  },
  {
    id: 'tech_advanced_oxidation',
    title: 'Advanced Oxidation Processes (Ozone / AOP)',
    category: 'tertiary',
    description: 'Hydroxyl radical generation destroying synthetic dyes, micro-pollutants, and toxic chemical matrices.',
    cost: 130000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['advanced_oxidation_aop']
  },
  {
    id: 'tech_anaerobic_digestion',
    title: 'Anaerobic Digesters & Biogas Cogeneration (CHP)',
    category: 'sludge',
    description: 'Mesophilic 37°C sludge digestion converting organic waste into methane gas and renewable electrical power.',
    cost: 180000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['anaerobic_digester'],
    passiveBonus: {
      type: 'power_efficiency',
      value: 0.20,
      label: '+20% Thermal & Electrical Energy Recovery'
    }
  },
  {
    id: 'tech_dewatering',
    title: 'Centrifugal & Belt Press Dewatering',
    category: 'sludge',
    description: 'High g-force mechanical dewatering producing dry cake biosolids and lowering hauling fees by 80%.',
    cost: 65000,
    unlocked: false,
    prerequisites: ['tech_basics'],
    unlocksUnits: ['sludge_dewatering_press']
  },
  {
    id: 'tech_solar_drying',
    title: 'Solar Sludge Greenhouse & Pelletizing',
    category: 'sludge',
    description: 'Zero-power solar thermal drying transforming sludge into commercial pathogen-free fertilizer.',
    cost: 70000,
    unlocked: false,
    prerequisites: ['tech_dewatering'],
    unlocksUnits: ['solar_drying_bed']
  }
];
