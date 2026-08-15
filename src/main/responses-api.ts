export type ResponsesSourceMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: unknown[]
  images?: string[]
}

export type ResponsesSourceTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ResponsesOutputItem = {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: Array<{ type?: string; text?: string }>
}

function stringToolCall(value: unknown): {
  id?: string
  function?: { name?: string; arguments?: unknown }
} | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const fn = record.function
  if (!fn || typeof fn !== 'object') return null
  return {
    id: typeof record.id === 'string' ? record.id : undefined,
    function: fn as { name?: string; arguments?: unknown }
  }
}

export function buildResponsesRequest(
  messages: ResponsesSourceMessage[],
  tools: ResponsesSourceTool[]
): { instructions?: string; input: unknown[]; tools: unknown[] } {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n\n')
  const input: unknown[] = []

  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      if (message.tool_call_id) {
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: message.content
        })
      }
      continue
    }
    if (message.role === 'assistant') {
      if (message.content) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }]
        })
      }
      for (const rawCall of message.tool_calls ?? []) {
        const call = stringToolCall(rawCall)
        if (!call?.function?.name) continue
        input.push({
          type: 'function_call',
          call_id: call.id || `call_${input.length}`,
          name: call.function.name,
          arguments:
            typeof call.function.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function.arguments ?? {})
        })
      }
      continue
    }
    input.push({
      role: 'user',
      content: [
        ...(message.content ? [{ type: 'input_text', text: message.content }] : []),
        ...(message.images ?? []).map((image) => ({ type: 'input_image', image_url: image }))
      ]
    })
  }

  return {
    ...(instructions ? { instructions } : {}),
    input,
    tools: tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false
    }))
  }
}

export function parseResponsesOutput(output: ResponsesOutputItem[]): {
  content: string
  reasoning: string
  rawToolCalls: Array<{
    id?: string
    function?: { name?: string; arguments?: string }
  }>
} {
  let content = ''
  let reasoning = ''
  const rawToolCalls: Array<{
    id?: string
    function?: { name?: string; arguments?: string }
  }> = []
  for (const item of output) {
    if (item.type === 'message') {
      content += (item.content ?? [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('')
    } else if (item.type === 'reasoning') {
      reasoning += (item.content ?? [])
        .filter((part) => part.type === 'reasoning_text')
        .map((part) => part.text ?? '')
        .join('')
    } else if (item.type === 'function_call' && item.name) {
      rawToolCalls.push({
        id: item.call_id || item.id,
        function: { name: item.name, arguments: item.arguments ?? '{}' }
      })
    }
  }
  return { content, reasoning, rawToolCalls }
}
