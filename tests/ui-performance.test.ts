import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createReferenceMemoizedProjection } from '../src/renderer/src/utils/reference-memo.ts'
import {
  isChatScrollActive,
  setChatScrollActive,
  subscribeChatScrollActivity
} from '../src/renderer/src/utils/chat-scroll-activity.ts'
import {
  CHAT_BOTTOM_TOLERANCE_PX,
  isScrollViewportAtBottom
} from '../src/renderer/src/utils/scroll-position.ts'

test('临时 UI 状态变化复用持久化投影，避免重建超长会话快照', () => {
  type State = { transient: boolean; conversations: object[] }
  let projections = 0
  const project = createReferenceMemoizedProjection(
    (state: State) => [state.conversations],
    (state: State) => {
      projections += 1
      return { conversations: state.conversations }
    }
  )
  const conversations = [{ id: 'long-session' }]
  const first = project({ transient: false, conversations })
  const second = project({ transient: true, conversations })
  assert.equal(first, second)
  assert.equal(projections, 1)

  const third = project({ transient: true, conversations: [...conversations] })
  assert.notEqual(third, second)
  assert.equal(projections, 2)
})

test('设置弹框订阅与主应用渲染隔离', async () => {
  const source = await fs.readFile(path.resolve('src/renderer/src/App.tsx'), 'utf8')
  assert.match(source, /function SettingsModalGate\(\)/)
  assert.match(source, /function SettingsModalGate[\s\S]*state\.settingsOpen/)
  const appBody = source.slice(source.indexOf('export default function App'))
  assert.doesNotMatch(appBody, /const settingsOpen = useAppStore/)
})

test('发送消息按需读取编辑器选区，聊天主组件不订阅选区变化', async () => {
  const source = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  const chatPanelBody = source.slice(source.indexOf('export function ChatPanel'))
  assert.doesNotMatch(chatPanelBody, /useAppStore\(\(state\) => state\.editorSelection\)/)
  assert.match(chatPanelBody, /currentEditorSelection = useAppStore\.getState\(\)\.editorSelection/)
})

test('滚动状态协调器只在状态真正变化时通知流式渲染层', () => {
  const states: boolean[] = []
  setChatScrollActive(false)
  const unsubscribe = subscribeChatScrollActivity((active) => states.push(active))
  setChatScrollActive(true)
  setChatScrollActive(true)
  assert.equal(isChatScrollActive(), true)
  setChatScrollActive(false)
  unsubscribe()
  assert.deepEqual(states, [true, false])
})

test('会话滚动期间暂停流式刷新与大型持久化写入', async () => {
  const appSource = await fs.readFile(path.resolve('src/renderer/src/App.tsx'), 'utf8')
  const chatSource = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  const storeSource = await fs.readFile(path.resolve('src/renderer/src/store.ts'), 'utf8')
  assert.match(appSource, /if \(!force && isChatScrollActive\(\)\) return/)
  assert.match(chatSource, /isScrolling=\{setChatScrollActive\}/)
  assert.match(storeSource, /if \(!force && isChatScrollActive\(\)\)/)
})

test('超长思考与较早过程保持完整，不在会话存储中裁剪', async () => {
  const storeSource = await fs.readFile(path.resolve('src/renderer/src/store.ts'), 'utf8')
  assert.doesNotMatch(storeSource, /较早思考内容已折叠以保证界面流畅/)
  assert.doesNotMatch(storeSource, /已折叠 .* 条较早过程以保证性能/)
  assert.doesNotMatch(storeSource, /content\.length > 140_000/)
})

test('分隔拖拽区只改变鼠标形态且宽度固定为整数像素', async () => {
  const appSource = await fs.readFile(path.resolve('src/renderer/src/App.tsx'), 'utf8')
  const styleSource = await fs.readFile(path.resolve('src/renderer/src/styles.css'), 'utf8')
  assert.match(appSource, /setProjectWidth\(Math\.round\(/)
  assert.match(appSource, /setChatWidth\(Math\.round\(/)
  assert.match(styleSource, /\.resize-handle\.vertical\s*\{[^}]*cursor:\s*col-resize;/s)
  const finalHandleStyle = styleSource.lastIndexOf('.resize-handle.vertical::after')
  assert.ok(finalHandleStyle >= 0)
  assert.match(styleSource.slice(finalHandleStyle), /display:\s*none;/)
})

test('会话底部使用真实阈值并保留完整可见留白', async () => {
  const chatSource = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  const styleSource = await fs.readFile(path.resolve('src/renderer/src/styles.css'), 'utf8')
  assert.match(chatSource, /atBottomThreshold=\{8\}/)
  assert.match(chatSource, /scrollerRef=\{setChatScrollerRef\}/)
  assert.match(chatSource, /totalListHeightChanged=\{scheduleChatBottomSync\}/)
  assert.match(styleSource, /\.message-list-footer\s*\{\s*height:\s*36px;/)
})

test('会话底部判定容忍小数像素误差且离开底部后恢复箭头', () => {
  assert.equal(CHAT_BOTTOM_TOLERANCE_PX, 4)
  assert.equal(
    isScrollViewportAtBottom({ scrollHeight: 1000.4, scrollTop: 600.2, clientHeight: 400 }),
    true
  )
  assert.equal(
    isScrollViewportAtBottom({ scrollHeight: 1000, scrollTop: 595, clientHeight: 400 }),
    false
  )
  assert.equal(
    isScrollViewportAtBottom({ scrollHeight: 320, scrollTop: 0, clientHeight: 480 }),
    true
  )
})
