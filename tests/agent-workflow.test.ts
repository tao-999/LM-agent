import assert from 'node:assert/strict'
import test from 'node:test'
import {
  toolAvailableInStage,
  workflowToolChoice
} from '../src/main/agent-workflow.ts'

test('理解阶段不向模型暴露操作工具', () => {
  for (const tool of ['replace_in_file', 'read_file', 'search_files', 'update_tasks']) {
    assert.equal(toolAvailableInStage('understand', tool), false)
  }
  assert.equal(workflowToolChoice('understand', true), 'auto')
})

test('任务清单阶段只开放 update_tasks 并强制工具调用', () => {
  assert.equal(toolAvailableInStage('tasks', 'update_tasks'), true)
  assert.equal(toolAvailableInStage('tasks', 'replace_in_file'), false)
  assert.equal(toolAvailableInStage('tasks', 'read_file'), false)
  assert.equal(workflowToolChoice('tasks', false), 'required')
})

test('执行阶段恢复完整工具能力', () => {
  for (const tool of ['replace_in_file', 'read_file', 'search_files', 'update_tasks']) {
    assert.equal(toolAvailableInStage('execute', tool), true)
  }
  assert.equal(workflowToolChoice('execute', false), 'auto')
  assert.equal(workflowToolChoice('execute', true), 'required')
})

