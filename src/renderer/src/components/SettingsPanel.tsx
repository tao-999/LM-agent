import { useEffect, useMemo, useState } from 'react'
import {
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileInput,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
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

export function SettingsPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const globalInstructions = useAppStore((state) => state.globalInstructions)
  const setGlobalInstructions = useAppStore((state) => state.setGlobalInstructions)
  const skills = useAppStore((state) => state.skills)
  const tokenUsageRecords = useAppStore((state) => state.tokenUsageRecords)
  const setSkills = useAppStore((state) => state.setSkills)
  const [localModels, setLocalModels] = useState<ModelOption[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [testResult, setTestResult] = useState('')
  const [testing, setTesting] = useState(false)
  const [showCustomConnection, setShowCustomConnection] = useState(false)
  const [customConnection, setCustomConnection] = useState<ModelConfig>({
    provider: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: '',
    apiKey: ''
  })
  const [editingSkill, setEditingSkill] = useState<SkillDefinition | null>(null)

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
            <CalendarDays size={18} className="accent-icon" />
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
            <select
              value={selectedModelId}
              onChange={(event) => {
                const selected = localModels.find((item) => item.id === event.target.value)
                if (!selected) return
                setModel({
                  provider: selected.provider,
                  baseUrl: selected.baseUrl,
                  model: selected.name,
                  contextLength: selected.contextLength,
                  maxContextLength: selected.maxContextLength
                })
                setTestResult('')
              }}
            >
              <option value="">
                {discovering
                  ? '正在扫描本地模型…'
                  : localModels.length
                    ? `已发现 ${localModels.length} 个模型`
                    : '未发现本地模型'}
              </option>
              {groupedModels.map((group) =>
                group.items.length ? (
                  <optgroup key={group.source} label={group.source}>
                    {group.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null
              )}
            </select>
          </label>
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

          <button
            className="settings-link-button"
            onClick={() => setShowCustomConnection((value) => !value)}
          >
            {showCustomConnection ? '收起自定义连接' : '添加自定义接口'}
          </button>
          {showCustomConnection && (
            <div className="custom-connection">
              <label className="field-label">
                服务类型
                <select
                  value={customConnection.provider}
                  onChange={(event) =>
                    setCustomConnection({
                      ...customConnection,
                      provider: event.target.value as ModelConfig['provider']
                    })
                  }
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai">兼容 OpenAI 接口</option>
                </select>
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
                  value={customConnection.apiKey ?? ''}
                  onChange={(event) =>
                    setCustomConnection({ ...customConnection, apiKey: event.target.value })
                  }
                />
              </label>
              <button
                className="primary-button full"
                disabled={!customConnection.baseUrl.trim() || !customConnection.model.trim()}
                onClick={async () => {
                  const context = await window.localAgent.model.context(customConnection)
                  setModel({
                    ...customConnection,
                    contextLength: context.contextLength,
                    maxContextLength: context.maxContextLength
                  })
                  setShowCustomConnection(false)
                }}
              >
                保存为当前模型
              </button>
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
    </section>
  )
}
