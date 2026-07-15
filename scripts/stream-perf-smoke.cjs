const { spawn, spawnSync } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const http = require('node:http')
const { tmpdir } = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const debugPort = 9480 + Math.floor(Math.random() * 100)
const modelPort = 9580 + Math.floor(Math.random() * 100)
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const cumulativeSnapshots = process.env.STREAM_MODE !== 'delta'
const slowFirstChunk = process.env.STREAM_SLOW_FIRST === '1'
const useRealLm = process.env.USE_REAL_LM === '1'
const triggerCompression = process.env.TRIGGER_COMPRESSION === '1'
const twoTurns = process.env.TWO_TURNS === '1'
const selectedModel = useRealLm
  ? 'qwen3.5-9b-uncensored-hauhaucs-aggressive'
  : 'stream-stress-model'
const selectedBaseUrl = useRealLm
  ? 'http://127.0.0.1:1234/v1'
  : `http://127.0.0.1:${modelPort}/v1`
let expectedThinkingCharacters = 0
let sentThinkingCharacters = 0
const sentPayloadLengths = []
let compressionRequests = 0
let normalRequests = 0
const requestStats = []

async function waitForTarget() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) =>
        response.json()
      )
      const page = targets.find((item) => item.type === 'page')
      if (page) return page
    } catch {}
    await delay(100)
  }
  throw new Error('Electron renderer did not start')
}

async function connect() {
  const page = await waitForTarget()
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const handler = pending.get(message.id)
    if (!handler) return
    pending.delete(message.id)
    if (message.error) handler.reject(new Error(message.error.message))
    else handler.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const handler of pending.values()) {
      handler.reject(new Error('DevTools connection closed'))
    }
    pending.clear()
  })
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`DevTools call timed out: ${method}`))
      }, 30_000)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return {
    socket,
    call,
    evaluate(expression, awaitPromise = false) {
      return call('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true
      }).then((result) => {
        if (result.exceptionDetails) {
          throw new Error(
            result.exceptionDetails.exception?.description ||
              result.exceptionDetails.text ||
              'Renderer evaluation failed'
          )
        }
        return result.result?.value
      })
    }
  }
}

function createModelServer() {
  return http.createServer((request, response) => {
    if (request.url?.endsWith('/models')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'stream-stress-model' }] }))
      return
    }
    if (!request.url?.endsWith('/chat/completions')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [] }))
      return
    }
    let requestBody = ''
    request.on('data', (chunk) => {
      requestBody += chunk
    })
    request.on('end', () => {
      const parsedRequest = JSON.parse(requestBody || '{}')
      requestStats.push({
        compression: requestBody.includes('压缩智能体历史上下文'),
        messageLengths: (parsedRequest.messages || []).map((message) => message.content?.length || 0),
        hasMemory: (parsedRequest.messages || []).some((message) =>
          message.content?.includes('<compressed_context>')
        )
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      if (requestBody.includes('压缩智能体历史上下文')) {
        compressionRequests += 1
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: '保留项目目标、关键路径、用户约束与已验证结果。' } }],
            usage: { prompt_tokens: 1500, completion_tokens: 24 }
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }
      normalRequests += 1
      let index = 0
      let accumulatedReasoning = ''
      const chunkCount = 400
      const sendNext = () => {
      const reasoning = `第 ${index + 1} 段：持续输出压力测试，验证前端队列合并与增量 Markdown 渲染。${'稳定输出内容。'.repeat(8)}`
      accumulatedReasoning += reasoning
      expectedThinkingCharacters = accumulatedReasoning.length
      const outgoingReasoning = cumulativeSnapshots ? accumulatedReasoning : reasoning
      sentThinkingCharacters += outgoingReasoning.length
      if (sentPayloadLengths.length < 4) sentPayloadLengths.push(outgoingReasoning.length)
      response.write(
        `data: ${JSON.stringify({
          choices: [{
            delta: {
              reasoning_content: outgoingReasoning
            }
          }]
        })}\n\n`
      )
      index += 1
      if (index < chunkCount) {
        setTimeout(sendNext, slowFirstChunk && index === 1 ? 800 : 5)
        return
      }
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: '长思考压力测试完成。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 12_000 }
        })}\n\n`
      )
      response.end('data: [DONE]\n\n')
      }
      setTimeout(sendNext, 5)
    })
  })
}

;(async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'xingban-stream-perf-'))
  const server = useRealLm ? null : createModelServer()
  if (server) {
    await new Promise((resolve) => server.listen(modelPort, '127.0.0.1', resolve))
  }
  const child = spawn(
    electron,
    ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`],
    { cwd: root, stdio: 'ignore', windowsHide: true }
  )
  try {
    let client = await connect()
    await client.evaluate(`(() => {
      const now = Date.now();
      const seededMessages = ${
        triggerCompression
          ? `Array.from({ length: 12 }, (_, index) => ({
              id: 'seed-' + index,
              role: index % 2 === 0 ? 'user' : 'assistant',
              content: '历史上下文 ' + index + '：' + '需要保留的项目目标、文件路径与验证结果。'.repeat(80),
              createdAt: now - 20000 + index,
              status: 'done'
            }))`
          : '[]'
      };
      localStorage.setItem('local-agent-studio', JSON.stringify({
        version: 11,
        state: {
          workspaceRoot: '',
          workspaceRoots: [],
          model: {
            provider: 'openai',
            baseUrl: '${selectedBaseUrl}',
            model: '${selectedModel}',
            contextLength: ${triggerCompression ? 2048 : 131072}
          },
          globalInstructions: '',
          skills: [],
          agentPermissionMode: 'confirm',
          tokenUsageRecords: [],
          comfyBaseUrl: 'http://127.0.0.1:8188',
          comfyWorkflows: [],
          selectedComfyWorkflowId: '',
          conversations: [{
            id: 'stream-stress',
            title: '实时流压力测试',
            mode: 'chat',
            messages: seededMessages,
            createdAt: now,
            updatedAt: now
          }],
          activeConversationId: 'stream-stress'
        }
      }));
      location.reload();
      return true;
    })()`)
    client.socket.close()
    await delay(1_200)
    client = await connect()
    await client.evaluate(`(() => {
      window.__streamPerf = {
        lengths: [],
        gaps: [],
        previous: performance.now(),
        startedAt: performance.now(),
        firstThoughtAt: 0,
        receivedReasoningCharacters: 0,
        receivedReasoningEvents: 0,
        receivedReasoning: ''
      };
      window.__streamPerf.unsubscribe = window.localAgent.chat.onEvent((event) => {
        if (event.type !== 'reasoning') return;
        window.__streamPerf.receivedReasoningCharacters += event.content?.length || 0;
        window.__streamPerf.receivedReasoningEvents += 1;
        window.__streamPerf.receivedReasoning += event.content || '';
      });
      window.__streamPerf.timer = setInterval(() => {
        const now = performance.now();
        window.__streamPerf.gaps.push(now - window.__streamPerf.previous);
        window.__streamPerf.previous = now;
        const assistants = document.querySelectorAll('.message-card.assistant');
        const latestAssistant = assistants[assistants.length - 1];
        const value = latestAssistant?.querySelector('.thinking-markdown')?.textContent?.length || 0;
        if (value > 0 && !window.__streamPerf.firstThoughtAt) {
          window.__streamPerf.firstThoughtAt = performance.now();
        }
        if (window.__streamPerf.lengths.at(-1) !== value) {
          window.__streamPerf.lengths.push(value);
        }
      }, 16);
      const input = document.querySelector('.composer textarea');
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      ).set;
      setter.call(input, '${
        useRealLm ? '请用一句话回答：1+1等于几？' : '执行超长思考压力测试'
      }');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.send-button[title="发送"]').click();
      return true;
    })()`)
    await delay(1_200)
    const scrollBox = await client.evaluate(`(() => {
      const element = document.querySelector('.thinking-virtual-list');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.right - 5,
        top: rect.top + 14,
        bottom: rect.bottom - 14
      };
    })()`)
    if (scrollBox) {
      await client.call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: scrollBox.x,
        y: scrollBox.bottom,
        button: 'left',
        clickCount: 1
      })
      for (let step = 1; step <= 12; step += 1) {
        await client.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: scrollBox.x,
          y: scrollBox.bottom - ((scrollBox.bottom - scrollBox.top) * step) / 12,
          button: 'left',
          buttons: 1
        })
        await delay(12)
      }
      await client.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: scrollBox.x,
        y: scrollBox.top,
        button: 'left',
        clickCount: 1
      })
      await client.evaluate('window.__streamPerf.dragPerformed = true')
    }
    const result = await client.evaluate(`(async () => {
      const waitForCompletion = async () => {
        const startedAt = performance.now();
        while (performance.now() - startedAt < 20000) {
          const stopButton = document.querySelector('.send-button.stop');
          if (!stopButton) return true;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return false;
      };
      await waitForCompletion();
      let secondThoughtDelay = 0;
      let secondReasoningCharacters = 0;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const firstTurnPersisted = JSON.parse(localStorage.getItem('local-agent-studio'));
      const firstTurnCheckpoint =
        firstTurnPersisted.state.conversations[0].contextMemory?.throughMessageId || '';
      if (${twoTurns}) {
        const readyStartedAt = performance.now();
        while (
          !document.querySelector('.send-button[title="发送"]') &&
          performance.now() - readyStartedAt < 5000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const beforeReasoning = window.__streamPerf.receivedReasoningCharacters;
        window.__streamPerf.firstThoughtAt = 0;
        window.__streamPerf.startedAt = performance.now();
        window.__streamPerf.lengths = [];
        const input = document.querySelector('.composer textarea');
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          'value'
        ).set;
        setter.call(input, '这是第二轮消息，请继续回答。');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.send-button[title="发送"]').click();
        const secondStartedAt = performance.now();
        while (!window.__streamPerf.firstThoughtAt && performance.now() - secondStartedAt < 10000) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        secondThoughtDelay = window.__streamPerf.firstThoughtAt
          ? window.__streamPerf.firstThoughtAt - window.__streamPerf.startedAt
          : -1;
        await waitForCompletion();
        secondReasoningCharacters =
          window.__streamPerf.receivedReasoningCharacters - beforeReasoning;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      clearInterval(window.__streamPerf.timer);
      window.__streamPerf.unsubscribe();
      const thought = document.querySelector('.thinking-markdown');
      const lengths = window.__streamPerf.lengths;
      const gaps = window.__streamPerf.gaps;
      const persisted = JSON.parse(localStorage.getItem('local-agent-studio'));
      const latestAssistant = persisted.state.conversations[0].messages
        .filter((message) => message.role === 'assistant')
        .at(-1);
      const persistedThinking = latestAssistant?.agentBlocks
        ?.find((block) => block.type === 'thinking')
        ?.content || '';
      const contextMemory = persisted.state.conversations[0].contextMemory;
      return {
        finalThinkingCharacters: persistedThinking.length,
        mountedThinkingCharacters: thought?.textContent?.length || 0,
        visibleRefreshes: lengths.length,
        firstVisibleLength: lengths[0] || 0,
        finalVisibleLength: lengths.at(-1) || 0,
        segmentCount: document.querySelectorAll('.thinking-markdown-segment').length,
        receivedReasoningCharacters: window.__streamPerf.receivedReasoningCharacters,
        receivedReasoningEvents: window.__streamPerf.receivedReasoningEvents,
        compressionRuns:
          (window.__streamPerf.receivedReasoning.match(/正在压缩上下文/g) || []).length,
        hasPersistedContextMemory: Boolean(contextMemory?.summary && contextMemory?.throughMessageId),
        contextMemoryCheckpoint: contextMemory?.throughMessageId || '',
        dragPerformed: Boolean(window.__streamPerf.dragPerformed),
        firstThoughtDelay:
          window.__streamPerf.firstThoughtAt - window.__streamPerf.startedAt,
        secondThoughtDelay,
        secondReasoningCharacters,
        firstTurnCheckpoint,
        maxMainThreadGap: Math.max(...gaps),
        gapsOver50ms: gaps.filter((gap) => gap > 50).length,
        completed: Boolean(document.body.textContent.includes('长思考压力测试完成'))
      };
    })()`, true)
    console.log(
      JSON.stringify(
        {
          ...result,
          streamMode: cumulativeSnapshots ? 'cumulative-snapshot' : 'delta',
          source: useRealLm ? 'real-lm-studio' : 'fake-server',
          expectedThinkingCharacters,
          sentThinkingCharacters,
          sentPayloadLengths,
          compressionRequests,
          normalRequests,
          requestStats,
          normalizedWithoutDuplication:
            result.finalThinkingCharacters === expectedThinkingCharacters
        },
        null,
        2
      )
    )
    client.socket.close()
  } finally {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    })
    server?.closeAllConnections()
    server?.close()
    await delay(800)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
