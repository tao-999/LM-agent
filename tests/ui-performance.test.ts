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
  isScrollViewportAtBottom,
  scrollViewportBottomTop
} from '../src/renderer/src/utils/scroll-position.ts'
import {
  composerInputIdleDelay,
  markComposerInputActive,
  resetComposerInputActivity
} from '../src/renderer/src/utils/composer-input-activity.ts'
import {
  markUiInteractionActive,
  resetUiInteractionActivity,
  uiInteractionIdleDelay
} from '../src/renderer/src/utils/ui-interaction-activity.ts'

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

test('输入期间推迟思考流刷新，避免抢占键盘交互', () => {
  resetComposerInputActivity()
  assert.equal(composerInputIdleDelay(), 0)
  markComposerInputActive(200)
  assert.ok(composerInputIdleDelay() > 0)
  resetComposerInputActivity()
})

test('滚轮、按键与弹框点击期间统一推迟流式刷新', () => {
  resetUiInteractionActivity()
  markUiInteractionActive(220)
  assert.ok(uiInteractionIdleDelay() > 0)
  resetUiInteractionActivity()
})

test('聊天输入使用原生非受控值，流式消息更新不会反复写回输入框', async () => {
  const chatSource = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  assert.match(chatSource, /const inputValueRef = useRef\(''\)/)
  assert.match(chatSource, /defaultValue=""/)
  assert.doesNotMatch(chatSource, /value=\{input\}/)
  assert.match(chatSource, /markComposerInputActive\(\)/)
})

test('超长会话持久化使用 IndexedDB 异步写入并避免复制全部会话', async () => {
  const storeSource = await fs.readFile(path.resolve('src/renderer/src/store.ts'), 'utf8')
  assert.match(storeSource, /indexedDB\.open\('star-companion-persistence'/)
  assert.match(storeSource, /queueDatabaseWrite\(name, value\)/)
  assert.match(
    storeSource,
    /selectedComfyWorkflowId:\s*state\.selectedComfyWorkflowId,[\s\S]*?conversations:\s*state\.conversations,\s*activeConversationId/
  )
})

test('流式消息通过延迟值渲染且已完成步骤按引用隔离', async () => {
  const chatSource = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  assert.match(chatSource, /const renderedMessages = useDeferredValue\(messages\)/)
  assert.match(chatSource, /data=\{renderedMessages\}/)
  assert.match(chatSource, /const AgentStepBlock = memo/)
  assert.match(chatSource, /previous\.block === next\.block/)
})

test('Skill 菜单只由外部点击、Escape、窗口变化或会话切换关闭', async () => {
  const chatSource = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  const effectStart = chatSource.indexOf('if (!showSkills) return')
  const effectEnd = chatSource.indexOf('}, [showSkills])', effectStart)
  const effect = chatSource.slice(effectStart, effectEnd)
  assert.match(effect, /document\.addEventListener\('pointerdown', close\)/)
  assert.match(effect, /document\.addEventListener\('keydown', closeOnEscape\)/)
  assert.doesNotMatch(effect, /addEventListener\('scroll'/)
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
  assert.match(chatSource, /atBottomThreshold=\{CHAT_BOTTOM_TOLERANCE_PX\}/)
  assert.match(chatSource, /scrollerRef=\{setChatScrollerRef\}/)
  assert.match(chatSource, /totalListHeightChanged=\{scheduleChatBottomSync\}/)
  assert.match(chatSource, /new ResizeObserver\(handleResize\)/)
  assert.match(chatSource, /scrollViewportBottomTop\(chatScrollerElement\)/)
  assert.match(styleSource, /\.message-list-footer\s*\{\s*height:\s*36px;/)
})

test('会话底部判定容忍小数像素误差且离开底部后恢复箭头', () => {
  assert.equal(CHAT_BOTTOM_TOLERANCE_PX, 12)
  assert.equal(
    isScrollViewportAtBottom({ scrollHeight: 1000.4, scrollTop: 600.2, clientHeight: 400 }),
    true
  )
  assert.equal(
    isScrollViewportAtBottom({ scrollHeight: 1000, scrollTop: 580, clientHeight: 400 }),
    false
  )
  assert.equal(
    isScrollViewportAtBottom({ scrollHeight: 320, scrollTop: 0, clientHeight: 480 }),
    true
  )
  assert.ok(
    Math.abs(
      scrollViewportBottomTop({ scrollHeight: 1000.4, scrollTop: 0, clientHeight: 400.2 }) -
        600.2
    ) < 0.0001
  )
})

test('Chat 回复底部只展示模型服务返回的真实 Token 用量', async () => {
  const chatSource = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  assert.match(chatSource, /message\.usage && !message\.usage\.estimated/)
  assert.doesNotMatch(chatSource, /滑动窗口|interruptedUsage|liveUsage/)
  assert.doesNotMatch(chatSource, /实时输出/)
  assert.match(chatSource, /输入.*缓存命中.*输出.*合计/)
  assert.match(chatSource, /当前模型服务未在本轮响应中返回真实 Token 用量/)
})

test('LM Studio 实时速度来自主进程官方日志流而非前端估算', async () => {
  const modelSource = await fs.readFile(path.resolve('src/main/models.ts'), 'utf8')
  const statsSource = await fs.readFile(
    path.resolve('src/main/lm-studio-live-stats.ts'),
    'utf8'
  )
  assert.match(modelSource, /subscribeLmStudioLiveStats/)
  assert.match(statsSource, /spawn\(executable, \['log', 'stream'/)
  assert.match(statsSource, /tg_3s/)
  assert.doesNotMatch(statsSource, /performance\.now|Date\.now\(\).*decodedTokens/)
})

test('精准替换不强制前置读取，但用户编辑锁仍要求读取最新内容', async () => {
  const agentSource = await fs.readFile(path.resolve('src/main/agent.ts'), 'utf8')
  assert.doesNotMatch(agentSource, /编辑前必须先调用 read_file 读取同一文件/)
  assert.doesNotMatch(agentSource, /下一步必须重新调用 read_file 读取同一文件的最新目标区间/)
  assert.match(agentSource, /用户编辑锁：[\s\S]{0,240}必须重新调用 read_file 读取此区间/)
})

test('Agent 只把模型服务真实 Token 用量推送到前端', async () => {
  const agentSource = await fs.readFile(path.resolve('src/main/agent.ts'), 'utf8')
  assert.match(
    agentSource,
    /onUsageProgress: \(usage\) => \{[\s\S]{0,120}if \(usage\.estimated\) return[\s\S]{0,320}type: 'context'/
  )
})

test('模型流严禁根据文本分片估算 Token 或轮询速度', async () => {
  const modelSource = await fs.readFile(path.resolve('src/main/models.ts'), 'utf8')
  assert.doesNotMatch(modelSource, /createLiveTokenUsageTracker|rollingWindowMs|tokenSamples/)
  assert.match(modelSource, /reportProviderUsage\(providerUsage\)/)
  assert.doesNotMatch(
    modelSource,
    /attachGenerationDuration\([\s\S]{0,120}Date\.now\(\) - firstOutputAt/
  )
  await assert.rejects(fs.access(path.resolve('src/main/live-token-usage.ts')))
})

test('生成期间在 Skill 右侧提供当前会话原地截断入口', async () => {
  const chatSource = await fs.readFile(
    path.resolve('src/renderer/src/components/ChatPanel.tsx'),
    'utf8'
  )
  assert.match(chatSource, /running && activePending\?\.\[1\]\.kind !== 'image'/)
  assert.match(chatSource, /className="composer-tool loop-stop-retry"/)
  assert.match(chatSource, /stopLoopAndRetry/)
  assert.match(chatSource, /interruptRepetition/)
  assert.doesNotMatch(chatSource, /retryAfterLoopStopRef/)
  assert.match(chatSource, /终止重发/)
})
