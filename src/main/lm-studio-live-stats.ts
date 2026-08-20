import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type LmStudioLiveStats = {
  taskId: number
  decodedTokens: number
  averageTokensPerSecond: number
  recentTokensPerSecond: number
  final: boolean
  /** 任务开始（launch）时间戳，仅在能确定时提供；用于短轮次的实时速度估算 */
  startAt?: number
}

type Subscription = {
  id: number
  endpoint: string
  model: string
  createdAt: number
  taskId?: number
  latest?: LmStudioLiveStats
  finalWaiters: Array<(stats: LmStudioLiveStats | undefined) => void>
  onStats: (stats: LmStudioLiveStats) => void
}

type RequestMarker = {
  endpoint: string
  createdAt: number
  model?: string
  taskId?: number
}

export type LmStudioLiveStatsSession = {
  latest: () => LmStudioLiveStats | undefined
  waitForFinal: (timeoutMs?: number) => Promise<LmStudioLiveStats | undefined>
  close: () => void
}

const RECEIVED_REQUEST_PATTERN = /Received request:\s*POST to\s+(\/[^\s]+)\s+/i
const MODEL_PATTERN = /\[([^\]]+)]\s+(?:Running chat completion|Streaming response)/i
const LAUNCH_PATTERN = /launch_slot_:\s+id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+processing task[^\n]*is_child\s*=\s*0/i
const LIVE_TIMING_PATTERN = /task\s+(\d+)\s+\|\s+n_decoded\s*=\s*(\d+),\s*tg\s*=\s*([\d.]+)\s*t\/s,\s*tg_3s\s*=\s*([\d.]+)\s*t\/s/i
// 注意：用 \s+eval time（带前导空白）匹配生成阶段的 eval time，避免误命中 prompt eval time
const FINAL_TIMING_PATTERN = /task\s+(\d+)\s+\|\s+eval time\s*=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s+tokens[^\r\n]*?([\d.]+)\s+tokens per second/i
const RELEASE_PATTERN = /release:\s+id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+stop processing/i

/** 单个 LM Studio task（一次 API 调用）的跨行运行态 */
export type LmStudioTaskStatsState = {
  /** launch 时间戳，用于短轮次（<3s、无 tg_3s）实时速度的墙钟估算基线 */
  startAt?: number
  hasFinal: boolean
  /** 最近一次观察到该 task 日志的时间，用于过期清理孤儿任务 */
  lastSeen: number
}

/** 逐行消费 LM Studio server 日志所需的共享状态（bridge 内长期持有） */
export type LmStudioStatsLogState = {
  tasks: Map<number, LmStudioTaskStatsState>
  now?: () => number
}

export function createLmStudioStatsLogState(now?: () => number): LmStudioStatsLogState {
  return { tasks: new Map(), now }
}

function num(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 逐行消费 LM Studio server 日志（bridge 每收到一行调用一次）。
 *
 * - 实时速度优先读 tg_3s；思考时长 <3s 的轮次可能完全没有 tg_3s，只有结束时的 eval time。
 *   这种短轮次的实时显示回退为“已解码 token ÷ 自 launch 起流逝墙钟时间”的估算值——
 *   实时值只是视觉参考，让用户知道大致速度即可。
 * - 一次 API 调用（同一 task）内可能存在多段思考/输出，每段结束时各有一条 eval time。
 *   结束速度直接采用 LM 返回的值：单段即该段的 t/s；同一段被重复打印时取最后一条。
 *   会话级平均 tok 速度由上层对各轮结束速度求算术平均值（如 (40+41+42)/3），见 models.ts addUsage。
 */
export function parseLmStudioServerLog(
  state: LmStudioStatsLogState,
  content: string
): Array<LmStudioLiveStats | null> {
  const now = (state.now ?? Date.now)()
  const results: Array<LmStudioLiveStats | null> = []
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const launch = LAUNCH_PATTERN.exec(line)
    if (launch) {
      state.tasks.set(Number(launch[1]), { startAt: now, hasFinal: false, lastSeen: now })
      results.push(null)
      continue
    }

    const live = LIVE_TIMING_PATTERN.exec(line)
    if (live) {
      const taskId = Number(live[1])
      const decoded = Number(live[2])
      // 仅当已观察到 launch 行时才有可靠的起点；不在此合成时间戳，保持对外对象形状稳定
      const task = state.tasks.get(taskId)
      const recent = Number(live[4])
      let displaySpeed = recent > 0 ? recent : num(live[3])
      if (!(displaySpeed > 0) && task?.startAt) {
        // tg_3s / tg 均不可用（短轮次、<3s）时用墙钟估算兜底，仅作视觉参考
        const elapsedMs = Math.max(0, now - task.startAt)
        if (elapsedMs >= 500 && decoded > 0) displaySpeed = (decoded / elapsedMs) * 1000
      }
      results.push({
        taskId,
        decodedTokens: decoded,
        averageTokensPerSecond: num(live[3]),
        recentTokensPerSecond: displaySpeed,
        final: false,
        ...(task?.startAt ? { startAt: task.startAt } : {})
      })
      continue
    }

    const final = FINAL_TIMING_PATTERN.exec(line)
    if (final) {
      const taskId = Number(final[1])
      // 直接取 LM 返回的 t/s，不自行用 tokens/ms 重算（用户要求：LM 已经给了 eval time）
      const speed = num(final[4])
      // 仅保留 launch 行带来的起点；无 launch 时不合成时间戳，保持对外对象形状稳定
      const startAt = state.tasks.get(taskId)?.startAt
      state.tasks.set(taskId, { startAt, hasFinal: true, lastSeen: now })
      results.push({
        taskId,
        decodedTokens: Number(final[3]),
        averageTokensPerSecond: speed,
        recentTokensPerSecond: speed,
        final: true,
        ...(startAt ? { startAt } : {})
      })
      continue
    }

    const released = RELEASE_PATTERN.exec(line)
    if (released) {
      // 任务释放后清理状态，避免长期运行 Map 无限增长；未绑定的孤儿 task 也一并过期清理
      state.tasks.delete(Number(released[1]))
      results.push(null)
      continue
    }

    results.push(null)
  }
  return results
}

/**
 * @deprecated 兼容旧调用：对单行内容做一次性解析（无跨行状态）。
 */
export function parseLmStudioServerStats(content: string): LmStudioLiveStats | null {
  const oneShot = createLmStudioStatsLogState()
  for (const result of parseLmStudioServerLog(oneShot, content)) {
    if (result) return result
  }
  return null
}

function normalizedModel(value: string): string {
  return value.trim().toLowerCase()
}

class LmStudioServerStatsBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private startPromise: Promise<void> | null = null
  private nextSubscriptionId = 1
  private readonly subscriptions = new Map<number, Subscription>()
  private readonly subscriptionsByTask = new Map<number, Subscription>()
  private readonly requestMarkers: RequestMarker[] = []
  private readonly statsState = createLmStudioStatsLogState()

  async subscribe(
    model: string,
    endpoint: string,
    onStats: (stats: LmStudioLiveStats) => void
  ): Promise<LmStudioLiveStatsSession | null> {
    if (!(await this.ensureStarted())) return null
    const subscription: Subscription = {
      id: this.nextSubscriptionId++,
      endpoint,
      model,
      createdAt: Date.now(),
      finalWaiters: [],
      onStats
    }
    this.subscriptions.set(subscription.id, subscription)
    return {
      latest: () => subscription.latest,
      waitForFinal: (timeoutMs = 350) => {
        if (subscription.latest?.final) return Promise.resolve(subscription.latest)
        return new Promise((resolve) => {
          let settled = false
          const finish = (stats: LmStudioLiveStats | undefined): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            const waiterIndex = subscription.finalWaiters.indexOf(finish)
            if (waiterIndex >= 0) subscription.finalWaiters.splice(waiterIndex, 1)
            resolve(stats)
          }
          const timer = setTimeout(() => finish(subscription.latest), timeoutMs)
          subscription.finalWaiters.push(finish)
        })
      },
      close: () => this.closeSubscription(subscription)
    }
  }

  private async ensureStarted(): Promise<boolean> {
    if (this.startPromise) {
      await this.startPromise
      return Boolean(this.child && !this.child.killed)
    }
    if (this.child && !this.child.killed) return true
    this.startPromise = new Promise<void>((resolve) => {
      const executable = this.resolveExecutable()
      const child = spawn(executable, ['log', 'stream', '--json', '--source', 'server'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.child = child
      let resolved = false
      const ready = (): void => {
        if (resolved) return
        resolved = true
        resolve()
      }
      const readyTimer = setTimeout(ready, 2_500)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.consumeStdout(chunk))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', ready)
      child.once('error', () => {
        clearTimeout(readyTimer)
        this.child = null
        ready()
      })
      child.once('exit', () => {
        clearTimeout(readyTimer)
        this.child = null
        this.stdoutBuffer = ''
        ready()
      })
    }).finally(() => {
      this.startPromise = null
    })
    await this.startPromise
    return Boolean(this.child && !this.child.killed)
  }

  private resolveExecutable(): string {
    const configured = process.env.LMS_CLI_PATH?.trim()
    if (configured) return configured
    const bundled = path.join(homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms')
    return existsSync(bundled) ? bundled : 'lms'
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const payload = JSON.parse(trimmed) as {
          data?: { type?: string; content?: string }
        }
        if (payload.data?.type !== 'server.log' || !payload.data.content) continue
        this.consumeServerLog(payload.data.content)
      } catch {
        // LM Studio 偶尔会把非 JSON 启动提示写入流，直接忽略即可。
      }
    }
  }

  private consumeServerLog(content: string): void {
    const now = Date.now()
    const received = RECEIVED_REQUEST_PATTERN.exec(content)
    if (received) {
      this.requestMarkers.push({ endpoint: received[1], createdAt: now })
      this.pruneMarkers(now)
      return
    }
    const model = MODEL_PATTERN.exec(content)
    if (model) {
      const marker = [...this.requestMarkers]
        .reverse()
        .find((item) => !item.model && !item.taskId && now - item.createdAt < 5_000)
      if (marker) marker.model = model[1]
      return
    }
    const launch = LAUNCH_PATTERN.exec(content)
    if (launch) {
      // 先记录任务起点（供短轮次实时速度估算），再绑定订阅
      parseLmStudioServerLog(this.statsState, content)
      const taskId = Number(launch[1])
      const marker = [...this.requestMarkers]
        .reverse()
        .find((item) => !item.taskId && now - item.createdAt < 5_000)
      if (!marker) return
      marker.taskId = taskId
      const candidates = [...this.subscriptions.values()]
        .filter(
          (item) =>
            item.taskId === undefined &&
            item.endpoint === marker.endpoint &&
            item.createdAt <= now &&
            (!marker.model || normalizedModel(item.model) === normalizedModel(marker.model))
        )
        .sort((left, right) => left.createdAt - right.createdAt)
      const subscription = candidates[0]
      if (subscription) {
        subscription.taskId = taskId
        this.subscriptionsByTask.set(taskId, subscription)
      }
      return
    }
    for (const stats of parseLmStudioServerLog(this.statsState, content)) {
      if (!stats) continue
      const subscription = this.subscriptionsByTask.get(stats.taskId)
      if (!subscription) continue
      subscription.latest = stats
      subscription.onStats(stats)
      if (stats.final) this.resolveFinalWaiters(subscription)
    }
  }

  private resolveFinalWaiters(subscription: Subscription): void {
    const waiters = subscription.finalWaiters.splice(0)
    for (const resolve of waiters) resolve(subscription.latest)
  }


  private closeSubscription(subscription: Subscription): void {
    this.resolveFinalWaiters(subscription)
    this.subscriptions.delete(subscription.id)
    if (subscription.taskId !== undefined) {
      this.subscriptionsByTask.delete(subscription.taskId)
    }
  }

  private pruneMarkers(now: number): void {
    while (this.requestMarkers.length > 40 || now - (this.requestMarkers[0]?.createdAt ?? now) > 30_000) {
      this.requestMarkers.shift()
    }
  }
}

const bridge = new LmStudioServerStatsBridge()

export async function subscribeLmStudioLiveStats(
  model: string,
  endpoint: string,
  onStats: (stats: LmStudioLiveStats) => void
): Promise<LmStudioLiveStatsSession | null> {
  return bridge.subscribe(model, endpoint, onStats)
}
