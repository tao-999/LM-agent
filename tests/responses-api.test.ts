import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildResponsesRequest,
  parseResponsesOutput
} from '../src/main/responses-api.ts'

test('Responses API 把系统指令、工具调用与工具结果转换为合法输入', () => {
  const request = buildResponsesRequest(
    [
      { role: 'system', content: '全局指令' },
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', function: { name: 'weather', arguments: '{"city":"上海"}' } }]
      },
      { role: 'tool', content: '晴，25度', tool_call_id: 'call_1' }
    ],
    [{
      type: 'function',
      function: {
        name: 'weather',
        description: '查询天气',
        parameters: { type: 'object' }
      }
    }]
  )
  assert.equal(request.instructions, '全局指令')
  assert.deepEqual(request.input[1], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'weather',
    arguments: '{"city":"上海"}'
  })
  assert.deepEqual(request.input[2], {
    type: 'function_call_output',
    call_id: 'call_1',
    output: '晴，25度'
  })
  assert.deepEqual(request.tools[0], {
    type: 'function',
    name: 'weather',
    description: '查询天气',
    parameters: { type: 'object' },
    strict: false
  })
})

test('Responses API 输出能分离思考、正文与工具调用', () => {
  const parsed = parseResponsesOutput([
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: '先查天气' }] },
    { type: 'message', content: [{ type: 'output_text', text: '正在查询' }] },
    { type: 'function_call', call_id: 'call_2', name: 'weather', arguments: '{"city":"北京"}' }
  ])
  assert.equal(parsed.reasoning, '先查天气')
  assert.equal(parsed.content, '正在查询')
  assert.equal(parsed.rawToolCalls[0]?.id, 'call_2')
  assert.equal(parsed.rawToolCalls[0]?.function?.name, 'weather')
})

test('只有 Agent 调用开启 Responses API，Chat 保持 Chat Completions', () => {
  const agent = readFileSync('src/main/agent.ts', 'utf8')
  const models = readFileSync('src/main/models.ts', 'utf8')
  assert.equal((agent.match(/useResponsesApi:\s*true/g) ?? []).length, 1)
  assert.match(models, /openAiEndpoint\(model\.baseUrl, '\/responses'\)/)
  assert.match(models, /openAiEndpoint\(model\.baseUrl, '\/chat\/completions'\)/)
})
