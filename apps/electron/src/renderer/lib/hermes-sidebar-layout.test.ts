import { describe, expect, test } from 'bun:test'
import {
  getHermesPanelToggleHeight,
  HERMES_PANEL_MAX_HEIGHT,
  HERMES_PANEL_MIN_HEIGHT,
  resizeHermesPanelHeight,
} from './hermes-sidebar-layout'

describe('Hermes sidebar split-pane', () => {
  test('Given 向上拖动 When 调整 Then 扩大 Hermes 远端区域', () => {
    expect(resizeHermesPanelHeight(220, 400, 340)).toBe(280)
  })

  test('Given 向下拖动 When 调整 Then 缩小 Hermes 远端区域', () => {
    expect(resizeHermesPanelHeight(220, 400, 460)).toBe(160)
  })

  test('Given 拖动超出范围 When 调整 Then 限制在可用高度', () => {
    expect(resizeHermesPanelHeight(220, 400, 2_000)).toBe(HERMES_PANEL_MIN_HEIGHT)
    expect(resizeHermesPanelHeight(220, 400, -2_000)).toBe(HERMES_PANEL_MAX_HEIGHT)
  })

  test('Given 自定义展开高度 When 折叠后再次展开 Then 恢复原高度', () => {
    const collapsed = getHermesPanelToggleHeight(336, 336)
    expect(collapsed).toBe(HERMES_PANEL_MIN_HEIGHT)
    expect(getHermesPanelToggleHeight(collapsed, 336)).toBe(336)
  })
})
