import { useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileInput,
  KeyRound,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import type {
  ModelConfig,
  ModelOption,
  SkillDefinition,
  TokenUsageRecord
} from '../../../shared/types'
import { useAppStore } from '../store'
import { MacSelect } from './MacSelect'

const uid = (): string => crypto.randomUUID()

function formatTokens(value: number): string {
  const formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
  if (value >= 100_000_000) return `${formatter.format(value / 100_000_000)}亿`
  if (value >= 10_000) return `${formatter.format(value / 10_000)}万`
  return value.toLocaleString()
}

function TokenCalendar({ records }: { records: TokenUsageRecord[] }): React.JSX.Element {
  const [month, setMonth] = useState(() => {
    const today = new Date()
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  const [selectedDay, setSelectedDay] = useState('')
  const year = month.getFullYear()
  const monthIndex = month.getMonth()
  const days = new Date(year, monthIndex + 1, 0).getDate()
  const leading = new Date(year, monthIndex, 1).getDay()
  const keyFor = (day: number): string =>
    `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const daily = new Map<string, TokenUsageRecord[]>()
  records.forEach((record) => {
    const date = new Date(record.timestamp)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    daily.set(key, [...(daily.get(key) ?? []), record])
  })
  const totals = Array.from({ length: days }, (_, index) => {
    const items = daily.get(keyFor(index + 1)) ?? []
    return items.reduce((sum, item) => sum + item.totalTokens, 0)
  })
  const monthTotal = totals.reduce((sum, value) => sum + value, 0)
  const monthCalls = Array.from({ length: days }, (_, index) =>
    (daily.get(keyFor(index + 1)) ?? []).length
  ).reduce((sum, value) => sum + value, 0)
  const maxDaily = Math.max(1, ...totals)
  const selectedRecords = selectedDay ? daily.get(selectedDay) ?? [] : []
  const selectedPrompt = selectedRecords.reduce((sum, item) => sum + item.promptTokens, 0)
  const selectedCompletion = selectedRecords.reduce((sum, item) => sum + item.completionTokens, 0)

  return (
    <div className="token-calendar">
      <header>
        <button
          className="icon-button"
          onClick={() => setMonth(new Date(year, monthIndex - 1, 1))}
        >
          <ChevronLeft size={14} />
        </button>
        <div>
          <strong>
            {year} 年 {monthIndex + 1} 月
          </strong>
          <span>月累计 {formatTokens(monthTotal)} Token · {monthCalls} 次调用</span>
        </div>
        <button
          className="icon-button"
          onClick={() => setMonth(new Date(year, monthIndex + 1, 1))}
        >
          <ChevronRight size={14} />
        </button>
      </header>
      <div className="token-weekdays">
        {'日一二三四五六'.split('').map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="token-days">
        {Array.from({ length: leading }, (_, index) => (
          <i key={`empty-${index}`} />
        ))}
        {Array.from({ length: days }, (_, index) => {
          const day = index + 1
          const key = keyFor(day)
          const total = totals[index]
          const intensity = total ? Math.max(0.18, total / maxDaily) : 0
          return (
            <button
              key={key}
              className={`${total ? 'used' : ''} ${selectedDay === key ? 'selected' : ''}`}
              style={{ '--heat': intensity } as React.CSSProperties}
              onClick={() => setSelectedDay(key)}
              title={`${key} · ${formatTokens(total)} Token`}
            >
              <span>{day}</span>
              <small>{total ? formatTokens(total) : ''}</small>
            </button>
          )
        })}
      </div>
      <div className="token-calendar-detail">
        {selectedDay ? (
          <>
            <strong>{selectedDay}</strong>
            <span>{selectedRecords.length} 次调用</span>
            <span>输入 {formatTokens(selectedPrompt)}</span>
            <span>输出 {formatTokens(selectedCompletion)}</span>
          </>
        ) : (
          <span>点击日期查看输入与输出明细</span>
        )}
      </div>
    </div>
  )
}

type TokenChartRange = 'all' | 'day' | '30d' | 'month' | 'custom'

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function dateBoundary(value: string, endOfDay = false): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return endOfDay ? Number.MAX_SAFE_INTEGER : 0
  const [year, month, day] = value.split('-').map(Number)
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
    : new Date(year, month - 1, day).getTime()
}

function TokenModelChartModal({
  records,
  onClose
}: {
  records: TokenUsageRecord[]
  onClose: () => void
}): React.JSX.Element {
  const [range, setRange] = useState<TokenChartRange>('all')
  const today = new Date()
  const todayKey = localDateKey(today)
  const [selectedDay, setSelectedDay] = useState(todayKey)
  const [rangeStart, setRangeStart] = useState(
    localDateKey(new Date(today.getFullYear(), today.getMonth(), 1))
  )
  const [rangeEnd, setRangeEnd] = useState(todayKey)
  const [selectedModelKey, setSelectedModelKey] = useState('')
  const [detailPage, setDetailPage] = useState(1)
  const summary = useMemo(() => {
    const now = new Date()
    let startAt = 0
    let endAt = Number.MAX_SAFE_INTEGER
    if (range === 'day') {
      startAt = dateBoundary(selectedDay)
      endAt = dateBoundary(selectedDay, true)
    } else if (range === '30d') {
      startAt = Date.now() - 30 * 24 * 60 * 60 * 1000
    } else if (range === 'month') {
      startAt = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    } else if (range === 'custom') {
      const first = dateBoundary(rangeStart)
      const last = dateBoundary(rangeEnd, true)
      startAt = Math.min(first, dateBoundary(rangeEnd))
      endAt = Math.max(dateBoundary(rangeStart, true), last)
    }
    const groups = new Map<
      string,
      {
        key: string
        model: string
        provider: string
        promptTokens: number
        cachedPromptTokens: number
        completionTokens: number
        totalTokens: number
        calls: number
        timedCompletionTokens: number
        generationDurationMs: number
        records: TokenUsageRecord[]
      }
    >()
    records
      .filter((record) => record.timestamp >= startAt && record.timestamp <= endAt)
      .forEach((record) => {
        const modelName = record.model?.trim() || '未命名模型'
        const key = `${record.provider}:${modelName}`
        const current = groups.get(key) ?? {
          key,
          model: modelName,
          provider: record.provider,
          promptTokens: 0,
          cachedPromptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          calls: 0,
          timedCompletionTokens: 0,
          generationDurationMs: 0,
          records: []
        }
        current.promptTokens += record.promptTokens
        current.cachedPromptTokens += record.cachedPromptTokens ?? 0
        current.completionTokens += record.completionTokens
        current.totalTokens += record.totalTokens
        current.calls += 1
        current.records.push(record)
        if ((record.generationDurationMs ?? 0) > 0) {
          current.timedCompletionTokens += record.completionTokens
          current.generationDurationMs += record.generationDurationMs ?? 0
        }
        groups.set(key, current)
      })
    const models = [...groups.values()].sort((left, right) => right.totalTokens - left.totalTokens)
    models.forEach((item) => item.records.sort((left, right) => right.timestamp - left.timestamp))
    return {
      models,
      promptTokens: models.reduce((sum, item) => sum + item.promptTokens, 0),
      cachedPromptTokens: models.reduce((sum, item) => sum + item.cachedPromptTokens, 0),
      completionTokens: models.reduce((sum, item) => sum + item.completionTokens, 0),
      totalTokens: models.reduce((sum, item) => sum + item.totalTokens, 0),
      calls: models.reduce((sum, item) => sum + item.calls, 0),
      maxTokens: Math.max(1, ...models.map((item) => item.totalTokens))
    }
  }, [range, rangeEnd, rangeStart, records, selectedDay])
  const selectedModel = summary.models.find((item) => item.key === selectedModelKey)
  useEffect(() => {
    setDetailPage(1)
  }, [range, rangeEnd, rangeStart, selectedDay])
  useEffect(() => {
    if (selectedModelKey && !summary.models.some((item) => item.key === selectedModelKey)) {
      setSelectedModelKey('')
    }
  }, [selectedModelKey, summary.models])
  const detailPageSize = 30
  const detailPageCount = selectedModel
    ? Math.max(1, Math.ceil(selectedModel.records.length / detailPageSize))
    : 1
  const detailRecords = selectedModel
    ? selectedModel.records.slice((detailPage - 1) * detailPageSize, detailPage * detailPageSize)
    : []
  const detailMaxTokens = Math.max(1, ...detailRecords.map((record) => record.totalTokens))

  return (
    <div className="token-chart-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="token-chart-modal"
        role="dialog"
        aria-modal="true"
        aria-label="模型 Token 统计"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="token-chart-header">
          <div>
            <span className="eyebrow">用量分析</span>
            <h2>模型 Token 图表</h2>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭图表">
            <X size={17} />
          </button>
        </header>

        <div className="token-chart-content">
          <div className="token-chart-toolbar">
            <div className="token-chart-ranges" role="group" aria-label="统计时间范围">
              {([
                ['all', '全部'],
                ['day', '指定日期'],
                ['30d', '近 30 天'],
                ['month', '本月'],
                ['custom', '日期区间']
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  className={range === value ? 'active' : ''}
                  onClick={() => setRange(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="token-chart-legend">
              <span><i className="input" />输入</span>
              <span><i className="output" />输出</span>
            </div>
          </div>

          {range === 'day' && (
            <div className="token-chart-date-filter">
              <label>
                统计日期
                <input
                  type="date"
                  value={selectedDay}
                  onChange={(event) => setSelectedDay(event.target.value || todayKey)}
                />
              </label>
            </div>
          )}

          {range === 'custom' && (
            <div className="token-chart-date-filter range">
              <label>
                开始日期
                <input
                  type="date"
                  value={rangeStart}
                  onChange={(event) => setRangeStart(event.target.value || todayKey)}
                />
              </label>
              <span>至</span>
              <label>
                结束日期
                <input
                  type="date"
                  value={rangeEnd}
                  onChange={(event) => setRangeEnd(event.target.value || todayKey)}
                />
              </label>
            </div>
          )}

          <div className="token-chart-summary">
            <article><span>输入</span><strong>{formatTokens(summary.promptTokens)}</strong></article>
            <article><span>缓存命中</span><strong>{formatTokens(summary.cachedPromptTokens)}</strong></article>
            <article><span>输出</span><strong>{formatTokens(summary.completionTokens)}</strong></article>
            <article><span>合计</span><strong>{formatTokens(summary.totalTokens)}</strong></article>
            <article><span>调用</span><strong>{summary.calls.toLocaleString()}</strong></article>
            <article>
              <span>缓存命中率</span>
              <strong>
                {summary.promptTokens > 0
                  ? `${((summary.cachedPromptTokens / summary.promptTokens) * 100).toFixed(1)}%`
                  : '0%'}
              </strong>
            </article>
          </div>

          {summary.models.length === 0 ? (
            <div className="token-chart-empty">
              <BarChart3 size={28} />
              <span>当前范围还没有 Token 记录</span>
            </div>
          ) : selectedModel ? (
            <div className="token-call-detail">
              <header className="token-call-detail-header">
                <button
                  className="ghost-button"
                  onClick={() => {
                    setSelectedModelKey('')
                    setDetailPage(1)
                  }}
                >
                  <ChevronLeft size={13} /> 返回模型总览
                </button>
                <div>
                  <strong>{selectedModel.model}</strong>
                  <span>{selectedModel.records.length.toLocaleString()} 次调用</span>
                </div>
              </header>
              <div className="token-call-list">
                {detailRecords.map((record, index) => {
                  const inputWidth = (record.promptTokens / detailMaxTokens) * 100
                  const outputWidth = (record.completionTokens / detailMaxTokens) * 100
                  const speed =
                    record.tokensPerSecond ??
                    ((record.generationDurationMs ?? 0) > 0
                      ? record.completionTokens / ((record.generationDurationMs ?? 1) / 1000)
                      : 0)
                  return (
                    <article className="token-call-row" key={record.id}>
                      <div className="token-call-heading">
                        <div>
                          <b>#{(detailPage - 1) * detailPageSize + index + 1}</b>
                          <strong>{new Date(record.timestamp).toLocaleString('zh-CN')}</strong>
                          <span>{record.kind}</span>
                        </div>
                        <b>{formatTokens(record.totalTokens)} Token</b>
                      </div>
                      <div className="token-model-bar">
                        <i className="input" style={{ width: `${inputWidth}%` }} />
                        <i className="output" style={{ width: `${outputWidth}%` }} />
                      </div>
                      <div className="token-model-metrics">
                        <span>输入 {formatTokens(record.promptTokens)}</span>
                        <span>缓存 {formatTokens(record.cachedPromptTokens ?? 0)}</span>
                        <span>输出 {formatTokens(record.completionTokens)}</span>
                        <span>{speed > 0 ? `${speed.toFixed(2)} Tok/s` : '速度暂无'}</span>
                      </div>
                    </article>
                  )
                })}
              </div>
              {detailPageCount > 1 && (
                <footer className="token-call-pagination">
                  <button
                    className="icon-button"
                    disabled={detailPage <= 1}
                    onClick={() => setDetailPage((value) => Math.max(1, value - 1))}
                    title="上一页"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>{detailPage} / {detailPageCount}</span>
                  <button
                    className="icon-button"
                    disabled={detailPage >= detailPageCount}
                    onClick={() => setDetailPage((value) => Math.min(detailPageCount, value + 1))}
                    title="下一页"
                  >
                    <ChevronRight size={14} />
                  </button>
                </footer>
              )}
            </div>
          ) : (
            <div className="token-model-list">
              {summary.models.map((item) => {
                const inputWidth = (item.promptTokens / summary.maxTokens) * 100
                const outputWidth = (item.completionTokens / summary.maxTokens) * 100
                const speed =
                  item.generationDurationMs > 0
                    ? item.timedCompletionTokens / (item.generationDurationMs / 1000)
                    : 0
                return (
                  <article className="token-model-row" key={`${item.provider}:${item.model}`}>
                    <div className="token-model-heading">
                      <div>
                        <strong title={item.model}>{item.model}</strong>
                        <span>{item.provider}</span>
                      </div>
                      <b>{formatTokens(item.totalTokens)} Token</b>
                    </div>
                    <div className="token-model-bar" aria-label={`${item.model} Token 分布`}>
                      <i className="input" style={{ width: `${inputWidth}%` }} />
                      <i className="output" style={{ width: `${outputWidth}%` }} />
                    </div>
                    <div className="token-model-metrics">
                      <span>输入 {formatTokens(item.promptTokens)}</span>
                      <span>缓存 {formatTokens(item.cachedPromptTokens)}</span>
                      <span>输出 {formatTokens(item.completionTokens)}</span>
                      <span>{item.calls.toLocaleString()} 次</span>
                      <span>均次 {formatTokens(Math.round(item.totalTokens / item.calls))}</span>
                      {speed > 0 ? (
                        <span>{speed.toFixed(2)} Tok/s</span>
                      ) : (
                        <span title="历史记录未保存模型纯生成时长">速度暂无</span>
                      )}
                      <button
                        className="token-model-drilldown"
                        onClick={() => {
                          setSelectedModelKey(item.key)
                          setDetailPage(1)
                        }}
                      >
                        查看逐次调用
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

export function SettingsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const customModels = useAppStore((state) => state.customModels)
  const saveCustomModel = useAppStore((state) => state.saveCustomModel)
  const deleteCustomModel = useAppStore((state) => state.deleteCustomModel)
  const globalInstructions = useAppStore((state) => state.globalInstructions)
  const setGlobalInstructions = useAppStore((state) => state.setGlobalInstructions)
  const skills = useAppStore((state) => state.skills)
  const tokenUsageRecords = useAppStore((state) => state.tokenUsageRecords)
  const setSkills = useAppStore((state) => state.setSkills)
  const [localModels, setLocalModels] = useState<ModelOption[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [testing, setTesting] = useState(false)
  const [remoteSelection, setRemoteSelection] = useState(
    model.preset === 'kimi-code' ? 'kimi-code' : model.connectionId ?? ''
  )
  const [kimiApiKey, setKimiApiKey] = useState(model.preset === 'kimi-code' ? model.apiKey ?? '' : '')
  const [kimiModel, setKimiModel] = useState(
    model.preset === 'kimi-code' ? model.model : 'kimi-for-coding'
  )
  const [kimiConnecting, setKimiConnecting] = useState(false)
  const [kimiResult, setKimiResult] = useState('')
  const [customConnection, setCustomConnection] = useState<ModelConfig>({
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    apiKey: ''
  })
  const [editingSkill, setEditingSkill] = useState<SkillDefinition | null>(null)
  const [tokenChartOpen, setTokenChartOpen] = useState(false)

  const discover = async (): Promise<void> => {
    setDiscovering(true)
    try {
      setLocalModels(await window.localAgent.model.discover())
    } finally {
      setDiscovering(false)
    }
  }

  useEffect(() => {
    void discover()
    void window.localAgent.credentials.getKimiCodeApiKey().then((apiKey) => {
      if (apiKey) setKimiApiKey(apiKey)
    })
  }, [])

  const selectedModelId =
    localModels.find(
      (item) =>
        item.name === model.model &&
        item.baseUrl === model.baseUrl &&
        item.provider === model.provider
    )?.id ?? ''

  const groupedModels = useMemo(
    () =>
      (['Ollama', 'LM Studio', 'llama.cpp'] as const).map((source) => ({
        source,
        items: localModels.filter((item) => item.source === source)
      })),
    [localModels]
  )

  const test = async (): Promise<void> => {
    if (!model.model || !model.baseUrl) {
      setTestResult('请先选择模型')
      return
    }
    setTesting(true)
    const result = await window.localAgent.model.test(model)
    setTesting(false)
    setTestResult(result.message)
  }

  const connectKimiCode = async (): Promise<void> => {
    const apiKey = kimiApiKey.trim()
    if (!apiKey) {
      setKimiResult('请先填写 Kimi Code API Key')
      return
    }
    setKimiConnecting(true)
    setKimiResult('')
    const isK3 = kimiModel === 'k3'
    const next: ModelConfig = {
      provider: 'openai',
      preset: 'kimi-code',
      baseUrl: 'https://api.kimi.com/coding/v1',
      model: kimiModel,
      apiKey,
      contextLength: 262144,
      maxContextLength: isK3 ? 1048576 : 262144
    }
    try {
      await window.localAgent.credentials.setKimiCodeApiKey(apiKey)
      const result = await window.localAgent.model.test(next)
      setKimiResult(result.message)
      if (result.ok) setModel(next)
    } catch (error) {
      setKimiResult(error instanceof Error ? error.message : String(error))
    } finally {
      setKimiConnecting(false)
    }
  }

  const clearKimiCode = async (): Promise<void> => {
    await window.localAgent.credentials.setKimiCodeApiKey('')
    setKimiApiKey('')
    setKimiResult('已清除 Kimi Code API Key')
    if (model.preset === 'kimi-code') setModel({ ...model, apiKey: undefined })
  }

  const selectRemoteModel = async (selection: string): Promise<void> => {
    setRemoteSelection(selection)
    setTestResult('')
    if (selection === 'kimi-code' || !selection) return
    if (selection === 'new') {
      setCustomConnection({
        provider: 'openai',
        baseUrl: 'https://api.x.ai/v1',
        model: '',
        apiKey: ''
      })
      return
    }
    const saved = customModels.find((item) => item.connectionId === selection)
    if (!saved?.connectionId) return
    const apiKey = await window.localAgent.credentials.getModelApiKey(saved.connectionId)
    setCustomConnection({ ...saved, apiKey })
  }

  const connectCustomModel = async (): Promise<void> => {
    const connectionId = customConnection.connectionId || uid()
    const apiKey = customConnection.apiKey?.trim() ?? ''
    const pending: ModelConfig = {
      ...customConnection,
      connectionId,
      baseUrl: customConnection.baseUrl.trim(),
      model: customConnection.model.trim(),
      apiKey: apiKey || undefined,
      preset: undefined
    }
    setTesting(true)
    setTestResult('')
    try {
      const context = await window.localAgent.model.context(pending)
      const next = {
        ...pending,
        contextLength: context.contextLength,
        maxContextLength: context.maxContextLength
      }
      await window.localAgent.credentials.setModelApiKey(connectionId, apiKey)
      saveCustomModel(next)
      setModel(next)
      setRemoteSelection(connectionId)
      setCustomConnection(next)
      setTestResult('远程模型配置已保存并启用')
    } catch (error) {
      setTestResult(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }

  const removeCustomModel = async (): Promise<void> => {
    const connectionId = customConnection.connectionId
    if (!connectionId) return
    await window.localAgent.credentials.setModelApiKey(connectionId, '')
    deleteCustomModel(connectionId)
    setRemoteSelection('')
    setCustomConnection({
      provider: 'openai',
      baseUrl: 'https://api.x.ai/v1',
      model: '',
      apiKey: ''
    })
    setTestResult('自定义模型配置已删除')
  }

  const saveSkill = (): void => {
    if (!editingSkill?.name.trim() || !editingSkill.instructions.trim()) return
    const next = skills.some((item) => item.id === editingSkill.id)
      ? skills.map((item) => (item.id === editingSkill.id ? editingSkill : item))
      : [...skills, editingSkill]
    setSkills(next)
    setEditingSkill(null)
  }

  const importSkill = async (): Promise<void> => {
    const imported = await window.localAgent.skills.import()
    if (!imported) return
    setSkills([
      ...skills,
      {
        id: uid(),
        name: imported.name,
        description: imported.description,
        instructions: imported.instructions,
        sourcePath: imported.sourcePath,
        enabled: true
      }
    ])
  }

  return (
    <section className="settings-panel settings-modal">
      <header className="panel-header">
        <div>
          <div className="eyebrow">设置</div>
          <h2>Agent 配置</h2>
        </div>
        <div className="header-actions">
          <Bot size={19} className="accent-icon" />
          <button className="icon-button" onClick={onClose} title="关闭设置">
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="settings-content">
        <div className="settings-group">
          <div className="settings-title-row">
            <div>
              <h3>全局指令</h3>
              <p>对 Chat 与 Agent 全局生效，用于规定语言、风格、习惯和工作规则。</p>
            </div>
          </div>
          <textarea
            className="instructions-editor"
            rows={9}
            value={globalInstructions}
            onChange={(event) => setGlobalInstructions(event.target.value)}
            placeholder="例如：始终使用简体中文；修改文件前先阅读项目规则；回答保持简洁……"
          />
          <div className="settings-autosave-status">
            <CheckCircle2 size={13} /> 实时保存，立即对后续请求生效
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-title-row">
            <div>
              <h3>Token 用量</h3>
            </div>
            <button
              className="secondary-button token-chart-open"
              onClick={() => setTokenChartOpen(true)}
              title="按模型查看 Token 图表"
            >
              <BarChart3 size={14} /> 模型图表
            </button>
          </div>
          <TokenCalendar records={tokenUsageRecords} />
        </div>

        <div className="settings-group">
          <div className="settings-title-row">
            <div>
              <h3>Skills</h3>
              <p>按需启用的专业能力，Agent 执行任务时会自动携带已启用 Skill。</p>
            </div>
            <div className="header-actions">
              <button className="icon-button" onClick={() => void importSkill()} title="导入 SKILL.md">
                <FileInput size={15} />
              </button>
              <button
                className="icon-button prominent"
                onClick={() =>
                  setEditingSkill({
                    id: uid(),
                    name: '',
                    description: '',
                    instructions: '',
                    enabled: true
                  })
                }
                title="新建 Skill"
              >
                <Plus size={15} />
              </button>
            </div>
          </div>

          {skills.length === 0 ? (
            <div className="skills-empty">
              <Wrench size={22} />
              <span>还未添加 Skill</span>
            </div>
          ) : (
            <div className="skills-list">
              {skills.map((skill) => (
                <article className="skill-item" key={skill.id}>
                  <label className="skill-toggle" title={skill.enabled ? '已启用' : '已停用'}>
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={(event) =>
                        setSkills(
                          skills.map((item) =>
                            item.id === skill.id ? { ...item, enabled: event.target.checked } : item
                          )
                        )
                      }
                    />
                    <i />
                  </label>
                  <div className="skill-info">
                    <strong>{skill.name}</strong>
                    <p>{skill.description || '未填写说明'}</p>
                    {skill.sourcePath && <small title={skill.sourcePath}>{skill.sourcePath}</small>}
                  </div>
                  <div className="header-actions">
                    <button className="icon-button" onClick={() => setEditingSkill(skill)} title="编辑">
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => setSkills(skills.filter((item) => item.id !== skill.id))}
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="settings-group">
          <div className="settings-title-row">
            <div>
              <h3>模型连接</h3>
              <p>模型只负责提供推理能力，具体调用由 Chat 与 Agent 自动完成。</p>
            </div>
            <button className="icon-button" onClick={() => void discover()} title="重新扫描">
              <RefreshCw size={15} className={discovering ? 'spin' : ''} />
            </button>
          </div>
          <label className="field-label">
            本地模型
            <MacSelect
              value={selectedModelId}
              placeholder={discovering ? '正在扫描本地模型…' : localModels.length ? `已发现 ${localModels.length} 个模型` : '未发现本地模型'}
              ariaLabel="本地模型"
              groups={groupedModels.filter((group) => group.items.length).map((group) => ({
                label: group.source,
                options: group.items.map((item) => ({ value: item.id, label: item.name }))
              }))}
              onChange={(value) => {
                const selected = localModels.find((item) => item.id === value)
                if (!selected) return
                setModel({
                  provider: selected.provider,
                  baseUrl: selected.baseUrl,
                  model: selected.name,
                  contextLength: selected.contextLength,
                  maxContextLength: selected.maxContextLength
                })
                setRemoteSelection('')
                setTestResult('')
              }}
            />
          </label>
          <label className="field-label remote-model-select">
            远程模型
            <MacSelect
              value={remoteSelection}
              placeholder="选择远程模型"
              ariaLabel="远程模型"
              groups={[
                { label: '内置服务', options: [{ value: 'kimi-code', label: 'Kimi Code' }] },
                { label: '自定义服务', options: customModels.map((item) => ({ value: item.connectionId!, label: `${item.model} · ${item.baseUrl}` })) },
                { options: [{ value: 'new', label: '＋ 添加自定义模型' }] }
              ].filter((group) => group.options.length)}
              onChange={(value) => void selectRemoteModel(value)}
            />
          </label>

          {remoteSelection === 'kimi-code' && (
            <div className="kimi-code-card remote-config-card">
              <header>
                <span className="kimi-code-icon"><KeyRound size={17} /></span>
                <div>
                  <strong>Kimi Code</strong>
                  <small>会员 API Key · OpenAI 兼容协议 · K3 / K2.7</small>
                </div>
                {model.preset === 'kimi-code' && model.apiKey && (
                  <span className="kimi-code-connected">当前使用</span>
                )}
              </header>
              <label className="field-label">
                模型
                <MacSelect value={kimiModel} onChange={setKimiModel} ariaLabel="Kimi 模型" groups={[{ options: [
                  { value: 'k3', label: 'Kimi K3' },
                  { value: 'kimi-for-coding', label: 'Kimi K2.7 Code' },
                  { value: 'kimi-for-coding-highspeed', label: 'Kimi K2.7 Code 高速版' }
                ] }]} />
              </label>
              <label className="field-label">
                Kimi Code API Key
                <input
                  type="password"
                  autoComplete="off"
                  value={kimiApiKey}
                  onChange={(event) => setKimiApiKey(event.target.value)}
                  placeholder="从 Kimi Code 控制台创建"
                />
              </label>
              <div className="kimi-code-actions">
                <button
                  className="secondary-button"
                  onClick={() =>
                    void window.localAgent.app.openExternal('https://www.kimi.com/code/console')
                  }
                >
                  打开控制台
                </button>
                {kimiApiKey && (
                  <button className="icon-button" onClick={() => void clearKimiCode()} title="清除密钥">
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  className="primary-button"
                  disabled={!kimiApiKey.trim() || kimiConnecting}
                  onClick={() => void connectKimiCode()}
                >
                  {kimiConnecting ? <LoaderCircle size={14} className="spin" /> : <Rocket size={14} />}
                  保存并连接
                </button>
              </div>
              {kimiResult && <div className="kimi-code-result">{kimiResult}</div>}
            </div>
          )}

          {remoteSelection && remoteSelection !== 'kimi-code' && (
            <div className="custom-connection remote-config-card">
              <header className="custom-connection-header">
                <span className="kimi-code-icon"><PlugZap size={17} /></span>
                <div>
                  <strong>{customConnection.connectionId ? customConnection.model : '自定义远程模型'}</strong>
                  <small>兼容 OpenAI 或 Ollama API</small>
                </div>
                {model.connectionId === customConnection.connectionId && (
                  <span className="kimi-code-connected">当前使用</span>
                )}
              </header>
              <label className="field-label">
                服务类型
                <MacSelect
                  value={customConnection.provider}
                  ariaLabel="服务类型"
                  groups={[{ options: [
                    { value: 'ollama', label: 'Ollama' },
                    { value: 'openai', label: '兼容 OpenAI 接口' }
                  ] }]}
                  onChange={(value) =>
                    setCustomConnection({
                      ...customConnection,
                      provider: value as ModelConfig['provider']
                    })
                  }
                />
              </label>
              <label className="field-label">
                服务地址
                <input
                  value={customConnection.baseUrl}
                  onChange={(event) =>
                    setCustomConnection({ ...customConnection, baseUrl: event.target.value })
                  }
                />
              </label>
              <label className="field-label">
                模型标识
                <input
                  value={customConnection.model}
                  onChange={(event) =>
                    setCustomConnection({ ...customConnection, model: event.target.value })
                  }
                />
              </label>
              <label className="field-label">
                密钥，可留空
                <input
                  type="password"
                  autoComplete="off"
                  value={customConnection.apiKey ?? ''}
                  onChange={(event) =>
                    setCustomConnection({ ...customConnection, apiKey: event.target.value })
                  }
                />
              </label>
              <div className="custom-connection-actions">
                {customConnection.connectionId && (
                  <button className="danger-text-button" onClick={() => void removeCustomModel()}>
                    <Trash2 size={14} /> 删除配置
                  </button>
                )}
                <button
                  className="primary-button"
                  disabled={
                    !customConnection.baseUrl.trim() ||
                    !customConnection.model.trim() ||
                    testing
                  }
                  onClick={() => void connectCustomModel()}
                >
                  {testing ? <LoaderCircle size={14} className="spin" /> : <Rocket size={14} />}
                  保存并连接
                </button>
              </div>
            </div>
          )}

          {model.model && (
            <div className="active-model-card">
              <span className="status-dot online" />
              <div>
                <strong>{model.model}</strong>
                <small>{model.baseUrl}</small>
                <small>
                  当前上下文 {model.contextLength?.toLocaleString() || '自动读取'} Token
                  {model.maxContextLength
                    ? ` · 模型上限 ${model.maxContextLength.toLocaleString()}`
                    : ''}
                </small>
              </div>
            </div>
          )}
          <button className="secondary-button full" onClick={() => void test()} disabled={testing}>
            {testing ? <LoaderCircle size={15} className="spin" /> : <PlugZap size={15} />}
            测试当前连接
          </button>
          {testResult && (
            <div className="test-result">
              <CheckCircle2 size={15} /> {testResult}
            </div>
          )}
        </div>
      </div>

      {editingSkill && (
        <div className="skill-editor-overlay">
          <div className="skill-editor">
            <header>
              <strong>{skills.some((item) => item.id === editingSkill.id) ? '编辑 Skill' : '新建 Skill'}</strong>
              <button className="icon-button" onClick={() => setEditingSkill(null)}>
                <Trash2 size={14} />
              </button>
            </header>
            <label className="field-label">
              名称
              <input
                value={editingSkill.name}
                onChange={(event) => setEditingSkill({ ...editingSkill, name: event.target.value })}
                placeholder="例如：代码审查"
              />
            </label>
            <label className="field-label">
              说明
              <input
                value={editingSkill.description}
                onChange={(event) =>
                  setEditingSkill({ ...editingSkill, description: event.target.value })
                }
                placeholder="此 Skill 适合处理什么任务"
              />
            </label>
            <label className="field-label">
              指令
              <textarea
                rows={13}
                value={editingSkill.instructions}
                onChange={(event) =>
                  setEditingSkill({ ...editingSkill, instructions: event.target.value })
                }
                placeholder="写入此 Skill 的具体流程、规则与注意事项"
              />
            </label>
            <div className="form-actions">
              <button className="ghost-button" onClick={() => setEditingSkill(null)}>
                取消
              </button>
              <button className="primary-button" onClick={saveSkill}>
                <Save size={15} /> 保存 Skill
              </button>
            </div>
          </div>
        </div>
      )}
      {tokenChartOpen && (
        <TokenModelChartModal records={tokenUsageRecords} onClose={() => setTokenChartOpen(false)} />
      )}
    </section>
  )
}
