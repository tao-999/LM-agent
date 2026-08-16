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
const workflowSource = readFileSync(
  new URL('../src/main/agent-workflow.ts', import.meta.url),
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

test('关闭工作流不关闭模型原生思考通道', () => {
  assert.match(
    agentSource,
    /关闭工作流只是不注入分阶段流程，绝不关闭模型思考/
  )
})

test('工具模块默认收起且思考模块默认展开', () => {
  assert.match(
    chatSource,
    /className=\{`agent-step-card operation \$\{block\.status\}`\}[\s\S]*?initiallyOpen=\{false\}/
  )
  assert.match(
    chatSource,
    /className="agent-step-card thinking" initiallyOpen/
  )
})

test('关闭工作流后不强制理解、Tasks 与资料闸门', () => {
  assert.match(agentSource, /const useWorkflow = request\.useWorkflow !== false/)
  assert.match(agentSource, /stage:\s*initialWorkflowStage\(useWorkflow\)/)
  assert.match(agentSource, /!useWorkflow\s*\?\s*'complete'/)
  assert.match(agentSource, /当前为自主 Agent 模式/)
  assert.match(agentSource, /不强制建立任务清单/)
  assert.match(agentSource, /update_tasks 与当前权限允许的其他工具从首轮起全部开放/)
})

test('tasks 工具始终开放且不受工作流开关控制', () => {
  assert.match(workflowSource, /if \(toolName === 'update_tasks'\) return true/)
  assert.match(agentSource, /update_tasks 从首轮起始终可见/)
})

test('同批工具首项失败后取消旧调用并把真实原因交回模型', () => {
  assert.match(agentSource, /const skippedCalls = completion\.toolCalls\.slice\(callIndex \+ 1\)/)
  assert.match(agentSource, /同批次中前一个工具已经失败/)
  assert.match(agentSource, /工具失败运行时反馈/)
  assert.match(agentSource, /禁止继续沿用本轮尚未执行的旧调用/)
})
