import { UnitTypeId } from '../types/simulation';

export type EngineerMood = 'happy' | 'excited' | 'thinking' | 'wink';

export interface TutorialStep {
  id: string;
  title: string;
  /** Comical line spoken by Dr. Rio Clearwater, the site engineer */
  line: string;
  mood: EngineerMood;
  /** Required build during this step (locks every other unit & lot) */
  unitTypeId?: UnitTypeId;
  /** Step completes when the guided pipe chain is connected */
  requiresPipes?: boolean;
}

/**
 * Guided tutorial for the default starting stage (Seaside Haven).
 * The required unit of each build step is covered by a training grant,
 * so following the tutorial never drains the player's real budget.
 */
export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'Welcome aboard, Rookie!',
    mood: 'happy',
    line: "Dr. Rio Clearwater, site engineer, at your service! Today we turn stinky sewage into sparkly river water. Grab your hard hat — first rule of plumbing school: chunky stuff goes first!",
  },
  {
    id: 'build_bar_screen',
    title: 'Step 1 · Bar Screen',
    mood: 'excited',
    unitTypeId: 'bar_screen',
    line: "See that glowing green lot? Plop a BAR SCREEN right there! It catches rags, sneakers and my lucky wrench I lost in '09. Training budget covers it — build away, it's FREE!",
  },
  {
    id: 'build_grit_chamber',
    title: 'Step 2 · Grit Chamber',
    mood: 'happy',
    unitTypeId: 'grit_chamber',
    line: "Beautiful! Now the GRIT CHAMBER. Sand and coffee grounds sink like my heart on Monday mornings. We spin them out before they shred the pumps!",
  },
  {
    id: 'build_primary_clarifier',
    title: 'Step 3 · Primary Clarifier',
    mood: 'thinking',
    unitTypeId: 'primary_clarifier_circular',
    line: "Now the big round fella — a PRIMARY CLARIFIER. Gravity does all the heavy lifting while the solids take a nap at the bottom. Lazy? No, no... genius.",
  },
  {
    id: 'connect_pipes',
    title: 'Step 4 · Connect the Pipes',
    mood: 'wink',
    requiresPipes: true,
    line: "Tanks alone are just fancy bathtubs! Open PIPES and wire me up: Inlet to Screen, Screen to Grit, Grit to Clarifier, Clarifier to Outfall. Water only flows where YOU plumb it!",
  },
  {
    id: 'graduation',
    title: 'Graduation Day!',
    mood: 'excited',
    line: "LOOK AT IT GO! Crystal clear! You are officially my favorite intern. The rest of the plant is yours now — build big, pipe smart, and keep that effluent sparkling!",
  },
];

/** Pipe chain required by the 'connect_pipes' tutorial step */
export const TUTORIAL_PIPE_CHAIN: [string, string][] = [
  ['influent_inlet', 'bar_screen'],
  ['bar_screen', 'grit_chamber'],
  ['grit_chamber', 'primary_clarifier_circular'],
  ['primary_clarifier_circular', 'effluent_outfall'],
];
