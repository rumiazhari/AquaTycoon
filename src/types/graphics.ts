export interface TileCoord {
  x: number;
  y: number;
}

export type ToolMode =
  | 'select'
  | 'place_unit'
  | 'connect_pipe'
  | 'demolish'
  | 'inspect'
  | 'pave_road'
  | 'draw_basin'
  | 'place_equipment'
  | 'connect_utility'
  | 'draw_baffle';

export interface VisualTheme {
  waterTurbidColor: string;
  waterAeratedColor: string;
  waterTreatedColor: string;
  waterEffluentColor: string;
  pipeColorMap: Record<string, string>;
  isNightMode: boolean;
}

export interface CutawayViewSettings {
  enabled: boolean;
  unitInstanceId: string | null;
  sliceHeight: number; // 0.0 to 1.0
  showDiffuserBubbles: boolean;
  showSludgeBlanket: boolean;
}
