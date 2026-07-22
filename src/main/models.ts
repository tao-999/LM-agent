import type {
  ContextCompressionMemory,
  ModelConfig,
  ModelOption,
  TokenUsage
} from '../shared/types'
import { resolveThinkingEnabled } from '../shared/thinking'
import { session, type Session } from 'electron'
import { parseToolArgumentsJson } from './tool-json'

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  tool_call_id?: string
  tool_calls?: unknown[]
  images?: string[]
}

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type CompletionResult = {
  content: string
  reasoning?: string
  toolCalls: ToolCall[]
  toolCallParseError?: string
  rawMessage: LlmMessage
  usage: TokenUsage
  contextTokens: number
  contextEstimated: boolean
  compressed: boolean
  contextMemory?: ContextCompressionMemory
  finishReason?: string
}

function createUsage(
  promptTokens: number,
  completionTokens: number,
  estimated = false,
  generationDurationMs?: number,
  cachedPromptTokens = 0
): TokenUsage {
  const safePromptTokens = Math.max(0, Math.round(promptTokens))
  const safeCompletionTokens = Math.max(0, Math.round(completionTokens))
  const safeDuration =
    typeof generationDurationMs === 'number' && generationDurationMs > 0
      ? generationDurationMs
      : undefined
  return {
    promptTokens: safePromptTokens,
    completionTokens: safeCompletionTokens,
    totalTokens: safePromptTokens + safeCompletionTokens,
    ...(cachedPromptTokens > 0
      ? {
          cachedPromptTokens: Math.min(
            safePromptTokens,
            Math.max(0, Math.round(cachedPromptTokens))
          )
        }
      : {}),
    estimated,
    ...(safeDuration
      ? {
          generationDurationMs: safeDuration,
          tokensPerSecond: safeCompletionTokens / (safeDuration / 1000)
        }
      : {})
  }
}

function attachGenerationDuration(usage: TokenUsage, generationDurationMs?: number): TokenUsage {
  return createUsage(
    usage.promptTokens,
    usage.completionTokens,
    Boolean(usage.estimated),
    generationDurationMs,
    usage.cachedPromptTokens ?? 0
  )
}

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return createUsage(
    left.promptTokens + right.promptTokens,
    left.completionTokens + right.completionTokens,
    Boolean(left.estimated || right.estimated),
    (left.generationDurationMs ?? 0) + (right.generationDurationMs ?? 0) || undefined,
    (left.cachedPromptTokens ?? 0) + (right.cachedPromptTokens ?? 0)
  )
}

type OpenAiUsagePayload = {
  prompt_tokens?: number
  completion_tokens?: number
  cached_tokens?: number
  prompt_cache_hit_tokens?: number
  cache_read_input_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  input_tokens_details?: { cached_tokens?: number }
}

function cachedPromptTokensFromUsage(usage: OpenAiUsagePayload): number {
  return Math.max(
    0,
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cache_read_input_tokens ??
      usage.cached_tokens ??
      0
  )
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

function openAiEndpoint(baseUrl: string, suffix: string): string {
  const base = normalizeBaseUrl(baseUrl)
  return base.endsWith('/v1') ? `${base}${suffix}` : `${base}/v1${suffix}`
}

let systemProxySession: Promise<Session> | null = null

async function fetchModel(
  model: ModelConfig,
  input: string | Request,
  init?: RequestInit
): Promise<Response> {
  if (model.preset !== 'kimi-code') return fetch(input, init)
  if (!systemProxySession) {
    systemProxySession = (async () => {
      const current = session.defaultSession
      await current.setProxy({ mode: 'system' })
      return current
    })().catch((error) => {
      systemProxySession = null
      throw error
    })
  }
  const current = await systemProxySession
  return current.fetch(input, init)
}

function sanitizeUnicodeString(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[index + 1]
        index += 1
      } else {
        output += '\ufffd'
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\ufffd'
      continue
    }
    output += value[index]
  }
  return output
}

function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === 'string') return sanitizeUnicodeString(value) as T
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sanitizeJsonValue(item)
      ])
    ) as T
  }
  return value
}

function safeJsonBody(value: unknown): string {
  return JSON.stringify(sanitizeJsonValue(value))
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return sanitizeJsonValue(value as Record<string, unknown>)
  }
  if (typeof value !== 'string' || value.trim() === '') return {}
  const parsed = parseToolArgumentsJson(value)
  if (parsed) return sanitizeJsonValue(parsed)
  const tagged = parseTaggedToolArguments(value)
  if (Object.keys(tagged).length) return sanitizeJsonValue(tagged)
  return { value: sanitizeUnicodeString(value) }
}

function parseTaggedToolArguments(value: string): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const parameterPattern =
    /<parameter(?:\s*=\s*|\s+name\s*=\s*)["']?([A-Za-z_][\w.-]*)["']?\s*>([\s\S]*?)(?=<\/parameter\s*>|<parameter(?:\s*=|\s+name\s*=)|<\/(?:function|tool_call|function_call)\s*>|$)/gi
  for (const parameter of value.matchAll(parameterPattern)) {
    output[parameter[1]] = parseXmlParameter(parameter[2])
  }
  if (Object.keys(output).length) return output
  const argumentBody = value.match(
    /<arguments\b[^>]*>([\s\S]*?)(?:<\/arguments\s*>|<\/(?:function|tool_call|function_call)\s*>|$)/i
  )?.[1]
  if (!argumentBody) return output
  const decoded = decodeXmlText(argumentBody).trim()
  return parseToolArgumentsJson(decoded) ?? output
}

function normalizeStructuredToolCall(
  value: unknown,
  index: number,
  prefix: string
): ToolCall {
  const call = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const functionValue =
    call.function && typeof call.function === 'object'
      ? (call.function as Record<string, unknown>)
      : {}
  const toolValue =
    call.tool && typeof call.tool === 'object' ? (call.tool as Record<string, unknown>) : {}
  const nameValue = functionValue.name ?? call.name ?? toolValue.name
  const argumentsValue =
    functionValue.arguments ??
    functionValue.parameters ??
    call.arguments ??
    call.parameters ??
    call.input ??
    toolValue.arguments ??
    toolValue.parameters
  return {
    id:
      typeof call.id === 'string' && call.id.trim()
        ? call.id
        : `${prefix}-${Date.now()}-${index}`,
    name: typeof nameValue === 'string' ? nameValue.trim() : '',
    arguments: parseArguments(argumentsValue)
  }
}

function mergeStreamingFragment(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current) return incoming
  if (incoming === current || current.startsWith(incoming)) return current
  if (incoming.startsWith(current)) return incoming
  return current + incoming
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
}

function parseXmlParameter(value: string): unknown {
  const decoded = decodeXmlText(value).trim()
  if (!decoded) return ''
  try {
    return JSON.parse(decoded) as unknown
  } catch {
    return decoded
  }
}

const PRIVATE_HOST_BLOCK_TAGS = [
  'current_task',
  'turn_boundary',
  'completed_history_input',
  'completed_history_result',
  'compressed_context',
  'compressed_history_summary',
  'user_guidance',
  'user_guidance_history',
  'message_attachments',
  'task_state',
  'interaction_event',
  'selected_code',
  'current_file',
  'file_reference',
  'file',
  'attachment',
  'skill',
  'task_understanding',
  'post_edit_file',
  'post_edit_review',
  'host_runtime_context',
  'live_web_evidence',
  'conversation_history_results',
  'web_search_empty',
  'runtime_model_error',
  'runtime_workflow_stage',
  'runtime_research_gate',
  'runtime_web_status',
  'runtime_history_status',
  'runtime_completion_guard',
  'runtime_replace_recovery',
  'runtime_anchor_context',
  'tool_runtime_observation'
] as const

const privateHostBlockPattern = (): RegExp =>
  new RegExp(
    `<(${PRIVATE_HOST_BLOCK_TAGS.join('|')}|(?:runtime|host_runtime)_[a-z0-9_]+)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
    'gi'
  )

const privateHostTagPattern = (): RegExp =>
  new RegExp(
    `<\\/?(?:${PRIVATE_HOST_BLOCK_TAGS.join('|')}|(?:runtime|host_runtime)_[a-z0-9_]+)\\b[^>]*>`,
    'gi'
  )

function stripToolCallMarkup(value: string): string {
  return value
    .replace(privateHostBlockPattern(), '')
    .replace(privateHostTagPattern(), '')
    .replace(
      /<\|channel\|>\s*(?:thought|analysis|reasoning|commentary|final)\s*(?:<\|channel\|>|<\|message\|>)?/gi,
      ''
    )
    .replace(/<\|(?:message|end_of_turn|start_of_turn)\|>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<function_call\b[^>]*>[\s\S]*?<\/function_call\s*>/gi, '')
    .replace(/<function_call\b[^>]*>[\s\S]*$/gi, '')
    .replace(
      /<[\|｜]tool[_▁]calls[_▁]begin[\|｜]>[\s\S]*?<[\|｜]tool[_▁]calls[_▁]end[\|｜]>/gi,
      ''
    )
    .replace(/<[\|｜]tool[_▁]calls[_▁]begin[\|｜]>[\s\S]*$/gi, '')
    .replace(/<\|python_tag\|>[\s\S]*$/gi, '')
    .replace(/\[tool_calls\][\s\S]*$/gi, '')
    .replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi,
      ''
    )
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*$/gi, '')
    .replace(
      /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi,
      ''
    )
    .replace(/<\|tool_call_begin\|>[\s\S]*$/gi, '')
    .replace(
      /(?:^|[\r\n]|<\|tool_calls_section_end\|>)\s*[A-Za-z_][\w.-]*\s*:\s*\d+\s*<\|tool_call_argument_begin\|>[\s\S]*?<\|tool_call_end\|>\s*(?:<\|tool_calls_section_end\|>)?/gi,
      '\n'
    )
    .replace(
      /<\|(?:tool_calls_section_begin|tool_call_begin|tool_call_argument_begin|tool_call_end|tool_calls_section_end)\|>/gi,
      ''
    )
    .replace(/```tool_code[\s\S]*?```/gi, '')
    .replace(/<function\s*=\s*["']?[A-Za-z_][\w.-]*["']?\s*>[\s\S]*?<\/function\s*>/gi, '')
    .replace(
      /<\/?(?:tool_call|function_call|function|parameter|arguments)\b[^>]*>/gi,
      ''
    )
    .replace(/<\/?(?:think|thinking|thought|analysis|reasoning)\b[^>]*>/gi, '')
}

type TextToolPayload = {
  name?: unknown
  tool?: unknown
  arguments?: unknown
  parameters?: unknown
  input?: unknown
  function?: {
    name?: unknown
    arguments?: unknown
    parameters?: unknown
  }
}

type ToolNameInference = {
  name?: string
  candidates: string[]
}

function inferToolNameFromArguments(
  argumentsValue: Record<string, unknown>,
  tools: ToolDefinition[]
): ToolNameInference {
  const argumentKeys = Object.keys(argumentsValue)
  if (!argumentKeys.length) return { candidates: [] }
  const candidates = tools
    .filter((tool) => {
      const schema = tool.function.parameters
      const properties =
        schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
          ? (schema.properties as Record<string, unknown>)
          : {}
      const required = Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === 'string')
        : []
      return (
        Object.keys(properties).length > 0 &&
        required.every((key) => Object.prototype.hasOwnProperty.call(argumentsValue, key)) &&
        argumentKeys.every((key) => Object.prototype.hasOwnProperty.call(properties, key))
      )
    })
    .map((tool) => tool.function.name)
  return candidates.length === 1 ? { name: candidates[0], candidates } : { candidates }
}

function kimiLinearToolNameFromId(
  callId: string,
  allowed: Set<string>
): string {
  const cleaned = callId.trim().replace(/^functions?\./i, '')
  if (allowed.has(cleaned)) return cleaned
  const beforeIndex = cleaned.replace(/:\d+$/, '')
  if (allowed.has(beforeIndex)) return beforeIndex
  const matchingName = [...allowed]
    .sort((left, right) => right.length - left.length)
    .find((name) => cleaned === name || cleaned.startsWith(`${name}:`))
  return matchingName ?? ''
}

type ToolProtocol =
  | 'gpt-oss-harmony'
  | 'kimi-linear'
  | 'qwen-xml'
  | 'hermes-json'
  | 'llama-python'
  | 'mistral-json'
  | 'deepseek'
  | 'auto'

const CONTEXT_COMPRESSION_THRESHOLD = 0.9

function preferredToolProtocol(modelName: string): ToolProtocol {
  const value = modelName.toLocaleLowerCase()
  if (/gpt[-_. ]?oss/.test(value)) return 'gpt-oss-harmony'
  if (/kimi|moonshot/.test(value)) return 'kimi-linear'
  if (/qwen/.test(value)) return 'qwen-xml'
  if (/hermes|nous/.test(value)) return 'hermes-json'
  if (/llama|granite/.test(value)) return 'llama-python'
  if (/mistral|mixtral|ministral/.test(value)) return 'mistral-json'
  if (/deepseek/.test(value)) return 'deepseek'
  return 'auto'
}

function jsonPayloadCandidates(value: string): string[] {
  const cleaned = decodeXmlText(value)
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  const candidates = [cleaned]
  const arrayStart = cleaned.indexOf('[')
  const arrayEnd = cleaned.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(cleaned.slice(arrayStart, arrayEnd + 1))
  }
  const objectStart = cleaned.indexOf('{')
  const objectEnd = cleaned.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(cleaned.slice(objectStart, objectEnd + 1))
  }
  return [...new Set(candidates.filter(Boolean))]
}

export function parseTextToolCalls(
  content: string,
  reasoning: string,
  tools: ToolDefinition[],
  modelName = ''
): { content: string; reasoning: string; toolCalls: ToolCall[]; toolCallParseError?: string } {
  const source = `${reasoning}\n${content}`
  const allowed = new Set(tools.map((tool) => tool.function.name))
  const calls: ToolCall[] = []
  const seen = new Set<string>()
  const protocol = preferredToolProtocol(modelName)
  let consumedBareContent = false
  let consumedBareReasoning = false
  let toolCallParseError = ''
  const addCall = (
    nameValue: unknown,
    argsValue: unknown,
    inferMissingName = false,
    idValue?: unknown
  ): void => {
    let name = typeof nameValue === 'string' ? nameValue.trim() : ''
    const argumentsValue = parseArguments(argsValue)
    if (!name && inferMissingName) {
      const inferred = inferToolNameFromArguments(argumentsValue, tools)
      name = inferred.name ?? ''
      if (!name && inferred.candidates.length > 0) {
        toolCallParseError = `模型只输出了工具参数 JSON，缺少函数名；匹配到多个候选工具：${inferred.candidates.join('、')}`
      }
    }
    if (!name || !allowed.has(name)) return
    const signature = `${name}:${JSON.stringify(argumentsValue)}`
    if (seen.has(signature)) return
    seen.add(signature)
    calls.push({
      id:
        typeof idValue === 'string' && idValue.trim()
          ? idValue.trim()
          : `text-tool-${Date.now()}-${calls.length}`,
      name,
      arguments: argumentsValue
    })
  }
  const addJsonPayload = (value: string): boolean => {
    for (const candidate of jsonPayloadCandidates(value)) {
      let parsed: TextToolPayload | TextToolPayload[] | null = null
      try {
        parsed = JSON.parse(candidate) as TextToolPayload | TextToolPayload[]
      } catch {
        parsed = parseToolArgumentsJson(candidate) as TextToolPayload | null
      }
      if (!parsed) continue
      const payloads = Array.isArray(parsed) ? parsed : [parsed]
      let added = false
      for (const payload of payloads) {
        const before = calls.length
        const explicitName = payload.name ?? payload.tool ?? payload.function?.name
        const envelopedArguments =
          payload.arguments ??
          payload.parameters ??
          payload.input ??
          payload.function?.arguments ??
          payload.function?.parameters
        addCall(
          explicitName,
          envelopedArguments ?? (explicitName ? {} : payload),
          !explicitName
        )
        if (calls.length > before) added = true
      }
      if (added) return true
    }
    return false
  }
  const addPythonPayload = (value: string): boolean => {
    const cleaned = value
      .replace(/```(?:python|tool_code)?/gi, '')
      .replace(/```/g, '')
      .trim()
      .replace(/^print\(([\s\S]*)\)$/i, '$1')
      .replace(/^default_api\./i, '')
    const match = cleaned.match(/^([A-Za-z_][\w.-]*)\s*\(([\s\S]*)\)\s*$/)
    if (!match || !allowed.has(match[1])) return false
    const args: Record<string, unknown> = {}
    const parameterPattern =
      /([A-Za-z_][\w.-]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|-?\d+(?:\.\d+)?|true|false|null)/gi
    for (const parameter of match[2].matchAll(parameterPattern)) {
      const raw = parameter[2]
      args[parameter[1]] =
        raw.startsWith("'") && raw.endsWith("'")
          ? raw.slice(1, -1).replace(/\\'/g, "'")
          : parseXmlParameter(raw)
    }
    addCall(match[1], args)
    return true
  }
  const addXmlBody = (bodyValue: string): void => {
    const body = bodyValue.trim()
    if (addJsonPayload(body)) return
    let name = ''
    let argumentsValue: Record<string, unknown> = {}
    name =
      body.match(/<function\s*=\s*["']?([A-Za-z_][\w.-]*)["']?\s*>/i)?.[1] ??
      body.match(/<function\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1] ??
      body.match(/<name>\s*([A-Za-z_][\w.-]*)\s*<\/name>/i)?.[1] ??
      ''
    argumentsValue = parseTaggedToolArguments(body)
    if (!Object.keys(argumentsValue).length) {
      const rawArguments = body.match(/<arguments\b[^>]*>([\s\S]*?)<\/arguments\s*>/i)?.[1]
      const functionBody = body.match(
        /<function(?:\s*=\s*["']?[A-Za-z_][\w.-]*["']?|\b[^>]*)>([\s\S]*?)<\/function\s*>/i
      )?.[1]
      if (rawArguments) {
        argumentsValue = parseArguments(decodeXmlText(rawArguments).trim())
      } else if (functionBody && /^[\s`]*(?:\{|\[)/.test(functionBody)) {
        argumentsValue = parseArguments(
          decodeXmlText(functionBody).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
        )
      }
    }
    addCall(name, argumentsValue, !name)
  }

  const adapters: Array<() => void> = [
    () => {
      for (const block of source.matchAll(
        /<(?:tool_call|function_call)\b[^>]*>([\s\S]*?)<\/(?:tool_call|function_call)\s*>/gi
      )) {
        addXmlBody(block[1])
      }
      const unwrappedSource = source
        .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi, '')
        .replace(/<function_call\b[^>]*>[\s\S]*?<\/function_call\s*>/gi, '')
      for (const block of unwrappedSource.matchAll(
        /<function\s*=\s*["']?([A-Za-z_][\w.-]*)["']?\s*>([\s\S]*?)<\/function\s*>/gi
      )) {
        const argumentBody = block[2]
        const before = calls.length
        addXmlBody(`<function=${block[1]}>${argumentBody}</function>`)
        if (calls.length === before) addCall(block[1], argumentBody)
      }
      const lowerSource = source.toLocaleLowerCase()
      const lastToolOpen = Math.max(
        lowerSource.lastIndexOf('<tool_call'),
        lowerSource.lastIndexOf('<function_call')
      )
      const lastToolClose = Math.max(
        lowerSource.lastIndexOf('</tool_call>'),
        lowerSource.lastIndexOf('</function_call>')
      )
      if (lastToolOpen > lastToolClose) addXmlBody(source.slice(lastToolOpen))
      const lastFunctionOpen = lowerSource.lastIndexOf('<function=')
      const lastFunctionClose = lowerSource.lastIndexOf('</function>')
      if (lastFunctionOpen > lastFunctionClose) addXmlBody(source.slice(lastFunctionOpen))
    },
    () => {
      for (const match of source.matchAll(/<\|python_tag\|>([\s\S]*?)(?=$|<\|eot_id\|>)/gi)) {
        if (!addJsonPayload(match[1])) addPythonPayload(match[1])
      }
    },
    () => {
      for (const match of source.matchAll(/\[tool_calls\]\s*([\s\S]*)$/gi)) {
        addJsonPayload(match[1])
      }
    },
    () => {
      const deepSeekPattern =
        /<[\|｜]tool[_▁]call[_▁]begin[\|｜]>\s*(?:function\s*)?<[\|｜]tool[_▁]sep[\|｜]>\s*([A-Za-z_][\w.-]*)\s*([\s\S]*?)(?=<[\|｜]tool[_▁]call[_▁]end[\|｜]>)/gi
      for (const match of source.matchAll(deepSeekPattern)) {
        let added = false
        for (const candidate of jsonPayloadCandidates(match[2])) {
          try {
            addCall(match[1], JSON.parse(candidate) as unknown)
            added = true
            break
          } catch {
            // Keep checking candidates.
          }
        }
        if (!added) addCall(match[1], match[2])
      }
    },
    () => {
      for (const [channel, value] of [
        ['content', content],
        ['reasoning', reasoning]
      ] as const) {
        const trimmed = value
          .trim()
          .replace(/^```(?:json|tool_code)?\s*/i, '')
          .replace(/\s*```$/i, '')
          .trim()
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          const before = calls.length
          const priorParseError = toolCallParseError
          addJsonPayload(trimmed)
          if (calls.length > before) {
            if (channel === 'content') consumedBareContent = true
            else consumedBareReasoning = true
          } else if (toolCallParseError && toolCallParseError !== priorParseError) {
            if (channel === 'content') consumedBareContent = true
            else consumedBareReasoning = true
          }
        } else if (addPythonPayload(trimmed)) {
          if (channel === 'content') consumedBareContent = true
          else consumedBareReasoning = true
        }
      }
    },
    () => {
      const addKimiLinearMatch = (match: RegExpMatchArray): void => {
        const callId = match[1].trim()
        const toolName = kimiLinearToolNameFromId(callId, allowed)
        addCall(toolName, match[2], !toolName, callId)
      }
      const officialPattern =
        /<\|tool_call_begin\|>\s*([^<\r\n]+?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)<\|tool_call_end\|>/gi
      for (const match of source.matchAll(officialPattern)) addKimiLinearMatch(match)
      const compactPattern =
        /(?:^|[\r\n]|<\|tool_calls_section_begin\|>|<\|tool_calls_section_end\|>)\s*([^<\r\n]+?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)<\|tool_call_end\|>/gi
      for (const match of source.matchAll(compactPattern)) addKimiLinearMatch(match)
    }
  ]
  const priority: Record<ToolProtocol, number[]> = {
    'gpt-oss-harmony': [1, 4, 0, 2, 3, 5],
    'kimi-linear': [5, 0, 4, 1, 2, 3],
    'qwen-xml': [0, 4, 1, 2, 3, 5],
    'hermes-json': [0, 4, 1, 2, 3, 5],
    'llama-python': [1, 4, 0, 2, 3, 5],
    'mistral-json': [2, 4, 0, 1, 3, 5],
    deepseek: [3, 4, 0, 1, 2, 5],
    auto: [5, 0, 1, 2, 3, 4]
  }
  for (const index of priority[protocol]) {
    adapters[index]()
  }
  if (calls.length === 0) {
    for (const [channel, value] of [
      ['content', content],
      ['reasoning', reasoning]
    ] as const) {
      const declaredCall = value.match(
        /(?:调用|call(?:ing)?)\s+`?([A-Za-z_][\w.-]*)`?[\s\S]{0,240}?```json\s*([\s\S]*?)```/i
      )
      if (!declaredCall || !allowed.has(declaredCall[1])) continue
      const argumentBody = declaredCall[2].trim()
      if (argumentBody) {
        addCall(declaredCall[1], argumentBody)
      } else {
        toolCallParseError = `模型声明调用 ${declaredCall[1]}，但 JSON 参数为空，实际工具尚未执行`
      }
      if (channel === 'content') consumedBareContent = true
      else consumedBareReasoning = true
    }
  }
  return {
    content: consumedBareContent ? '' : stripToolCallMarkup(content),
    reasoning: consumedBareReasoning ? '' : stripToolCallMarkup(reasoning),
    toolCalls: calls,
    ...(toolCallParseError && calls.length === 0 ? { toolCallParseError } : {})
  }
}

function createToolMarkupFilter(
  onVisible: (content: string) => void
): { push: (content: string) => void; flush: (suppressDeferredJson?: boolean) => void } {
  let buffer = ''
  let activeCloseTag: string | null | undefined
  let deferredJson = false
  const markers = [
    ...PRIVATE_HOST_BLOCK_TAGS.map((tag) => ({ open: `<${tag}`, close: `</${tag}>` })),
    { open: '<tool_call', close: '</tool_call>' },
    { open: '<function_call', close: '</function_call>' },
    { open: '<function=', close: '</function>' },
    { open: '</parameter', close: '' },
    { open: '</arguments', close: '' },
    { open: '</function', close: '' },
    { open: '</tool_call', close: '' },
    { open: '</function_call', close: '' },
    { open: '<｜tool▁calls▁begin｜>', close: '<｜tool▁calls▁end｜>' },
    { open: '<|tool_calls_begin|>', close: '<|tool_calls_end|>' },
    { open: '<|python_tag|>', close: null },
    { open: '[tool_calls]', close: null },
    { open: '<|tool_calls_section_begin|>', close: '<|tool_calls_section_end|>' },
    { open: '<|tool_call_begin|>', close: '<|tool_call_end|>' },
    { open: '<|tool_call_argument_begin|>', close: '<|tool_call_end|>' },
    { open: '<|tool_call_end|>', close: '' },
    { open: '<|tool_calls_section_end|>', close: '' },
    { open: '```tool_code', close: '```' }
  ]
  const partialMarkerLength = (value: string): number => {
    let keep = 0
    for (const marker of markers) {
      const limit = Math.min(value.length, marker.open.length - 1)
      for (let length = 1; length <= limit; length += 1) {
        if (value.endsWith(marker.open.slice(0, length))) keep = Math.max(keep, length)
      }
    }
    const toolHeader = value.match(
      /(?:^|[\r\n])([A-Za-z_][\w.-]*\s*:\s*\d+\s*(?:<\|tool_call_argument_begin\|>)?)$/i
    )
    if (toolHeader?.[1]) keep = Math.max(keep, toolHeader[1].length)
    const genericRuntimeTag = value.match(/<(?:(?:runtime|host_runtime)_[a-z0-9_]*)$/i)
    if (genericRuntimeTag?.[0]) keep = Math.max(keep, genericRuntimeTag[0].length)
    return keep
  }
  return {
    push: (content) => {
      buffer += content
      while (buffer) {
        const lower = buffer.toLocaleLowerCase()
        if (activeCloseTag !== undefined) {
          if (activeCloseTag === null) {
            buffer = ''
            break
          }
          const closeIndex = lower.indexOf(activeCloseTag)
          if (closeIndex >= 0) {
            buffer = buffer.slice(closeIndex + activeCloseTag.length)
            activeCloseTag = undefined
            continue
          }
          const keep = Math.min(activeCloseTag.length - 1, buffer.length)
          if (buffer.length <= keep) break
          buffer = buffer.slice(-keep)
          break
        }
        const candidates = markers
          .map((marker) => ({ marker, index: lower.indexOf(marker.open) }))
          .filter((item) => item.index >= 0)
        const genericRuntimeBlock = lower.match(/<((?:runtime|host_runtime)_[a-z0-9_]+)\b/i)
        if (genericRuntimeBlock?.index !== undefined) {
          candidates.push({
            marker: {
              open: genericRuntimeBlock[0],
              close: `</${genericRuntimeBlock[1]}>`
            },
            index: genericRuntimeBlock.index
          })
        }
        const found = candidates.sort((left, right) => left.index - right.index)[0]
        if (found) {
          let visibleEnd = found.index
          if (found.marker.open === '<|tool_call_argument_begin|>') {
            const header = buffer
              .slice(0, found.index)
              .match(/([A-Za-z_][\w.-]*\s*:\s*\d+\s*)$/i)
            if (header?.[1]) visibleEnd -= header[1].length
          }
          onVisible(buffer.slice(0, visibleEnd))
          buffer = buffer.slice(found.index)
          const tagEnd = buffer.indexOf('>')
          if (found.marker.open.startsWith('[') || found.marker.open.startsWith('```')) {
            buffer = buffer.slice(found.marker.open.length)
          } else {
            if (tagEnd < 0) break
            buffer = buffer.slice(tagEnd + 1)
          }
          activeCloseTag = found.marker.close
          continue
        }
        if (!deferredJson && buffer.trimStart().startsWith('{')) {
          deferredJson = true
        }
        if (deferredJson) break
        const keep = partialMarkerLength(lower)
        if (buffer.length <= keep) break
        onVisible(buffer.slice(0, buffer.length - keep))
        buffer = keep > 0 ? buffer.slice(-keep) : ''
        break
      }
    },
    flush: (suppressDeferredJson = false) => {
      if (
        activeCloseTag === undefined &&
        (!deferredJson || !suppressDeferredJson)
      ) {
        onVisible(buffer)
      }
      buffer = ''
    }
  }
}

function createChannelRouter(
  onContent: (content: string) => void,
  onReasoning: (content: string) => void
): { push: (content: string) => void; flush: () => void } {
  const openTag = '<|channel|>'
  const closeTags = ['<|channel|>', '<|message|>']
  let buffer = ''
  let channel: 'content' | 'reasoning' = 'content'
  let readingLabel = false
  const emit = (value: string): void => {
    if (!value) return
    if (channel === 'reasoning') onReasoning(value)
    else onContent(value)
  }
  const partialOpenLength = (value: string): number => {
    const limit = Math.min(value.length, openTag.length - 1)
    for (let length = limit; length > 0; length -= 1) {
      if (value.endsWith(openTag.slice(0, length))) return length
    }
    return 0
  }
  return {
    push: (content) => {
      buffer += content
      while (buffer) {
        const lower = buffer.toLocaleLowerCase()
        if (readingLabel) {
          const close = closeTags
            .map((tag) => ({ tag, index: lower.indexOf(tag) }))
            .filter((item) => item.index >= 0)
            .sort((left, right) => left.index - right.index)[0]
          if (!close) {
            if (buffer.length > 80) {
              buffer = ''
              readingLabel = false
            }
            break
          }
          const label = lower.slice(0, close.index).trim()
          if (/^(?:thought|analysis|reasoning|commentary)$/.test(label)) {
            channel = 'reasoning'
          } else if (label === 'final') {
            channel = 'content'
          }
          buffer = buffer.slice(close.index + close.tag.length)
          readingLabel = false
          continue
        }
        const openIndex = lower.indexOf(openTag)
        if (openIndex < 0) {
          const keep = partialOpenLength(lower)
          if (buffer.length <= keep) break
          emit(buffer.slice(0, buffer.length - keep))
          buffer = keep ? buffer.slice(-keep) : ''
          break
        }
        emit(buffer.slice(0, openIndex))
        buffer = buffer.slice(openIndex + openTag.length)
        readingLabel = true
      }
    },
    flush: () => {
      if (!readingLabel && !buffer.toLocaleLowerCase().startsWith(openTag)) emit(buffer)
      buffer = ''
      readingLabel = false
    }
  }
}

type StreamRepetitionStop = {
  channel: 'content' | 'reasoning'
  periodCharacters: number
}

function createStreamRepetitionGuard(
  channel: StreamRepetitionStop['channel'],
  onStop: (stop: StreamRepetitionStop) => void
): { push: (value: string) => boolean } {
  const maxHistoryCharacters = 16_000
  const signatureCharacters = 96
  let history = ''
  let stopped = false
  let nextInspectionAt = 320

  return {
    push: (value) => {
      if (stopped) return true
      if (!value) return false
      history += value
      if (history.length < nextInspectionAt) return false
      nextInspectionAt = history.length + 48

      const sample = history.slice(-maxHistoryCharacters)
      if (sample.length < signatureCharacters * 2) return false
      const currentStart = sample.length - signatureCharacters
      const signature = sample.slice(currentStart)
      let previousStart = sample.lastIndexOf(signature, currentStart - 1)
      let inspectedCandidates = 0
      while (previousStart >= 0 && inspectedCandidates < 12) {
        const period = currentStart - previousStart
        if (period > 6_000) break
        if (period >= 80) {
          const repetitions = period >= 160 ? 2 : 3
          const requiredCharacters = period * repetitions
          if (requiredCharacters <= sample.length) {
            const repeatedTail = sample.slice(-requiredCharacters)
            const unit = repeatedTail.slice(0, period)
            let identical = true
            for (let index = 1; index < repetitions; index += 1) {
              if (repeatedTail.slice(index * period, (index + 1) * period) !== unit) {
                identical = false
                break
              }
            }
            if (identical && /\S/.test(unit)) {
              stopped = true
              onStop({ channel, periodCharacters: period })
              return true
            }
          }
        }
        inspectedCandidates += 1
        previousStart = sample.lastIndexOf(signature, previousStart - 1)
      }
      return false
    }
  }
}

function headers(model: ModelConfig): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' }
  if (model.apiKey) result.Authorization = `Bearer ${model.apiKey}`
  if (model.preset === 'kimi-code') {
    result['User-Agent'] = 'Xingban-AI/desktop'
    result['X-Client-Name'] = 'Xingban AI'
  }
  return result
}

async function responseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  if (!body.trim()) return `${response.status} ${response.statusText}`.trim()
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string } | string
      message?: string
    }
    const detail =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message || parsed.message || body
    return `${response.status} ${detail}`.trim()
  } catch {
    return `${response.status} ${body.slice(0, 800)}`.trim()
  }
}

function textField(value: unknown): string {
  return typeof value === 'string' ? sanitizeUnicodeString(value) : ''
}

function isLmStudioEndpoint(model: ModelConfig): boolean {
  return /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):1234(?:\/|$)/i.test(model.baseUrl)
}

function isQwenModel(model: ModelConfig): boolean {
  return /(?:^|[^a-z0-9])qwen(?:[^a-z0-9]|$)/i.test(model.model)
}

function openAiThinkingOptions(
  model: ModelConfig,
  overrideEnabled?: boolean
): Record<string, unknown> {
  if (model.preset === 'kimi-code') {
    return model.model === 'k3' ? { reasoning_effort: 'max' } : {}
  }
  const enableThinking =
    typeof overrideEnabled === 'boolean' ? overrideEnabled : resolveThinkingEnabled(model)
  if (typeof enableThinking !== 'boolean') return {}
  if (/dashscope\.aliyuncs\.com|dashscope-intl\.aliyuncs\.com/i.test(model.baseUrl)) {
    return isQwenModel(model) ? { enable_thinking: enableThinking } : {}
  }
  const lmStudioOpenAiEndpoint = isLmStudioEndpoint(model)
  if (!lmStudioOpenAiEndpoint && !isQwenModel(model)) return {}
  return {
    ...(lmStudioOpenAiEndpoint
      ? { reasoning_effort: enableThinking ? 'medium' : 'none' }
      : {}),
    chat_template_kwargs: {
      enable_thinking: enableThinking,
      preserve_thinking: enableThinking
    }
  }
}

function ollamaThinkingOptions(model: ModelConfig, overrideEnabled?: boolean): Record<string, unknown> {
  const enabled =
    typeof overrideEnabled === 'boolean' ? overrideEnabled : resolveThinkingEnabled(model)
  return typeof enabled === 'boolean' ? { think: enabled } : {}
}

function compatibleToolRequest(
  model: ModelConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[],
  requested: 'auto' | 'required'
): { messages: LlmMessage[]; toolChoice: 'auto' | 'required' } {
  if (model.preset !== 'kimi-code' || requested !== 'required') {
    return { messages, toolChoice: requested }
  }
  const names = tools.map((tool) => tool.function.name).join('、')
  return {
    messages: [
      ...messages,
      {
        role: 'system',
        content: `当前步骤必须调用一个可用工具后再继续，禁止直接结束任务。可用工具：${names}`
      }
    ],
    toolChoice: 'auto'
  }
}

function hostAttribute(attributes: string, name: string): string {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
  )
  return decodeXmlText(match?.[1] ?? match?.[2] ?? '').trim()
}

function hostSection(title: string, body: string, details: string[] = []): string {
  const metadata = details.filter(Boolean).join('\n')
  return [`\n\n## ${title}`, metadata, body.trim()].filter(Boolean).join('\n')
}

/**
 * Host metadata used to be embedded in messages as arbitrary XML. Qwen3.6 owns an
 * XML-shaped tool protocol, so app-only tags must never reach its chat template.
 * Keep the internal representation backward compatible and serialize it to plain
 * Markdown immediately before sending it to a model service.
 */
export function serializeHostMarkupForModel(value: string): string {
  let output = value
  const contextualBlocks: Array<{
    tag: string
    title: string
    detail?: (attributes: string) => string[]
  }> = [
    {
      tag: 'selected_code',
      title: '编辑器选区',
      detail: (attributes) => [
        `文件：${hostAttribute(attributes, 'path')}`,
        `行号：${hostAttribute(attributes, 'lines')}`
      ]
    },
    {
      tag: 'current_file',
      title: '当前文件',
      detail: (attributes) => [`文件：${hostAttribute(attributes, 'path')}`]
    },
    {
      tag: 'file',
      title: '引用文件',
      detail: (attributes) => [`文件：${hostAttribute(attributes, 'path')}`]
    },
    {
      tag: 'file_reference',
      title: '文件引用',
      detail: (attributes) => [
        `文件：${hostAttribute(attributes, 'path')}`,
        `总行数：${hostAttribute(attributes, 'total_lines')}`
      ]
    },
    {
      tag: 'attachment',
      title: '附件',
      detail: (attributes) => [`名称：${hostAttribute(attributes, 'name')}`]
    },
    {
      tag: 'skill',
      title: '已启用技能',
      detail: (attributes) => [`名称：${hostAttribute(attributes, 'name')}`]
    },
    {
      tag: 'post_edit_file',
      title: '编辑后复查区间',
      detail: (attributes) => [
        `文件：${hostAttribute(attributes, 'path')}`,
        `修改行：${hostAttribute(attributes, 'changed_lines')}`,
        `读取行：${hostAttribute(attributes, 'read_lines')}`
      ]
    }
  ]
  for (const block of contextualBlocks) {
    const pattern = new RegExp(
      `<${block.tag}\\b([^>]*)>([\\s\\S]*?)<\\/${block.tag}\\s*>`,
      'gi'
    )
    output = output.replace(pattern, (_match, attributes: string, body: string) =>
      hostSection(block.title, body, block.detail?.(attributes) ?? [])
    )
    const selfClosingPattern = new RegExp(`<${block.tag}\\b([^>]*)\\/\\s*>`, 'gi')
    output = output.replace(selfClosingPattern, (_match, attributes: string) =>
      hostSection(block.title, '', block.detail?.(attributes) ?? [])
    )
  }

  const simpleBlocks: Array<[string, string]> = [
    ['current_task', '当前任务'],
    ['turn_boundary', '当前任务边界'],
    ['completed_history_input', '已完成历史输入'],
    ['completed_history_result', '已完成历史结果'],
    ['compressed_context', '已压缩上下文'],
    ['compressed_history_summary', '历史压缩摘要'],
    ['user_guidance', '用户补充'],
    ['user_guidance_history', '历史补充'],
    ['message_attachments', '消息附件'],
    ['task_state', '任务状态'],
    ['interaction_event', '交互事件'],
    ['host_runtime_context', '宿主运行环境'],
    ['live_web_evidence', '实时网页证据'],
    ['runtime_model_error', '模型运行错误'],
    ['task_understanding', '任务理解'],
    ['runtime_workflow_stage', '工作流阶段'],
    ['runtime_completion_guard', '任务完成检查'],
    ['runtime_replace_recovery', '精确替换恢复'],
    ['runtime_anchor_context', '选区上下文状态'],
    ['runtime_research_gate', '资料检索约束'],
    ['runtime_web_status', '网页检索状态'],
    ['runtime_history_status', '会话历史检索状态'],
    ['tool_runtime_observation', '工具运行观察'],
    ['post_edit_review', '编辑后复查']
  ]
  for (const [tag, title] of simpleBlocks) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi')
    output = output.replace(pattern, (_match, body: string) => hostSection(title, body))
    output = output.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), `【${title}】`)
  }
  output = output.replace(
    /<((?:runtime|host_runtime)_[a-z0-9_]+)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
    (_match, tag: string, body: string) => hostSection('运行时约束', body, [`类型：${tag}`])
  )
  output = output.replace(/<\/?(?:runtime|host_runtime)_[a-z0-9_]+\b[^>]*>/gi, '')
  return output.replace(/\n{4,}/g, '\n\n\n').trim()
}

function createStreamingTextNormalizer(
  onDelta: (content: string) => void
): { push: (content: string) => void; flush: () => void } {
  let mode: 'unknown' | 'delta' | 'snapshot' = 'unknown'
  let first = ''
  let snapshotCandidate = ''
  let snapshot = ''
  return {
    push: (incoming) => {
      if (!incoming) return
      if (mode === 'delta') {
        onDelta(incoming)
        return
      }
      if (mode === 'snapshot') {
        if (incoming.startsWith(snapshot)) {
          const delta = incoming.slice(snapshot.length)
          snapshot = incoming
          if (delta) onDelta(delta)
          return
        }
        if (snapshot.startsWith(incoming)) return
        mode = 'delta'
        onDelta(incoming)
        return
      }

      if (!first) {
        first = incoming
        onDelta(incoming)
        return
      }
      if (snapshotCandidate) {
        if (
          incoming.length >= snapshotCandidate.length &&
          incoming.startsWith(snapshotCandidate)
        ) {
          mode = 'snapshot'
          snapshot = incoming
          const delta = incoming.slice(first.length)
          first = ''
          snapshotCandidate = ''
          if (delta) onDelta(delta)
          return
        }
        mode = 'delta'
        onDelta(snapshotCandidate)
        snapshotCandidate = ''
        first = ''
        onDelta(incoming)
        return
      }

      if (incoming.length >= first.length && incoming.startsWith(first)) {
        snapshotCandidate = incoming
        return
      }

      mode = 'delta'
      first = ''
      onDelta(incoming)
    },
    flush: () => {
      if (snapshotCandidate) {
        const delta = snapshotCandidate.slice(first.length)
        if (delta) onDelta(delta)
      }
      first = ''
      snapshotCandidate = ''
    }
  }
}

function createReasoningTagFilter(
  onVisible: (content: string) => void
): { push: (content: string) => void; flush: () => void } {
  const tags = ['think', 'thinking', 'thought', 'analysis', 'reasoning'].flatMap((name) => [
    `<${name}>`,
    `</${name}>`
  ])
  let buffer = ''
  const partialTagLength = (value: string): number => {
    let keep = 0
    const lower = value.toLocaleLowerCase()
    for (const tag of tags) {
      const limit = Math.min(lower.length, tag.length - 1)
      for (let length = 1; length <= limit; length += 1) {
        if (lower.endsWith(tag.slice(0, length))) keep = Math.max(keep, length)
      }
    }
    return keep
  }
  return {
    push: (content) => {
      buffer += content
      while (buffer) {
        const lower = buffer.toLocaleLowerCase()
        const found = tags
          .map((tag) => ({ tag, index: lower.indexOf(tag) }))
          .filter((item) => item.index >= 0)
          .sort((left, right) => left.index - right.index)[0]
        if (found) {
          onVisible(buffer.slice(0, found.index))
          buffer = buffer.slice(found.index + found.tag.length)
          continue
        }
        const keep = partialTagLength(buffer)
        if (buffer.length <= keep) break
        onVisible(buffer.slice(0, buffer.length - keep))
        buffer = keep ? buffer.slice(-keep) : ''
        break
      }
    },
    flush: () => {
      onVisible(buffer.replace(/<\/?(?:think|thinking|thought|analysis|reasoning)\b[^>]*>/gi, ''))
      buffer = ''
    }
  }
}

function createThinkRouter(
  onContent: (content: string) => void,
  onReasoning: (content: string) => void
): { push: (chunk: string) => void; flush: () => void } {
  let buffer = ''
  let activeCloseTag = ''
  const tagPairs = ['think', 'thinking', 'thought', 'analysis', 'reasoning'].map((name) => ({
    open: `<${name}>`,
    close: `</${name}>`
  }))
  const allTags = tagPairs.flatMap((pair) => [pair.open, pair.close])
  const emit = (content: string): void => {
    if (!content) return
    if (activeCloseTag) onReasoning(content)
    else onContent(content)
  }
  const partialTagLength = (value: string): number => {
    let keep = 0
    for (const tag of allTags) {
      const limit = Math.min(value.length, tag.length - 1)
      for (let length = 1; length <= limit; length += 1) {
        if (value.endsWith(tag.slice(0, length))) keep = Math.max(keep, length)
      }
    }
    return keep
  }
  return {
    push: (chunk) => {
      buffer += chunk
      while (buffer) {
        const lower = buffer.toLocaleLowerCase()
        if (activeCloseTag) {
          const closeIndex = lower.indexOf(activeCloseTag)
          if (closeIndex >= 0) {
            emit(buffer.slice(0, closeIndex))
            buffer = buffer.slice(closeIndex + activeCloseTag.length)
            activeCloseTag = ''
            continue
          }
          const keep = partialTagLength(lower)
          if (buffer.length <= keep) break
          emit(buffer.slice(0, buffer.length - keep))
          buffer = keep ? buffer.slice(-keep) : ''
          break
        }
        const found = [
          ...tagPairs.map((pair) => ({ tag: pair.open, close: pair.close, opening: true })),
          ...tagPairs.map((pair) => ({ tag: pair.close, close: '', opening: false }))
        ]
          .map((item) => ({ ...item, index: lower.indexOf(item.tag) }))
          .filter((item) => item.index >= 0)
          .sort((left, right) => left.index - right.index)[0]
        if (found) {
          emit(buffer.slice(0, found.index))
          buffer = buffer.slice(found.index + found.tag.length)
          activeCloseTag = found.opening ? found.close : ''
          continue
        }
        const keep = partialTagLength(lower)
        if (buffer.length <= keep) break
        emit(buffer.slice(0, buffer.length - keep))
        buffer = keep ? buffer.slice(-keep) : ''
        break
      }
    },
    flush: () => {
      emit(buffer.replace(/<\/?(?:think|thinking|thought|analysis|reasoning)\b[^>]*>/gi, ''))
      buffer = ''
    }
  }
}

function toolCallIds(message: LlmMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return []
  return message.tool_calls.flatMap((call) => {
    if (!call || typeof call !== 'object') return []
    const id = (call as { id?: unknown }).id
    return typeof id === 'string' && id.trim() ? [id] : []
  })
}

/**
 * OpenAI-compatible endpoints require every assistant tool_calls entry to be
 * followed immediately by one tool message for each id. Runtime guidance can be
 * produced while parallel tools are being executed, so collect the matching tool
 * results ahead of that guidance before the request leaves the app. Missing
 * results are represented explicitly instead of sending an invalid conversation.
 */
export function normalizeToolMessageSequence(messages: LlmMessage[]): LlmMessage[] {
  const normalized: LlmMessage[] = []
  const consumedToolIndexes = new Set<number>()

  for (let index = 0; index < messages.length; index += 1) {
    if (consumedToolIndexes.has(index)) continue
    const message = messages[index]
    const expectedIds = toolCallIds(message)
    if (!expectedIds.length) {
      if (message.role !== 'tool') normalized.push(message)
      continue
    }

    normalized.push(message)
    const matchingResults = new Map<string, { index: number; message: LlmMessage }>()
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor]
      if (candidate.role === 'assistant') break
      if (
        candidate.role === 'tool' &&
        candidate.tool_call_id &&
        expectedIds.includes(candidate.tool_call_id) &&
        !matchingResults.has(candidate.tool_call_id)
      ) {
        matchingResults.set(candidate.tool_call_id, { index: cursor, message: candidate })
      }
    }

    for (const id of expectedIds) {
      const matched = matchingResults.get(id)
      if (matched) {
        consumedToolIndexes.add(matched.index)
        normalized.push(matched.message)
      } else {
        normalized.push({
          role: 'tool',
          tool_call_id: id,
          content: '工具调用未产生可用结果：执行被中断、取消或历史裁剪。请重新评估后再决定是否调用。'
        })
      }
    }
  }

  return normalized
}

function providerMessages(model: ModelConfig, messages: LlmMessage[]): unknown[] {
  const serialized = normalizeToolMessageSequence(messages).map((message) => ({
    ...message,
    content:
      message.role === 'tool' ? message.content : serializeHostMarkupForModel(message.content)
  }))
  if (model.provider === 'ollama') {
    return serialized.map((message) => ({
      ...message,
      images: message.images?.map((image) => image.replace(/^data:[^;]+;base64,/, ''))
    }))
  }
  return serialized.map((message) => {
    if (!message.images?.length) return message
    return {
      ...message,
      images: undefined,
      content: [
        { type: 'text', text: message.content },
        ...message.images.map((image) => ({
          type: 'image_url',
          image_url: { url: image }
        }))
      ]
    }
  })
}

export function estimateTextTokens(value: string): number {
  let ascii = 0
  let other = 0
  for (const character of value) {
    if (character.charCodeAt(0) <= 127) ascii += 1
    else other += 1
  }
  return Math.ceil(ascii / 4 + other)
}

function shortenContent(value: string, tokenLimit: number): string {
  if (estimateTextTokens(value) <= tokenLimit) return value
  const characterLimit = Math.max(800, tokenLimit * 2)
  const headLength = Math.floor(characterLimit * 0.62)
  const tailLength = characterLimit - headLength
  return `${value.slice(0, headLength)}\n\n[内容因上下文窗口限制已裁剪]\n\n${value.slice(-tailLength)}`
}

function shortenCoreContent(value: string, tokenLimit: number): string {
  if (estimateTextTokens(value) <= tokenLimit) return value
  const firstTag = value.search(/\n\n<(?:file|current_file|selected_code|attachment)\b/)
  const objective = firstTag >= 0 ? value.slice(0, firstTag) : value
  const selectedBlocks = [
    ...value.matchAll(/<selected_code\b[^>]*>[\s\S]*?<\/selected_code>/g)
  ].map((match) => match[0])
  const core = [objective, ...selectedBlocks].filter(Boolean).join('\n\n')
  if (estimateTextTokens(core) >= tokenLimit) return shortenContent(core, tokenLimit)
  const remaining = value.replace(objective, '').replace(
    /<selected_code\b[^>]*>[\s\S]*?<\/selected_code>/g,
    ''
  )
  return `${core}\n\n${shortenContent(
    remaining,
    Math.max(300, tokenLimit - estimateTextTokens(core))
  )}`
}

function latestUserMessageIndex(messages: LlmMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return index
  }
  return -1
}

function compressHistory(messages: LlmMessage[], tokenLimit: number): LlmMessage | null {
  if (!messages.length || tokenLimit < 180) return null
  const importantPattern =
    /(?:错误|失败|决定|要求|修改|创建|删除|测试|验证|文件|目录|路径|第\s*\d+\s*行|[A-Za-z]:\\|\/[\w.-]+\/|\.(?:ts|tsx|js|jsx|json|md|py|cs|go|rs|html|css)\b)/i
  const entries = messages.map((message) => {
    const lines = message.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const important = lines.filter((line) => importantPattern.test(line)).slice(0, 4)
    const first = lines.slice(0, message.role === 'user' ? 3 : 2)
    const selected = [...new Set([...first, ...important])]
    const label =
      message.role === 'user'
        ? '用户目标'
        : message.role === 'assistant'
          ? '智能体结论'
          : message.role === 'tool'
            ? '工具结果'
            : '系统信息'
    return `- ${label}：${selected.join(' ').slice(0, 900)}`
  })
  const summary = shortenContent(
    `此前对话已自动压缩，继续任务时必须保持以下目标、决定、文件路径与验证结论：\n${entries.join('\n')}`,
    tokenLimit
  )
  return { role: 'system', content: summary }
}

function fitMessagesToContext(
  model: ModelConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[] = [],
  semanticSummary = ''
): LlmMessage[] {
  const contextLength = Math.max(2048, model.contextLength || 8192)
  const toolTokens = estimateTextTokens(JSON.stringify(tools))
  const usableTokens = Math.max(
    1200,
    Math.floor(contextLength * CONTEXT_COMPRESSION_THRESHOLD) -
      Math.min(toolTokens, Math.floor(contextLength * 0.22))
  )
  const cloned = messages.map((message) => ({
    ...message,
    images: message.images ? [...message.images] : undefined
  }))
  const latestUserIndex = latestUserMessageIndex(cloned)
  if (latestUserIndex < 0) return cloned

  const persistedMemory = cloned.find(
    (message) =>
      message.role === 'system' && message.content.trimStart().startsWith('<compressed_context>')
  )
  const effectiveSummary =
    semanticSummary ||
    persistedMemory?.content
      .replace(/^\s*<compressed_context>\s*/i, '')
      .replace(/\s*<\/compressed_context>\s*$/i, '')
      .trim() ||
    ''
  const system = cloned.filter(
    (message, index) =>
      message.role === 'system' &&
      index < latestUserIndex &&
      !message.content.trimStart().startsWith('<compressed_context>')
  )
  const active = cloned.slice(latestUserIndex)
  const history = cloned.filter(
    (message, index) => index < latestUserIndex && message.role !== 'system'
  )

  const systemBudget = Math.max(800, Math.floor(usableTokens * 0.3))
  const combinedSystemContent = system.map((message) => message.content).join('\n\n')
  const fittedSystem = combinedSystemContent
    ? [
        {
          role: 'system' as const,
          content: shortenContent(combinedSystemContent, systemBudget)
        }
      ]
    : []
  let used = fittedSystem.reduce(
    (sum, message) => sum + estimateTextTokens(message.content) + 16,
    0
  )

  const activeBudget = Math.max(800, usableTokens - used)
  const activeTokenTotal = active.reduce(
    (sum, message) =>
      sum +
      estimateTextTokens(message.content) +
      (message.images?.length ?? 0) * 1200 +
      24,
    0
  )
  const fittedActive =
    activeTokenTotal <= activeBudget
      ? active
      : active.map((message, index) => {
          const share =
            index === 0
              ? Math.max(600, Math.floor(activeBudget * 0.46))
              : Math.max(240, Math.floor((activeBudget * 0.54) / Math.max(1, active.length - 1)))
          return {
            ...message,
            content:
              index === 0
                ? shortenCoreContent(message.content, share)
                : shortenContent(message.content, share)
          }
        })
  used += fittedActive.reduce(
    (sum, message) =>
      sum +
      estimateTextTokens(message.content) +
      (message.images?.length ?? 0) * 1200 +
      24,
    0
  )

  const fittedHistory: LlmMessage[] = []
  const historySpace = Math.max(0, usableTokens - used)
  const summaryReserve = Math.min(1200, Math.floor(historySpace * 0.28))
  let firstIncludedIndex = history.length
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    const cost = estimateTextTokens(message.content) + (message.images?.length ?? 0) * 1200 + 24
    if (used + cost > usableTokens - summaryReserve) break
    fittedHistory.unshift(message)
    firstIncludedIndex = index
    used += cost
  }
  const summaryBudget = Math.min(summaryReserve, Math.max(0, usableTokens - used))
  const compressed = effectiveSummary
    ? {
        role: 'system' as const,
        content: shortenContent(
          `此前对话已由当前本地模型压缩，必须保持摘要中的目标、决定和文件状态：\n${effectiveSummary}`,
          summaryBudget
        )
      }
    : compressHistory(history.slice(0, firstIncludedIndex), summaryBudget)
  return [
    ...fittedSystem,
    ...(compressed ? [compressed] : []),
    ...fittedHistory,
    ...fittedActive
  ]
}

const summaryCache = new Map<string, string>()

async function generateSemanticSummary(
  model: ModelConfig,
  messages: LlmMessage[],
  signal: AbortSignal,
  onProgress?: (content: string) => void
): Promise<{ summary: string; usage: TokenUsage }> {
  if (!messages.length) return { summary: '', usage: createUsage(0, 0) }
  const contextLength = Math.max(2048, model.contextLength || 8192)
  const summaryMaxTokens = Math.min(2048, Math.max(256, Math.floor(contextLength * 0.08)))
  const source = shortenContent(
    messages
      .map((message) => `${message.role.toUpperCase()}：${message.content}`)
      .join('\n\n'),
    Math.max(1000, Math.floor(contextLength * 0.34))
  )
  const cacheKey = `${model.provider}:${model.model}:${messages.length}:${source.slice(0, 160)}:${source.slice(-160)}`
  const cached = summaryCache.get(cacheKey)
  if (cached) return { summary: cached, usage: createUsage(0, 0) }
  const compressionMessages: LlmMessage[] = [
    {
      role: 'system',
      content:
        '你负责压缩智能体历史上下文。只输出结构化中文摘要，禁止补写、猜测、改写事实或省略仍影响后续执行的信息。严格按以下栏目输出：一、当前目标；二、硬性约束与用户偏好；三、关键事实与决定；四、人物关系、剧情状态或模块关系；五、文件路径、代码符号与精确行号；六、已完成修改与工具结果；七、错误、风险与测试结论；八、未完成事项与下一步。路径、标识符、命令、数值、接口名、人物名和用户原话中的硬约束必须原样保留。删除寒暄、重复解释、无关推理和冗长日志，但不能删除失败原因、改动范围及验证结果。'
    },
    {
      role: 'user',
      content: `请把以下历史压缩为可继续执行任务的核心记忆：\n\n${source}`
    }
  ]
  let summary = ''
  let usage = createUsage(
    compressionMessages.reduce((sum, message) => sum + estimateTextTokens(message.content), 0),
    0,
    true
  )
  if (onProgress) {
    onProgress('\n\n**正在压缩上下文**\n\n')
    const contentStream = createStreamingTextNormalizer((content) => {
      summary += content
      onProgress(content)
    })
    const reasoningStream = createStreamingTextNormalizer(onProgress)
    if (model.provider === 'ollama') {
      const response = await fetchModel(model, `${normalizeBaseUrl(model.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: headers(model),
        signal,
        body: safeJsonBody({
          model: model.model,
          messages: providerMessages(model, compressionMessages),
          stream: true,
          ...ollamaThinkingOptions(model, false),
          options: { num_predict: summaryMaxTokens }
        })
      })
      if (!response.ok || !response.body) {
        throw new Error(`上下文压缩失败：${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const data = JSON.parse(line) as {
            message?: {
              content?: string
              thinking?: string
              reasoning?: string
              reasoning_content?: string
            }
            error?: string
            prompt_eval_count?: number
            eval_count?: number
          }
          if (data.error) throw new Error(data.error)
          const reasoning =
            textField(data.message?.thinking) ||
            textField(data.message?.reasoning_content) ||
            textField(data.message?.reasoning)
          if (reasoning) reasoningStream.push(reasoning)
          if (data.message?.content) contentStream.push(data.message.content)
          if (
            typeof data.prompt_eval_count === 'number' ||
            typeof data.eval_count === 'number'
          ) {
            usage = createUsage(data.prompt_eval_count ?? 0, data.eval_count ?? 0)
          }
        }
      }
    } else {
      const response = await fetchModel(model, openAiEndpoint(model.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: headers(model),
        signal,
        body: safeJsonBody({
          model: model.model,
          messages: providerMessages(model, compressionMessages),
          stream: true,
          stream_options: { include_usage: true },
          ...openAiThinkingOptions(model, false),
          max_tokens: summaryMaxTokens
        })
      })
      if (!response.ok || !response.body) {
        throw new Error(`上下文压缩失败：${response.status}`)
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          const data = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
                reasoning?: string
                thinking?: string
              }
            }>
            usage?: OpenAiUsagePayload
          }
          const delta = data.choices?.[0]?.delta
          const reasoning =
            textField(delta?.reasoning_content) ||
            textField(delta?.reasoning) ||
            textField(delta?.thinking)
          if (reasoning) reasoningStream.push(reasoning)
          if (delta?.content) contentStream.push(delta.content)
          if (data.usage) {
            usage = createUsage(
              data.usage.prompt_tokens ?? 0,
              data.usage.completion_tokens ?? 0,
              false,
              undefined,
              cachedPromptTokensFromUsage(data.usage)
            )
          }
        }
      }
    }
    reasoningStream.flush()
    contentStream.flush()
    summary = summary.trim()
    if (usage.completionTokens === 0) {
      usage = createUsage(usage.promptTokens, estimateTextTokens(summary), true)
    }
    onProgress('\n\n**上下文压缩完成，继续处理当前任务。**\n\n')
  } else if (model.provider === 'ollama') {
    const response = await fetchModel(model, `${normalizeBaseUrl(model.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: headers(model),
      signal,
      body: safeJsonBody({
        model: model.model,
        messages: providerMessages(model, compressionMessages),
        stream: false,
        ...ollamaThinkingOptions(model, false),
        options: { num_predict: summaryMaxTokens }
      })
    })
    if (!response.ok) throw new Error(`上下文压缩失败：${response.status}`)
    const data = (await response.json()) as {
      message?: { content?: string }
      prompt_eval_count?: number
      eval_count?: number
    }
    summary = data.message?.content?.trim() ?? ''
    usage =
      typeof data.prompt_eval_count === 'number' || typeof data.eval_count === 'number'
        ? createUsage(data.prompt_eval_count ?? 0, data.eval_count ?? 0)
        : createUsage(usage.promptTokens, estimateTextTokens(summary), true)
  } else {
    const response = await fetchModel(model, openAiEndpoint(model.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headers(model),
      signal,
      body: safeJsonBody({
        model: model.model,
        messages: providerMessages(model, compressionMessages),
        stream: false,
        ...openAiThinkingOptions(model, false),
        max_tokens: summaryMaxTokens
      })
    })
    if (!response.ok) throw new Error(`上下文压缩失败：${response.status}`)
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
      usage?: OpenAiUsagePayload
    }
    summary = data.choices?.[0]?.message?.content?.trim() ?? ''
    usage =
      data.usage
        ? createUsage(
            data.usage.prompt_tokens ?? 0,
            data.usage.completion_tokens ?? 0,
            false,
            undefined,
            cachedPromptTokensFromUsage(data.usage)
          )
        : createUsage(usage.promptTokens, estimateTextTokens(summary), true)
  }
  if (summary) {
    summaryCache.set(cacheKey, summary)
    if (summaryCache.size > 24) summaryCache.delete(summaryCache.keys().next().value ?? '')
  }
  return { summary, usage }
}

async function prepareMessages(
  model: ModelConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  onCompressionProgress?: (content: string) => void
): Promise<{
  messages: LlmMessage[]
  compressionUsage: TokenUsage
  compressed: boolean
  contextMemory?: ContextCompressionMemory
}> {
  const contextLength = Math.max(2048, model.contextLength || 8192)
  const totalTokens =
    messages.reduce(
      (sum, message) =>
        sum +
        estimateTextTokens(message.content) +
        (message.images?.length ?? 0) * 1200 +
        24,
      0
    ) + estimateTextTokens(JSON.stringify(tools))
  if (totalTokens < contextLength * CONTEXT_COMPRESSION_THRESHOLD) {
    return {
      messages: fitMessagesToContext(model, messages, tools),
      compressionUsage: createUsage(0, 0),
      compressed: false
    }
  }
  const priorMemory = messages.filter(
    (message) =>
      message.role === 'system' && message.content.trimStart().startsWith('<compressed_context>')
  )
  const sourceMessages = messages.filter(
    (message) =>
      !(
        message.role === 'system' &&
        message.content.trimStart().startsWith('<compressed_context>')
      )
  )
  const latestUserIndex = latestUserMessageIndex(sourceMessages)
  const nonSystemEntries = sourceMessages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'system')
    .map((entry, nonSystemIndex) => ({ ...entry, nonSystemIndex }))
  let retainedTailStart = Math.max(0, nonSystemEntries.length - 8)
  while (retainedTailStart > 0 && nonSystemEntries[retainedTailStart]?.message.role === 'tool') {
    retainedTailStart -= 1
  }
  const protectedUserPattern = /<(?:current_task|user_guidance)\b/i
  const compressEntries = nonSystemEntries.filter((entry, index) => {
    if (index >= retainedTailStart) return false
    if (entry.message.role === 'user' && protectedUserPattern.test(entry.message.content)) {
      return false
    }
    return true
  })
  const compressEntryIndexes = new Set(compressEntries.map((entry) => entry.index))
  const compressCandidates = compressEntries.map((entry) => entry.message)
  const compactedSourceMessages = sourceMessages.filter(
    (_message, index) => !compressEntryIndexes.has(index)
  )
  const compressCandidateTokens = compressCandidates.reduce(
    (sum, message) =>
      sum +
      estimateTextTokens(message.content) +
      (message.images?.length ?? 0) * 1200 +
      24,
    0
  )
  if (
    !compressCandidates.length ||
    compressCandidateTokens < Math.max(256, Math.floor(contextLength * 0.08))
  ) {
    return {
      messages: fitMessagesToContext(model, messages, tools),
      compressionUsage: createUsage(0, 0),
      compressed: false
    }
  }
  try {
    const compressed = await generateSemanticSummary(
      model,
      [...priorMemory, ...compressCandidates],
      signal,
      onCompressionProgress
    )
    return {
      messages: fitMessagesToContext(model, compactedSourceMessages, tools, compressed.summary),
      compressionUsage: compressed.usage,
      compressed: Boolean(compressed.summary),
      contextMemory: compressed.summary
          ? {
            summary: compressed.summary,
            compressedMessageCount: compressEntries.filter(
              (entry) => entry.index < latestUserIndex
            ).length,
            compressedNonSystemIndexes: compressEntries.map(
              (entry) => entry.nonSystemIndex
            )
          }
        : undefined
    }
  } catch {
    return {
      messages: fitMessagesToContext(model, messages, tools),
      compressionUsage: createUsage(0, 0),
      compressed: false
    }
  }
}

export async function testModelConnection(
  model: ModelConfig
): Promise<{ ok: boolean; models: string[]; message: string }> {
  try {
    if (model.preset === 'kimi-code') {
      if (!model.apiKey?.trim()) throw new Error('请先填写 Kimi Code API Key')
      const response = await fetchModel(model, openAiEndpoint(model.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: headers(model),
        signal: AbortSignal.timeout(30000),
        body: safeJsonBody({
          model: model.model || 'kimi-for-coding',
          messages: [{ role: 'user', content: 'Reply OK.' }],
          max_tokens: 1,
          stream: false
        })
      })
      if (!response.ok) throw new Error(await responseError(response))
      return {
        ok: true,
        models: ['k3', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
        message:
          model.model === 'k3'
            ? 'Kimi K3 连接成功'
            : model.model === 'kimi-for-coding-highspeed'
              ? 'Kimi K2.7 Code 高速版连接成功'
              : 'Kimi K2.7 Code 连接成功'
      }
    }
    const url =
      model.provider === 'ollama'
        ? `${normalizeBaseUrl(model.baseUrl)}/api/tags`
        : openAiEndpoint(model.baseUrl, '/models')
    const response = await fetchModel(model, url, { headers: headers(model) })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = (await response.json()) as {
      models?: Array<{ name?: string; id?: string }>
      data?: Array<{ id?: string }>
    }
    const models =
      model.provider === 'ollama'
        ? (data.models ?? []).map((item) => item.name ?? '').filter(Boolean)
        : (data.data ?? []).map((item) => item.id ?? '').filter(Boolean)
    return { ok: true, models, message: `连接成功，发现 ${models.length} 个模型` }
  } catch (error) {
    return {
      ok: false,
      models: [],
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export function sameModel(left?: ModelConfig | null, right?: ModelConfig | null): boolean {
  if (!left || !right) return false
  return (
    left.provider === right.provider &&
    normalizeBaseUrl(left.baseUrl) === normalizeBaseUrl(right.baseUrl) &&
    left.model === right.model
  )
}

export async function unloadLocalModel(model: ModelConfig): Promise<{
  ok: boolean
  message: string
}> {
  if (!model.baseUrl || !model.model) {
    return { ok: true, message: '未选择模型，无需卸载' }
  }
  if (model.preset === 'kimi-code') {
    return { ok: true, message: 'Kimi Code 是云端服务，无需卸载本地模型' }
  }
  try {
    if (model.provider === 'ollama') {
      const response = await fetchModel(model, `${normalizeBaseUrl(model.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: headers(model),
        signal: AbortSignal.timeout(5000),
        body: safeJsonBody({
          model: model.model,
          messages: [],
          keep_alive: 0,
          stream: false
        })
      })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return { ok: true, message: `已卸载 Ollama 模型：${model.model}` }
    }

    const origin = new URL(model.baseUrl).origin
    const unloadInstance = async (instanceId: string): Promise<boolean> => {
      const response = await fetchModel(model, `${origin}/api/v1/models/unload`, {
        method: 'POST',
        headers: headers(model),
        signal: AbortSignal.timeout(6000),
        body: safeJsonBody({ instance_id: instanceId })
      })
      return response.ok
    }

    const listResponse = await fetchModel(model, `${origin}/api/v1/models`, {
      headers: headers(model),
      signal: AbortSignal.timeout(3000)
    })
    if (listResponse.ok) {
      const data = (await listResponse.json()) as {
        models?: Array<{
          key?: string
          display_name?: string
          loaded_instances?: Array<{ id?: string }>
        }>
      }
      const matched = (data.models ?? []).filter(
        (item) =>
          item.key === model.model ||
          item.display_name === model.model ||
          item.loaded_instances?.some((instance) => instance.id === model.model)
      )
      const instanceIds = [
        ...new Set(
          matched.flatMap((item) =>
            (item.loaded_instances ?? []).map((instance) => instance.id).filter(Boolean)
          ) as string[]
        )
      ]
      if (instanceIds.length) {
        const results = await Promise.all(instanceIds.map((id) => unloadInstance(id)))
        const count = results.filter(Boolean).length
        return {
          ok: count > 0,
          message: count
            ? `已卸载 LM Studio 模型实例：${count}/${instanceIds.length}`
            : `LM Studio 返回失败，未能卸载：${model.model}`
        }
      }
    }

    const direct = await unloadInstance(model.model)
    return {
      ok: direct,
      message: direct
        ? `已卸载 LM Studio 模型：${model.model}`
        : `当前 OpenAI 兼容服务未提供可用卸载接口：${model.model}`
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function inspectModelContext(
  model: ModelConfig
): Promise<{ contextLength: number; maxContextLength: number; source: string }> {
  if (model.preset === 'kimi-code') {
    return {
      contextLength: 262144,
      maxContextLength: 262144,
      source: 'Kimi Code 官方配置'
    }
  }
  const fallback = Math.max(2048, model.contextLength || 8192)
  if (!model.baseUrl || !model.model) {
    return { contextLength: fallback, maxContextLength: fallback, source: '保守默认值' }
  }
  try {
    if (model.provider === 'ollama') {
      const response = await fetchModel(model, `${normalizeBaseUrl(model.baseUrl)}/api/show`, {
        method: 'POST',
        headers: headers(model),
        signal: AbortSignal.timeout(3000),
        body: safeJsonBody({ model: model.model })
      })
      if (!response.ok) throw new Error(String(response.status))
      const data = (await response.json()) as {
        parameters?: string
        model_info?: Record<string, unknown>
      }
      const parameterContext = Number(data.parameters?.match(/\bnum_ctx\s+(\d+)/)?.[1] || 0)
      const architectureContext = Math.max(
        0,
        ...Object.entries(data.model_info ?? {})
          .filter(([key, value]) => key.endsWith('.context_length') && typeof value === 'number')
          .map(([, value]) => Number(value))
      )
      const contextLength = parameterContext || architectureContext || fallback
      return {
        contextLength,
        maxContextLength: architectureContext || contextLength,
        source: parameterContext ? 'Ollama 当前配置' : 'Ollama 模型信息'
      }
    }

    const origin = new URL(model.baseUrl).origin
    const response = await fetchModel(model, `${origin}/api/v1/models`, {
      headers: headers(model),
      signal: AbortSignal.timeout(3000)
    })
    if (response.ok) {
      const data = (await response.json()) as {
        models?: Array<{
          key?: string
          display_name?: string
          max_context_length?: number
          loaded_instances?: Array<{ id?: string; config?: { context_length?: number } }>
        }>
      }
      const item = (data.models ?? []).find(
        (candidate) =>
          candidate.key === model.model ||
          candidate.display_name === model.model ||
          candidate.loaded_instances?.some((instance) => instance.id === model.model)
      )
      if (item) {
        const loaded = item.loaded_instances?.find((instance) => instance.id === model.model) ??
          item.loaded_instances?.[0]
        const contextLength =
          loaded?.config?.context_length || item.max_context_length || fallback
        return {
          contextLength,
          maxContextLength: item.max_context_length || contextLength,
          source: loaded?.config?.context_length ? 'LM Studio 已加载配置' : 'LM Studio 模型上限'
        }
      }
    }

    const propsResponse = await fetchModel(model, `${origin}/props`, {
      signal: AbortSignal.timeout(1800)
    })
    if (propsResponse.ok) {
      const props = (await propsResponse.json()) as {
        default_generation_settings?: { n_ctx?: number }
      }
      const contextLength = props.default_generation_settings?.n_ctx || fallback
      return { contextLength, maxContextLength: contextLength, source: '本地服务配置' }
    }
  } catch {
    // Older compatible servers may not expose model metadata.
  }
  return {
    contextLength: fallback,
    maxContextLength: model.maxContextLength || fallback,
    source: '保守默认值'
  }
}

export async function discoverLocalModels(): Promise<ModelOption[]> {
  const discovered: ModelOption[] = []

  const probeOllama = async (): Promise<void> => {
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags', {
        signal: AbortSignal.timeout(1800)
      })
      if (!response.ok) return
      const data = (await response.json()) as { models?: Array<{ name?: string }> }
      for (const item of data.models ?? []) {
        if (!item.name) continue
        discovered.push({
          id: `ollama:${item.name}`,
          name: item.name,
          provider: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          source: 'Ollama'
        })
      }
    } catch {
      // Local service is optional.
    }
  }

  const probeOpenAiCompatible = async (
    baseUrl: string,
    source: ModelOption['source']
  ): Promise<void> => {
    try {
      const response = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(1800)
      })
      if (!response.ok) return
      const data = (await response.json()) as { data?: Array<{ id?: string }> }
      for (const item of data.data ?? []) {
        if (!item.id) continue
        if (/(^|[-_/])(embed|embedding)([-_/]|$)/i.test(item.id)) continue
        discovered.push({
          id: `${source}:${item.id}`,
          name: item.id,
          provider: 'openai',
          baseUrl,
          source
        })
      }
    } catch {
      // Local service is optional.
    }
  }

  await Promise.all([
    probeOllama(),
    probeOpenAiCompatible('http://127.0.0.1:1234/v1', 'LM Studio'),
    probeOpenAiCompatible('http://127.0.0.1:8080/v1', 'llama.cpp')
  ])

  await Promise.all(
    discovered.map(async (item) => {
      const info = await inspectModelContext({
        provider: item.provider,
        baseUrl: item.baseUrl,
        model: item.name
      })
      item.contextLength = info.contextLength
      item.maxContextLength = info.maxContextLength
    })
  )

  return discovered.filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === item.provider &&
          candidate.baseUrl === item.baseUrl &&
          candidate.name === item.name
      ) === index
  )
}

export async function streamChat(
  model: ModelConfig,
  messages: LlmMessage[],
  onChunk: (content: string) => void,
  signal: AbortSignal,
  onReasoning: (content: string) => void = () => undefined,
  options: {
    disableThinking?: boolean
    maxOutputTokens?: number
    onContextCompressed?: (memory: ContextCompressionMemory) => void
    onRepetitionStopped?: (stop: StreamRepetitionStop) => void
  } = {}
): Promise<TokenUsage> {
  const prepared = await prepareMessages(model, messages, [], signal, onReasoning)
  if (prepared.contextMemory) options.onContextCompressed?.(prepared.contextMemory)
  const estimatedPrompt = prepared.messages.reduce(
    (sum, message) => sum + estimateTextTokens(message.content),
    0
  )
  let output = ''
  let repetitionStop: StreamRepetitionStop | null = null
  const stopForRepetition = (stop: StreamRepetitionStop): void => {
    if (repetitionStop) return
    repetitionStop = stop
    options.onRepetitionStopped?.(stop)
  }
  const contentRepetitionGuard = createStreamRepetitionGuard('content', stopForRepetition)
  const reasoningRepetitionGuard = createStreamRepetitionGuard('reasoning', stopForRepetition)
  const visibleContent = createToolMarkupFilter((content) => {
    if (contentRepetitionGuard.push(content)) return
    output += content
    onChunk(content)
  })
  const visibleReasoning = createToolMarkupFilter((content) => {
    if (reasoningRepetitionGuard.push(content)) return
    onReasoning(content)
  })
  const reasoningTagFilter = createReasoningTagFilter((content) =>
    visibleReasoning.push(content)
  )
  const thinkRouter = createThinkRouter(
    (content) => visibleContent.push(content),
    (content) => reasoningTagFilter.push(content)
  )
  const channelRouter = createChannelRouter(
    (content) => thinkRouter.push(content),
    (content) => reasoningTagFilter.push(content)
  )
  const normalizedContent = createStreamingTextNormalizer((content) =>
    channelRouter.push(content)
  )
  const normalizedReasoning = createStreamingTextNormalizer((content) =>
    reasoningTagFilter.push(content)
  )
  if (model.provider === 'ollama') {
    const response = await fetchModel(model, `${normalizeBaseUrl(model.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: headers(model),
      signal,
      body: safeJsonBody({
        model: model.model,
        messages: providerMessages(model, prepared.messages),
        stream: true,
        ...ollamaThinkingOptions(model, options.disableThinking ? false : undefined),
        ...(options.maxOutputTokens
          ? { options: { num_predict: options.maxOutputTokens } }
          : {})
      })
    })
    if (!response.ok || !response.body) {
      throw new Error(`模型请求失败：${response.status} ${await response.text()}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let providerUsage: TokenUsage | null = null
    let firstOutputAt = 0
    let providerGenerationDurationMs: number | undefined
    ollamaChatStream: while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const data = JSON.parse(line) as {
          message?: { content?: string; thinking?: string; reasoning_content?: string }
          error?: string
          prompt_eval_count?: number
          eval_count?: number
          eval_duration?: number
        }
        if (data.error) throw new Error(data.error)
        const reasoning = textField(data.message?.thinking) || textField(data.message?.reasoning_content)
        if (reasoning) {
          if (!firstOutputAt) firstOutputAt = Date.now()
          normalizedReasoning.push(reasoning)
        }
        if (data.message?.content) {
          if (!firstOutputAt) firstOutputAt = Date.now()
          normalizedContent.push(data.message.content)
        }
        if (repetitionStop) {
          await reader.cancel().catch(() => undefined)
          break ollamaChatStream
        }
        if (
          typeof data.prompt_eval_count === 'number' ||
          typeof data.eval_count === 'number'
        ) {
          if (typeof data.eval_duration === 'number' && data.eval_duration > 0) {
            providerGenerationDurationMs = data.eval_duration / 1_000_000
          }
          providerUsage = createUsage(
            data.prompt_eval_count ?? 0,
            data.eval_count ?? 0,
            false,
            providerGenerationDurationMs
          )
        }
      }
    }
    normalizedContent.flush()
    normalizedReasoning.flush()
    channelRouter.flush()
    thinkRouter.flush()
    reasoningTagFilter.flush()
    visibleContent.flush()
    visibleReasoning.flush()
    return addUsage(
      prepared.compressionUsage,
      providerUsage
        ? attachGenerationDuration(
            providerUsage,
            providerGenerationDurationMs ?? (firstOutputAt ? Date.now() - firstOutputAt : undefined)
          )
        : createUsage(estimatedPrompt, estimateTextTokens(output), true)
    )
  }

  const response = await fetchModel(model, openAiEndpoint(model.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(model),
    signal,
    body: safeJsonBody({
      model: model.model,
      messages: providerMessages(model, prepared.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...openAiThinkingOptions(model, options.disableThinking ? false : undefined),
      ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {})
    })
  })
  if (!response.ok || !response.body) {
    throw new Error(`模型请求失败：${response.status} ${await response.text()}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let providerUsage: TokenUsage | null = null
  let firstOutputAt = 0
  openAiChatStream: while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      const data = JSON.parse(payload) as {
        error?:
          | string
          | { message?: string; type?: string; code?: string | number }
        choices?: Array<{
          delta?: {
            content?: string
            reasoning_content?: string
            reasoning?: string
            thinking?: string
          }
        }>
        usage?: OpenAiUsagePayload
      }
      const delta = data.choices?.[0]?.delta
      const reasoning =
        textField(delta?.reasoning_content) || textField(delta?.reasoning) || textField(delta?.thinking)
      if (reasoning) {
        if (!firstOutputAt) firstOutputAt = Date.now()
        normalizedReasoning.push(reasoning)
      }
      const content = delta?.content
      if (content) {
        if (!firstOutputAt) firstOutputAt = Date.now()
        normalizedContent.push(content)
      }
      if (repetitionStop) {
        await reader.cancel().catch(() => undefined)
        break openAiChatStream
      }
      if (data.usage) {
        providerUsage = createUsage(
          data.usage.prompt_tokens ?? 0,
          data.usage.completion_tokens ?? 0,
          false,
          undefined,
          cachedPromptTokensFromUsage(data.usage)
        )
      }
    }
  }
  normalizedContent.flush()
  normalizedReasoning.flush()
  channelRouter.flush()
  thinkRouter.flush()
  reasoningTagFilter.flush()
  visibleContent.flush()
  visibleReasoning.flush()
  return addUsage(
    prepared.compressionUsage,
    providerUsage
      ? attachGenerationDuration(
          providerUsage,
          firstOutputAt ? Date.now() - firstOutputAt : undefined
        )
      : createUsage(estimatedPrompt, estimateTextTokens(output), true)
  )
}

async function streamCompleteWithTools(
  model: ModelConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  toolChoice: 'auto' | 'required',
  onReasoning: (content: string) => void,
  onContent: (content: string) => void,
  options: { stopStrings?: string[] } = {}
): Promise<CompletionResult> {
  const prepared = await prepareMessages(model, messages, tools, signal, onReasoning)
  const compatible = compatibleToolRequest(model, prepared.messages, tools, toolChoice)
  const estimatedPrompt =
    compatible.messages.reduce(
      (sum, message) => sum + estimateTextTokens(message.content),
      0
  ) + estimateTextTokens(JSON.stringify(tools))
  let content = ''
  let reasoning = ''
  let repetitionStop: StreamRepetitionStop | null = null
  const stopForRepetition = (stop: StreamRepetitionStop): void => {
    if (!repetitionStop) repetitionStop = stop
  }
  const contentRepetitionGuard = createStreamRepetitionGuard('content', stopForRepetition)
  const reasoningRepetitionGuard = createStreamRepetitionGuard('reasoning', stopForRepetition)
  const visibleContent = createToolMarkupFilter(onContent)
  const visibleReasoning = createToolMarkupFilter(onReasoning)
  const appendReasoning = (value: string): void => {
    if (!value) return
    if (reasoningRepetitionGuard.push(value)) return
    reasoning += value
    visibleReasoning.push(value)
  }
  const reasoningTagFilter = createReasoningTagFilter(appendReasoning)
  const emitReasoning = (value: string): void => reasoningTagFilter.push(value)
  const thinkRouter = createThinkRouter(
    (value) => {
      if (contentRepetitionGuard.push(value)) return
      content += value
      visibleContent.push(value)
    },
    emitReasoning
  )
  const channelRouter = createChannelRouter(
    (value) => thinkRouter.push(value),
    emitReasoning
  )
  const normalizedContent = createStreamingTextNormalizer((value) =>
    channelRouter.push(value)
  )
  const normalizedReasoning = createStreamingTextNormalizer(emitReasoning)

  if (model.provider === 'ollama') {
    const response = await fetchModel(model, `${normalizeBaseUrl(model.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: headers(model),
      signal,
      body: safeJsonBody({
        model: model.model,
        messages: providerMessages(model, prepared.messages),
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
        ...ollamaThinkingOptions(model),
        ...(options.stopStrings?.length ? { options: { stop: options.stopStrings } } : {})
      })
    })
    if (!response.ok || !response.body) {
      throw new Error(`模型请求失败：${response.status} ${await response.text()}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let providerUsage: TokenUsage | null = null
    let firstOutputAt = 0
    let providerGenerationDurationMs: number | undefined
    let finishReason: string | undefined
    let rawToolCalls: Array<{
      id?: string
      function?: { name?: string; arguments?: unknown }
    }> = []
    ollamaToolStream: while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const data = JSON.parse(line) as {
          message?: {
            content?: string
            thinking?: string
            reasoning?: string
            reasoning_content?: string
            tool_calls?: Array<{
              id?: string
              function?: { name?: string; arguments?: unknown }
            }>
          }
          error?: string
          prompt_eval_count?: number
          eval_count?: number
          eval_duration?: number
          done_reason?: string
        }
        if (data.error) throw new Error(data.error)
        const thought =
          textField(data.message?.thinking) ||
          textField(data.message?.reasoning_content) ||
          textField(data.message?.reasoning)
        if (thought) {
          if (!firstOutputAt) firstOutputAt = Date.now()
          normalizedReasoning.push(thought)
        }
        if (data.message?.content) {
          if (!firstOutputAt) firstOutputAt = Date.now()
          normalizedContent.push(data.message.content)
        }
        if (data.message?.tool_calls?.length) {
          if (!firstOutputAt) firstOutputAt = Date.now()
          rawToolCalls = data.message.tool_calls
        }
        if (repetitionStop) {
          await reader.cancel().catch(() => undefined)
          break ollamaToolStream
        }
        if (
          typeof data.prompt_eval_count === 'number' ||
          typeof data.eval_count === 'number'
        ) {
          if (typeof data.eval_duration === 'number' && data.eval_duration > 0) {
            providerGenerationDurationMs = data.eval_duration / 1_000_000
          }
          providerUsage = createUsage(
            data.prompt_eval_count ?? 0,
            data.eval_count ?? 0,
            false,
            providerGenerationDurationMs
          )
        }
        if (data.done_reason) finishReason = data.done_reason
      }
    }
    normalizedContent.flush()
    normalizedReasoning.flush()
    channelRouter.flush()
    thinkRouter.flush()
    reasoningTagFilter.flush()
    const parsedTextCalls = parseTextToolCalls(
      content,
      reasoning,
      tools,
      model.model
    )
    visibleContent.flush(parsedTextCalls.toolCalls.length > 0)
    visibleReasoning.flush(parsedTextCalls.toolCalls.length > 0)
    const structuredToolCalls = rawToolCalls.map((call, index) =>
      normalizeStructuredToolCall(call, index, 'ollama')
    )
    const toolCalls =
      structuredToolCalls.length > 0 ? structuredToolCalls : parsedTextCalls.toolCalls
    const finalRawToolCalls =
      structuredToolCalls.length > 0
        ? rawToolCalls
        : toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
    const providerFinalUsage = providerUsage
      ? attachGenerationDuration(
          providerUsage,
          providerGenerationDurationMs ?? (firstOutputAt ? Date.now() - firstOutputAt : undefined)
        )
      :
      createUsage(
        estimatedPrompt,
        estimateTextTokens(content) + estimateTextTokens(JSON.stringify(rawToolCalls)),
        true
      )
    return {
      content: parsedTextCalls.content,
      reasoning: parsedTextCalls.reasoning,
      toolCalls,
      toolCallParseError: parsedTextCalls.toolCallParseError,
      rawMessage: {
        role: 'assistant',
        content: parsedTextCalls.content,
        reasoning_content: parsedTextCalls.reasoning,
        tool_calls: finalRawToolCalls
      },
      usage: addUsage(prepared.compressionUsage, providerFinalUsage),
      contextTokens: providerFinalUsage.promptTokens,
      contextEstimated: Boolean(providerFinalUsage.estimated),
      compressed: prepared.compressed,
      finishReason: toolCalls.length
        ? 'tool_calls'
        : repetitionStop
          ? 'repetition_guard'
          : finishReason
    }
  }

  const response = await fetchModel(model, openAiEndpoint(model.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(model),
    signal,
      body: safeJsonBody({
        model: model.model,
        messages: providerMessages(model, compatible.messages),
        ...(tools.length > 0
          ? { tools, tool_choice: compatible.toolChoice }
          : {}),
        stream: true,
      stream_options: { include_usage: true },
      ...openAiThinkingOptions(model),
      ...(options.stopStrings?.length ? { stop: options.stopStrings } : {})
    })
  })
  if (!response.ok || !response.body) {
    throw new Error(`模型请求失败：${response.status} ${await response.text()}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let providerUsage: TokenUsage | null = null
  let firstOutputAt = 0
  let finishReason: string | undefined
  const pendingToolCalls = new Map<
    number,
    { id?: string; name: string; arguments: string }
  >()
  openAiToolStream: while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      const data = JSON.parse(payload) as {
        error?:
          | string
          | { message?: string; type?: string; code?: string | number }
        choices?: Array<{
          finish_reason?: string
          delta?: {
            content?: string
            reasoning_content?: string
            reasoning?: string
            thinking?: string
            tool_calls?: Array<{
              index?: number
              id?: string
              function?: { name?: string; arguments?: string }
            }>
          }
        }>
        usage?: OpenAiUsagePayload
      }
      if (data.error) {
        const detail =
          typeof data.error === 'string'
            ? data.error
            : [data.error.message, data.error.type, data.error.code]
                .filter((value) => value !== undefined && value !== '')
                .join(' · ')
        throw new Error(`模型流返回错误：${detail || JSON.stringify(data.error)}`)
      }
      const choice = data.choices?.[0]
      const delta = choice?.delta
      const thought =
        textField(delta?.reasoning_content) ||
        textField(delta?.reasoning) ||
        textField(delta?.thinking)
      if (thought) {
        if (!firstOutputAt) firstOutputAt = Date.now()
        normalizedReasoning.push(thought)
      }
      if (delta?.content) {
        if (!firstOutputAt) firstOutputAt = Date.now()
        normalizedContent.push(delta.content)
      }
      for (const toolDelta of delta?.tool_calls ?? []) {
        if (!firstOutputAt) firstOutputAt = Date.now()
        const index = toolDelta.index ?? 0
        const current = pendingToolCalls.get(index) ?? { name: '', arguments: '' }
        if (toolDelta.id) current.id = toolDelta.id
        if (toolDelta.function?.name) {
          current.name = mergeStreamingFragment(current.name, toolDelta.function.name)
        }
        if (toolDelta.function?.arguments) {
          current.arguments = mergeStreamingFragment(
            current.arguments,
            toolDelta.function.arguments
          )
        }
        pendingToolCalls.set(index, current)
      }
      if (repetitionStop) {
        await reader.cancel().catch(() => undefined)
        break openAiToolStream
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason
      if (data.usage) {
        providerUsage = createUsage(
          data.usage.prompt_tokens ?? 0,
          data.usage.completion_tokens ?? 0,
          false,
          undefined,
          cachedPromptTokensFromUsage(data.usage)
        )
      }
    }
  }
  normalizedContent.flush()
  normalizedReasoning.flush()
  channelRouter.flush()
  thinkRouter.flush()
  reasoningTagFilter.flush()
  const parsedTextCalls = parseTextToolCalls(
    content,
    reasoning,
    tools,
    model.model
  )
  visibleContent.flush(parsedTextCalls.toolCalls.length > 0)
  visibleReasoning.flush(parsedTextCalls.toolCalls.length > 0)
  const rawToolCalls = [...pendingToolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => ({
      id: call.id ?? `openai-${Date.now()}-${index}`,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments
      }
    }))
  const structuredToolCalls = rawToolCalls.map((call, index) =>
    normalizeStructuredToolCall(call, index, 'openai')
  )
  const toolCalls =
    structuredToolCalls.length > 0 ? structuredToolCalls : parsedTextCalls.toolCalls
  const finalRawToolCalls =
    structuredToolCalls.length > 0
      ? rawToolCalls
      : toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
  const providerFinalUsage = providerUsage
    ? attachGenerationDuration(
        providerUsage,
        firstOutputAt ? Date.now() - firstOutputAt : undefined
      )
    :
    createUsage(
      estimatedPrompt,
      estimateTextTokens(content) + estimateTextTokens(JSON.stringify(rawToolCalls)),
      true
    )
  return {
    content: parsedTextCalls.content,
    reasoning: parsedTextCalls.reasoning,
    toolCalls,
    toolCallParseError: parsedTextCalls.toolCallParseError,
    rawMessage: {
      role: 'assistant',
      content: parsedTextCalls.content,
      reasoning_content: parsedTextCalls.reasoning,
      tool_calls: finalRawToolCalls
    },
    usage: addUsage(prepared.compressionUsage, providerFinalUsage),
    contextTokens: providerFinalUsage.promptTokens,
    contextEstimated: Boolean(providerFinalUsage.estimated),
    compressed: prepared.compressed,
    contextMemory: prepared.contextMemory,
    finishReason: toolCalls.length
      ? 'tool_calls'
      : repetitionStop
        ? 'repetition_guard'
        : finishReason
  }
}

export async function completeWithTools(
  model: ModelConfig,
  messages: LlmMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  toolChoice: 'auto' | 'required' = 'auto',
  onReasoning?: (content: string) => void,
  onContent?: (content: string) => void,
  options: { stopStrings?: string[] } = {}
): Promise<CompletionResult> {
  if (onReasoning || onContent) {
    return streamCompleteWithTools(
      model,
      messages,
      tools,
      signal,
      toolChoice,
      onReasoning ?? (() => undefined),
      onContent ?? (() => undefined),
      options
    )
  }
  const prepared = await prepareMessages(model, messages, tools, signal)
  const compatible = compatibleToolRequest(model, prepared.messages, tools, toolChoice)
  const estimatedPrompt =
    compatible.messages.reduce(
      (sum, message) => sum + estimateTextTokens(message.content),
      0
    ) + estimateTextTokens(JSON.stringify(tools))
  if (model.provider === 'ollama') {
    const response = await fetchModel(model, `${normalizeBaseUrl(model.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: headers(model),
      signal,
      body: safeJsonBody({
        model: model.model,
        messages: providerMessages(model, prepared.messages),
        ...(tools.length > 0 ? { tools } : {}),
        stream: false,
        ...ollamaThinkingOptions(model),
        ...(options.stopStrings?.length ? { options: { stop: options.stopStrings } } : {})
      })
    })
    if (!response.ok) throw new Error(`模型请求失败：${response.status} ${await response.text()}`)
    const data = (await response.json()) as {
      message?: {
        role?: string
        content?: string
        thinking?: string
        reasoning?: string
        reasoning_content?: string
        tool_calls?: Array<{
          id?: string
          function?: { name?: string; arguments?: unknown }
        }>
      }
      prompt_eval_count?: number
      eval_count?: number
      done_reason?: string
    }
    const message = data.message ?? {}
    const structuredToolCalls = (message.tool_calls ?? []).map((call, index) =>
      normalizeStructuredToolCall(call, index, 'ollama')
    )
    const rawReasoning =
      textField(message.thinking) ||
      textField(message.reasoning_content) ||
      textField(message.reasoning)
    const parsedTextCalls = parseTextToolCalls(
      message.content ?? '',
      rawReasoning,
      tools,
      model.model
    )
    const toolCalls =
      structuredToolCalls.length > 0 ? structuredToolCalls : parsedTextCalls.toolCalls
    const finalRawToolCalls =
      structuredToolCalls.length > 0
        ? message.tool_calls ?? []
        : toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
    const rawMessage: LlmMessage = {
      role: 'assistant',
      content: parsedTextCalls.content,
      reasoning_content: parsedTextCalls.reasoning,
      tool_calls: finalRawToolCalls
    }
    const providerUsage =
      typeof data.prompt_eval_count === 'number' || typeof data.eval_count === 'number'
        ? createUsage(data.prompt_eval_count ?? 0, data.eval_count ?? 0)
        : createUsage(
            estimatedPrompt,
            estimateTextTokens(message.content ?? '') +
              estimateTextTokens(JSON.stringify(message.tool_calls ?? [])),
            true
          )
    return {
      content: parsedTextCalls.content,
      reasoning: parsedTextCalls.reasoning,
      toolCalls,
      toolCallParseError: parsedTextCalls.toolCallParseError,
      rawMessage,
      usage: addUsage(prepared.compressionUsage, providerUsage),
      contextTokens: providerUsage.promptTokens,
      contextEstimated: Boolean(providerUsage.estimated),
      compressed: prepared.compressed,
      contextMemory: prepared.contextMemory,
      finishReason: toolCalls.length ? 'tool_calls' : data.done_reason
    }
  }

  const response = await fetchModel(model, openAiEndpoint(model.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: headers(model),
    signal,
    body: safeJsonBody({
      model: model.model,
      messages: providerMessages(model, compatible.messages),
      ...(tools.length > 0
        ? { tools, tool_choice: compatible.toolChoice }
        : {}),
      stream: false,
      ...openAiThinkingOptions(model),
      ...(options.stopStrings?.length ? { stop: options.stopStrings } : {})
    })
  })
  if (!response.ok) throw new Error(`模型请求失败：${response.status} ${await response.text()}`)
  const data = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string
      message?: {
        content?: string
        reasoning?: string
        reasoning_content?: string
        thinking?: string
        tool_calls?: Array<{
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
    }>
    usage?: OpenAiUsagePayload
  }
  const message = data.choices?.[0]?.message ?? {}
  const structuredToolCalls = (message.tool_calls ?? []).map((call, index) =>
    normalizeStructuredToolCall(call, index, 'openai')
  )
  const rawReasoning =
    textField(message.reasoning_content) ||
    textField(message.reasoning) ||
    textField(message.thinking)
  const parsedTextCalls = parseTextToolCalls(
    message.content ?? '',
    rawReasoning,
    tools,
    model.model
  )
  const toolCalls =
    structuredToolCalls.length > 0 ? structuredToolCalls : parsedTextCalls.toolCalls
  const finalRawToolCalls =
    structuredToolCalls.length > 0
      ? message.tool_calls ?? []
      : toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }))
  const rawMessage: LlmMessage = {
    role: 'assistant',
    content: parsedTextCalls.content,
    reasoning_content: parsedTextCalls.reasoning,
    tool_calls: finalRawToolCalls
  }
  const providerUsage = data.usage
    ? createUsage(
        data.usage.prompt_tokens ?? 0,
        data.usage.completion_tokens ?? 0,
        false,
        undefined,
        cachedPromptTokensFromUsage(data.usage)
      )
    : createUsage(
        estimatedPrompt,
        estimateTextTokens(message.content ?? '') +
          estimateTextTokens(JSON.stringify(message.tool_calls ?? [])),
        true
      )
  return {
    content: parsedTextCalls.content,
    reasoning: parsedTextCalls.reasoning,
    toolCalls,
    toolCallParseError: parsedTextCalls.toolCallParseError,
    rawMessage,
    usage: addUsage(prepared.compressionUsage, providerUsage),
    contextTokens: providerUsage.promptTokens,
    contextEstimated: Boolean(providerUsage.estimated),
    compressed: prepared.compressed,
    contextMemory: prepared.contextMemory,
    finishReason: toolCalls.length ? 'tool_calls' : data.choices?.[0]?.finish_reason
  }
}
