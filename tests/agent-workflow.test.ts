import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commandContainsDestructiveOperation,
  shouldRequestToolApproval,
  toolAvailableInStage,
  workflowToolChoice
} from '../src/main/agent-workflow.ts'

test('理解阶段不向模型暴露操作工具', () => {
  for (const tool of ['replace_in_file', 'read_file', 'grep', 'search_files', 'update_tasks']) {
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
  for (const tool of ['replace_in_file', 'read_file', 'grep', 'search_files', 'update_tasks']) {
    assert.equal(toolAvailableInStage('execute', tool), true)
  }
  assert.equal(workflowToolChoice('execute', false), 'auto')
  assert.equal(workflowToolChoice('execute', true), 'required')
})

test('自动模式允许创建、修改和普通命令直接执行', () => {
  assert.equal(shouldRequestToolApproval('write', 'read-write-auto'), false)
  assert.equal(shouldRequestToolApproval('create', 'read-write-auto'), false)
  assert.equal(shouldRequestToolApproval('command', 'read-write-auto'), false)
})

test('手动模式确认写入、创建与命令', () => {
  assert.equal(shouldRequestToolApproval('write', 'read-write-manual'), true)
  assert.equal(shouldRequestToolApproval('create', 'read-write-manual'), true)
  assert.equal(shouldRequestToolApproval('command', 'read-write-manual'), true)
})

test('删除工具和删除命令始终确认', () => {
  assert.equal(shouldRequestToolApproval('delete', 'read-write-auto'), true)
  assert.equal(shouldRequestToolApproval('command', 'read-write-auto', true), true)
  for (const command of [
    'rm -rf dist',
    'Remove-Item cache -Recurse',
    'cmd /c del output.txt',
    'python -c "import shutil; shutil.rmtree(\'cache\')"',
    'node -e "fs.rm(\'dist\', { recursive: true })"',
    'git clean -fd'
  ]) {
    assert.equal(commandContainsDestructiveOperation(command), true, command)
  }
  assert.equal(commandContainsDestructiveOperation('python scripts/build.py'), false)
  assert.equal(commandContainsDestructiveOperation('npm run build'), false)
})
