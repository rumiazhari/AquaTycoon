/**
 * Centralised game-time model.
 *
 * A single source of truth for converting REAL wall-clock seconds into SIM
 * (simulated) days, deriving the day/night cycle from actual game time, and
 * formatting the in-game clock.
 *
 * Design goals (Prompt 3.3 items 7–17):
 *  - ONE named constant, referenced everywhere — no scattered magic `60` / `600`.
 *  - 1× speed ⇒ 1 game day = 600 real seconds (10 minutes).
 *  - All world animation (vehicles, river, clouds, foam, unit machinery) must
 *    advance with SIMULATED time so pause (0×) freezes the world and fast-forward
 *    (2×/5×) speeds up visuals proportionally.
 *  - Day/night is derived from `gameTimeDays`, not a boolean lerp.
 */
import type { SimulationSpeed } from '../types/game';

/** Real wall-clock seconds that pass for one game day at 1× speed. */
export const REAL_SECONDS_PER_GAME_DAY = 600;

/**
 * Campaign clocks START here (in days) so a fresh level begins in the morning
 * (07:00) with a full visible day ahead — not at midnight.
 */
export const INITIAL_GAME_TIME_DAYS = 7 / 24;

/**
 * Convert a real wall-clock delta (seconds) + active simulation speed into the
 * simulated-day delta. The same formula is used by GameManager (simulation) and
 * by SceneManager/TerrainGrid (visual clock), so the two never drift apart.
 *
 * At simSpeed 0 (pause) this is always 0 → the world freezes.
 */
export const realSecondsToSimDays = (realSeconds: number, simSpeed: SimulationSpeed): number =>
  (realSeconds * simSpeed) / REAL_SECONDS_PER_GAME_DAY;

/**
 * Convert simulated days → { dayNumber(1-based), hour, minute }.
 * Pure: deterministic, no floating drift beyond input precision.
 */
export function gameDaysToCalendar(gameTimeDays: number): { day: number; hour: number; minute: number } {
  const day = Math.floor(gameTimeDays) + 1;
  const dayFraction = gameTimeDays - Math.floor(gameTimeDays);
  // Tiny epsilon absorbs binary-float dust (e.g. 245/1440 storing as
  // 244.999…​) so exact HH:MM boundaries render deterministically.
  const totalMinutes = Math.min(1439, Math.floor(dayFraction * 24 * 60 + 1e-6));
  const hour = Math.floor(totalMinutes / 60) % 24;
  const minute = totalMinutes % 60;
  return { day, hour, minute };
}

/** Pure `HH:MM` string from gameTimeDays. */
export const formatGameClock = (gameTimeDays: number): string => {
  const { hour, minute } = gameDaysToCalendar(gameTimeDays);
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
};

/**
 * Day/night blend factor in [0,1] derived from the actual simulated clock.
 *
 *   05:30–06:30   dawn (0→1)
 *   06:30–18:00   day (=1)
 *   18:00–19:00   sunset (1→0)
 *   19:00–05:30   night (=0)
 *
 * The transitions are smooth (smoothstep) so lighting never snaps.
 */
export function getDayNightFactor(gameTimeDays: number): number {
  const dayFraction = gameTimeDays - Math.floor(gameTimeDays);
  const t = dayFraction * 24; // hours [0,24)

  // Dawn window: 05:30 → 06:30
  // Day window:   06:30 → 18:00
  // Dusk window:  18:00 → 19:00
  // Night window: 19:00 → 05:30 (wraps midnight)

  if (t >= 6.5 && t <= 18.0) return 1; // full day
  if (t >= 19.0 || t < 5.5) return 0;  // full night (wraps midnight)

  // Dawn ramp 05:30→06:30 (0→1)
  if (t >= 5.5 && t < 6.5) {
    const u = (t - 5.5) / 1.0;
    return smoothstep(u);
  }
  // Dusk ramp 18:00→19:00 (1→0)
  // t in (18,19)
  const u = (t - 18.0) / 1.0;
  return 1 - smoothstep(u);
}

/** Whether it is currently night, from the true clock (for coarse toggles). */
export function isNightAt(gameTimeDays: number): boolean {
  return getDayNightFactor(gameTimeDays) < 0.5;
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}
