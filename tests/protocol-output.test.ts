import assert from 'node:assert/strict'
import test from 'node:test'
import { stripPrivateModelOutput } from '../src/main/protocol-output.ts'

test('removes private structure statistics details blocks', () => {
  const output = [
    '修改完成，人物反应更自然。',
    '<details><summary>本次会话结构统计（仅调试用）</summary>',
    'tokens: 25324, chunks: 25324, tokens_used: 97698',
    '</details>'
  ].join('\n')

  assert.equal(stripPrivateModelOutput(output).trim(), '修改完成，人物反应更自然。')
})

test('drops leaked workflow retry instructions and everything after them', () => {
  const output = [
    '修改完成，人物反应更自然。',
    '不好意思，好像出错了。希望以下内容对你有帮助',
    '任务类型判断错误，导致工具调用不符合预期。',
    '## 工作流提示',
    '由于此轮为工作流自动重试，以下信息仅供调试参考。'
  ].join('\n')

  assert.equal(stripPrivateModelOutput(output).trim(), '修改完成，人物反应更自然。')
})

test('removes leaked tool_code blocks while preserving surrounding reasoning', () => {
  const streamedChunks = [
    '先读取文件上下文。<tool_',
    'code> def read_file(path: str, around_line: int=None): ',
    '"""Reads a file window.""" </tool_',
    'code>用户要求修改一段小说文本，指出细节错误。'
  ]

  assert.equal(
    stripPrivateModelOutput(streamedChunks.join('')),
    '先读取文件上下文。用户要求修改一段小说文本，指出细节错误。'
  )
})

test('drops an unfinished tool_code block at the end of model output', () => {
  const output = '先读取文件上下文。<tool_code> def read_file(path: str):'

  assert.equal(stripPrivateModelOutput(output), '先读取文件上下文。')
})
