import assert from 'node:assert/strict'
import test from 'node:test'
import {
  placeViewportMenu,
  placeViewportMenuBesideRect
} from '../src/renderer/src/utils/viewport-menu.ts'

test('菜单空间充足时从鼠标位置向右下展开', () => {
  assert.deepEqual(
    placeViewportMenu({
      anchorX: 120,
      anchorY: 80,
      menuWidth: 220,
      menuHeight: 300,
      viewportWidth: 1280,
      viewportHeight: 720
    }),
    { left: 120, top: 80, horizontal: 'right', vertical: 'down' }
  )
})

test('靠近右边缘时自动向左展开', () => {
  assert.deepEqual(
    placeViewportMenu({
      anchorX: 1180,
      anchorY: 80,
      menuWidth: 220,
      menuHeight: 300,
      viewportWidth: 1280,
      viewportHeight: 720
    }),
    { left: 960, top: 80, horizontal: 'left', vertical: 'down' }
  )
})

test('靠近底部时自动向上展开', () => {
  assert.deepEqual(
    placeViewportMenu({
      anchorX: 120,
      anchorY: 680,
      menuWidth: 220,
      menuHeight: 300,
      viewportWidth: 1280,
      viewportHeight: 720
    }),
    { left: 120, top: 380, horizontal: 'right', vertical: 'up' }
  )
})

test('位于右下角时同时向左和向上展开', () => {
  assert.deepEqual(
    placeViewportMenu({
      anchorX: 1180,
      anchorY: 680,
      menuWidth: 220,
      menuHeight: 300,
      viewportWidth: 1280,
      viewportHeight: 720
    }),
    { left: 960, top: 380, horizontal: 'left', vertical: 'up' }
  )
})

test('窗口小于菜单时仍将菜单夹紧在安全边距内', () => {
  assert.deepEqual(
    placeViewportMenu({
      anchorX: 20,
      anchorY: 20,
      menuWidth: 400,
      menuHeight: 500,
      viewportWidth: 320,
      viewportHeight: 240
    }),
    { left: 8, top: 8, horizontal: 'left', vertical: 'up' }
  )
})

test('资源菜单贴着条目右侧展开且不遮挡条目', () => {
  assert.deepEqual(
    placeViewportMenuBesideRect({
      anchorLeft: 20,
      anchorRight: 300,
      anchorTop: 100,
      anchorBottom: 132,
      menuWidth: 220,
      menuHeight: 260,
      viewportWidth: 1000,
      viewportHeight: 720
    }),
    { left: 304, top: 100, horizontal: 'right', vertical: 'down' }
  )
})

test('资源菜单靠近右边缘时贴着条目左侧展开', () => {
  assert.deepEqual(
    placeViewportMenuBesideRect({
      anchorLeft: 700,
      anchorRight: 980,
      anchorTop: 100,
      anchorBottom: 132,
      menuWidth: 220,
      menuHeight: 260,
      viewportWidth: 1000,
      viewportHeight: 720
    }),
    { left: 476, top: 100, horizontal: 'left', vertical: 'down' }
  )
})
