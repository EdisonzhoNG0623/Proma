export const HERMES_PANEL_MIN_HEIGHT = 48
export const HERMES_PANEL_DEFAULT_HEIGHT = 220
export const HERMES_PANEL_MAX_HEIGHT = 520
export const HERMES_PANEL_KEYBOARD_STEP = 28

export function clampHermesPanelHeight(height: number): number {
  return Math.min(HERMES_PANEL_MAX_HEIGHT, Math.max(HERMES_PANEL_MIN_HEIGHT, height))
}

export function isHermesPanelCollapsed(height: number): boolean {
  return clampHermesPanelHeight(height) <= HERMES_PANEL_MIN_HEIGHT + HERMES_PANEL_KEYBOARD_STEP
}

export function getHermesPanelToggleHeight(currentHeight: number, lastExpandedHeight: number): number {
  return isHermesPanelCollapsed(currentHeight)
    ? clampHermesPanelHeight(lastExpandedHeight || HERMES_PANEL_DEFAULT_HEIGHT)
    : HERMES_PANEL_MIN_HEIGHT
}

/** split-pane 语义：指针向上移动扩大下方 Hermes 区域，向下移动缩小。 */
export function resizeHermesPanelHeight(startHeight: number, startY: number, currentY: number): number {
  return clampHermesPanelHeight(startHeight - (currentY - startY))
}
