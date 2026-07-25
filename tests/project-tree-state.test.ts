import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isWorkspacePathExpanded,
  remapWorkspaceExpandedPaths,
  removeWorkspaceExpandedPaths,
  updateWorkspacePathExpanded
} from '../src/renderer/src/utils/project-tree-state.ts'

test('资源树保存文件夹展开与折叠状态', () => {
  const opened = updateWorkspacePathExpanded({}, 'C:/Work/Demo/Scripts', true)
  const collapsed = updateWorkspacePathExpanded(opened, 'C:\\Work\\Demo\\Data', false)

  assert.equal(isWorkspacePathExpanded(collapsed, 'c:\\work\\demo\\scripts'), true)
  assert.equal(isWorkspacePathExpanded(collapsed, 'C:/WORK/DEMO/DATA', true), false)
  assert.equal(isWorkspacePathExpanded(collapsed, 'C:/Work/Demo', true), true)
})

test('目录重命名后展开状态跟随新路径', () => {
  const state = {
    'c:\\work\\demo\\scripts': true,
    'c:\\work\\demo\\scripts\\core': false
  }

  assert.deepEqual(
    remapWorkspaceExpandedPaths(
      state,
      'C:\\Work\\Demo\\Scripts',
      'C:\\Work\\Demo\\Source'
    ),
    {
      'c:\\work\\demo\\source': true,
      'c:\\work\\demo\\source\\core': false
    }
  )
})

test('移除项目后同步清理该项目的展开状态', () => {
  assert.deepEqual(
    removeWorkspaceExpandedPaths(
      {
        'c:\\work\\demo': true,
        'c:\\work\\demo\\scripts': true,
        'c:\\work\\other': true
      },
      'C:\\Work\\Demo'
    ),
    { 'c:\\work\\other': true }
  )
})
