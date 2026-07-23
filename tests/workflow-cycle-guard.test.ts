import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { WorkflowCycleGuard } from '../src/main/workflow-cycle-guard.ts'

type FixtureItem = {
  toolName: string
  query: string
}

test('识别同一任务状态中改写关键词的历史检索工作流循环', async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL('./fixtures/workflow-history-search-loop.json', import.meta.url),
      'utf8'
    )
  ) as FixtureItem[]
  const guard = new WorkflowCycleGuard()
  const results = fixture.map((item) =>
    guard.observe({
      toolName: item.toolName,
      arguments: { query: item.query },
      taskState: 'edit:completed|review:completed',
      progressRevision: 4
    })
  )

  assert.equal(results[0].detected, false)
  assert.equal(results[1].detected, false)
  assert.equal(results[2].detected, true)
})

test('真实进度变化后相同工具属于新阶段', () => {
  const guard = new WorkflowCycleGuard()
  for (let revision = 1; revision <= 3; revision += 1) {
    const result = guard.observe({
      toolName: 'search_conversation_history',
      arguments: { query: '续写 剧情推进' },
      taskState: 'edit:in_progress',
      progressRevision: revision
    })
    assert.equal(result.detected, false)
  }
})

test('不同目标的历史检索不会误判为循环', () => {
  const guard = new WorkflowCycleGuard()
  const queries = ['用户喜欢的编辑器主题', 'Kimi 模型连接参数', '小说人物郭巨侠设定']
  for (const query of queries) {
    const result = guard.observe({
      toolName: 'search_conversation_history',
      arguments: { query },
      taskState: 'research:in_progress',
      progressRevision: 2
    })
    assert.equal(result.detected, false)
  }
})
