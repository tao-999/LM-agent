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
const FINAL_TIMING_PATTERN = /task\s+(\d+)\s+\|[\s\S]*?\|\s+eval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s+tokens[^\r\n]*?([\d.]+)\s+tokens per second/i
const RELEASE_PATTERN = /release:\s+id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+stop processing/i

export function parseLmStudioServerStats(content: string): LmStudioLiveStats | null {
  const live = LIVE_TIMING_PATTERN.exec(content)
  if (live) {
    return {
      taskId: Number(live[1]),
      decodedTokens: Number(live[2]),
      averageTokensPerSecond: Number(live[3]),
      recentTokensPerSecond: Number(live[4]),
      final: false
    }
  }
  const final = FINAL_TIMING_PATTERN.exec(content)
  if (final) {
    return {
      taskId: Number(final[1]),
      decodedTokens: Number(final[2]),
      averageTokensPerSecond: Number(final[3]),
      recentTokensPerSecond: Number(final[3]),
      final: true
    }
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
    const stats = parseLmStudioServerStats(content)
    if (stats) {
      const subscription = this.subscriptionsByTask.get(stats.taskId)
      if (!subscription) return
      subscription.latest = stats
      subscription.onStats(stats)
      if (stats.final) this.resolveFinalWaiters(subscription)
      return
    }
    const released = RELEASE_PATTERN.exec(content)
    if (released) {
      const subscription = this.subscriptionsByTask.get(Number(released[1]))
      if (subscription) this.resolveFinalWaiters(subscription)
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
