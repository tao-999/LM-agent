import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createReferenceMemoizedProjection } from '../src/renderer/src/utils/reference-memo.ts'

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
