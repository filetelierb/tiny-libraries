export type Side = 'left' | 'right';
export type PanelPreference = { open: boolean; pinned: boolean; width: number };
export type PanelPreferences = Record<Side, PanelPreference>;
export const PANEL_STORAGE_KEY = 'tl:panels:v1';
export const PANEL_MIN = { left: 240, right: 280 };
export const PANEL_MAX = { left: 520, right: 600 };
export const PANEL_DEFAULT = { left: 290, right: 340 };
export const DRAWER_BREAKPOINT = 960;
export const READER_MIN = 360;
export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

export function panelsForSplit(preferences: PanelPreferences): PanelPreferences {
  return {
    left: { ...preferences.left, open: false, pinned: false },
    right: { ...preferences.right, open: false, pinned: false },
  };
}

export function readPanelPreferences(raw: string | null, viewport: number): PanelPreferences {
  let data: Partial<PanelPreferences> = {};
  try {
    data = JSON.parse(raw || '{}') || {};
  } catch {
    /* Use a valid layout if local preferences are damaged. */
  }
  return Object.fromEntries(
    (['left', 'right'] as const).map((side) => {
      const value = data[side];
      return [
        side,
        {
          open: typeof value?.open === 'boolean' ? value.open : viewport >= DRAWER_BREAKPOINT,
          pinned: typeof value?.pinned === 'boolean' ? value.pinned : true,
          width:
            typeof value?.width === 'number' && Number.isFinite(value.width)
              ? clamp(value.width, PANEL_MIN[side], PANEL_MAX[side])
              : PANEL_DEFAULT[side],
        },
      ];
    }),
  ) as PanelPreferences;
}

export function resolvePanels(preferences: PanelPreferences, viewport: number) {
  const docked = (side: Side) =>
    viewport >= DRAWER_BREAKPOINT && preferences[side].pinned && preferences[side].open;
  const leftDocked = docked('left'),
    rightDocked = docked('right');
  let leftWidth = preferences.left.width,
    rightWidth = preferences.right.width;
  const available = viewport - READER_MIN - (leftDocked ? 6 : 0) - (rightDocked ? 6 : 0);
  if (leftDocked && rightDocked) {
    const overflow = Math.max(0, leftWidth + rightWidth - available);
    const room = leftWidth - PANEL_MIN.left + rightWidth - PANEL_MIN.right;
    if (overflow && room) {
      leftWidth -= (overflow * (leftWidth - PANEL_MIN.left)) / room;
      rightWidth -= (overflow * (rightWidth - PANEL_MIN.right)) / room;
    }
  } else if (leftDocked) leftWidth = Math.min(leftWidth, available);
  else if (rightDocked) rightWidth = Math.min(rightWidth, available);
  return {
    left: {
      docked: leftDocked,
      width: Math.floor(leftWidth),
      max: Math.min(PANEL_MAX.left, available - (rightDocked ? rightWidth : 0)),
    },
    right: {
      docked: rightDocked,
      width: Math.floor(rightWidth),
      max: Math.min(PANEL_MAX.right, available - (leftDocked ? leftWidth : 0)),
    },
  };
}
