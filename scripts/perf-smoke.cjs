const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const port = 9380 + Math.floor(Math.random() * 100)
;(async () => {
const profile = await mkdtemp(path.join(tmpdir(), 'xingban-perf-'))
const child = spawn(
  electron,
  ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`],
  { cwd: root, stdio: 'ignore', windowsHide: true }
)

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function target() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) =>
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
  const page = await target()
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
  return {
    socket,
    evaluate(expression, awaitPromise = false) {
      return new Promise((resolve, reject) => {
        id += 1
        pending.set(id, { resolve, reject })
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, awaitPromise, returnByValue: true }
          })
        )
      }).then((result) => result.result?.value)
    }
  }
}

try {
  let client = await connect()
  await client.evaluate(`(() => {
    const createdAt = Date.now() - 100000;
    const messages = [];
    for (let index = 0; index < 120; index += 1) {
      messages.push({
        id: 'user-' + index,
        role: 'user',
        content: '历史问题 ' + index + '：' + '内容 '.repeat(300),
        createdAt: createdAt + index * 2,
        status: 'done'
      });
      messages.push({
        id: 'assistant-' + index,
        role: 'assistant',
        content: '历史回复 ' + index + '\\n\\n' + ('**结果**：测试长会话渲染。\\n'.repeat(80)),
        createdAt: createdAt + index * 2 + 1,
        status: 'done'
      });
    }
    const blocks = [];
    for (let index = 0; index < 480; index += 1) {
      blocks.push({
        id: 'thinking-' + index,
        type: 'thinking',
        content: '### 思考过程 ' + index + '\\n\\n' + ('- 性能测试内容\\n'.repeat(45)),
        status: 'done',
        createdAt: createdAt + 500 + index,
        updatedAt: createdAt + 500 + index
      });
    }
    messages.push({
      id: 'stress-assistant',
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'done',
      agentBlocks: blocks
    });
    localStorage.setItem('local-agent-studio', JSON.stringify({
      version: 9,
      state: {
        workspaceRoot: '',
        workspaceRoots: [],
        model: { provider: 'ollama', baseUrl: '', model: '' },
        globalInstructions: '',
        skills: [],
        agentPermissionMode: 'confirm',
        tokenUsageRecords: [],
        comfyBaseUrl: 'http://127.0.0.1:8188',
        comfyWorkflows: [],
        selectedComfyWorkflowId: '',
        conversations: [{
          id: 'stress',
          title: '长会话压力测试',
          mode: 'agent',
          messages,
          createdAt,
          updatedAt: Date.now()
        }],
        activeConversationId: 'stress'
      }
    }));
    location.reload();
    return true;
  })()`)
  client.socket.close()
  await delay(1800)
  client = await connect()
  const metrics = await client.evaluate(`(async () => {
    const frame = await new Promise((resolve) => {
      const gaps = [];
      let previous = performance.now();
      const startedAt = previous;
      const tick = (now) => {
        gaps.push(now - previous);
        previous = now;
        if (gaps.length >= 90) {
          resolve({
            elapsed: now - startedAt,
            maxGap: Math.max(...gaps),
            over50ms: gaps.filter((gap) => gap > 50).length
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const persisted = JSON.parse(localStorage.getItem('local-agent-studio'));
    const latest = persisted.state.conversations[0].messages.at(-1);
    return {
      title: document.title,
      viewport: [innerWidth, innerHeight],
      documentScroll: {
        x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight > document.documentElement.clientHeight
      },
      persistedBytes: localStorage.getItem('local-agent-studio').length,
      persistedBlocks: latest.agentBlocks.length,
      renderedStepCards: document.querySelectorAll('.agent-step-card').length,
      renderedMessages: document.querySelectorAll('.message-card').length,
      frame
    };
  })()`, true)
  console.log(JSON.stringify(metrics, null, 2))
  client.socket.close()
} finally {
  child.kill()
  await delay(300)
  await rm(profile, { recursive: true, force: true })
}
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
