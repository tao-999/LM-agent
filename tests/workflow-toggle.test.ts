import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const chatSource = readFileSync(
  new URL('../src/renderer/src/components/ChatPanel.tsx', import.meta.url),
  'utf8'
)
const storeSource = readFileSync(
  new URL('../src/renderer/src/store.ts', import.meta.url),
  'utf8'
)
const agentSource = readFileSync(
  new URL('../src/main/agent.ts', import.meta.url),
  'utf8'
)

test('工作流开关位于 Skill 后并按会话保存', () => {
  const skillIndex = chatSource.indexOf('className="composer-skill-picker"')
  const workflowIndex = chatSource.indexOf('className={`composer-tool workflow-toggle')
  assert.ok(skillIndex >= 0 && workflowIndex > skillIndex)
  assert.match(chatSource, /setConversationAgentWorkflow\(conversation\.id/)
  assert.match(chatSource, /useWorkflow:\s*requestConversation\.useAgentWorkflow !== false/)
  assert.match(storeSource, /useAgentWorkflow:\s*true/)
  assert.match(storeSource, /setConversationAgentWorkflow:/)
})

test('关闭工作流后不强制理解、Tasks 与资料闸门', () => {
  assert.match(agentSource, /const useWorkflow = request\.useWorkflow !== false/)
  assert.match(agentSource, /stage:\s*initialWorkflowStage\(useWorkflow\)/)
  assert.match(agentSource, /!useWorkflow\s*\?\s*'complete'/)
  assert.match(agentSource, /当前为自主 Agent 模式/)
  assert.match(agentSource, /不要求建立任务清单/)
})
