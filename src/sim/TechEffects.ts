/**
 * Centralized technology-effects evaluator.
 *
 * Technologies may advertise passive engineering/economic bonuses
 * (TechNode.passiveBonus). This module is the SINGLE place where unlocked
 * technologies are translated into simulation modifiers — UI metadata stays
 * decorative-free because the simulator consumes these values directly.
 */

export interface TechEffects {
  /** Multiplier on recovered electrical energy (CHP generators). 1.0 = baseline. */
  energyRecoveryMultiplier: number;
}

const BASE_EFFECTS: TechEffects = { energyRecoveryMultiplier: 1.0 };

/**
 * Evaluates the aggregate passive bonuses for a set of unlocked tech ids.
 * Unknown ids are ignored so save-game drift cannot corrupt the simulation.
 */
export function evaluateTechEffects(unlockedTechIds: Iterable<string>): TechEffects {
  const effects: TechEffects = { ...BASE_EFFECTS };
  const ids = new Set(unlockedTechIds);

  // tech_anaerobic_digestion: "+20% Thermal & Electrical Energy Recovery"
  // (TechTreeData.passiveBonus: type 'power_efficiency', value 0.20)
  if (ids.has('tech_anaerobic_digestion')) {
    effects.energyRecoveryMultiplier *= 1 + 0.20;
  }

  return effects;
}
