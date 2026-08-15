import assert from 'node:assert/strict'
import test from 'node:test'
import { GenerationInterruptLatch } from '../src/main/generation-interrupt.ts'

test('手动生成截断信号只消费一次', () => {
  const latch = new GenerationInterruptLatch()
  assert.equal(latch.request('request-a'), true)
  assert.equal(latch.take('request-a'), true)
  assert.equal(latch.take('request-a'), false)
})

test('不同请求的手动截断信号互不影响', () => {
  const latch = new GenerationInterruptLatch()
  latch.request('request-a')
  latch.request('request-b')
  latch.clear('request-a')
  assert.equal(latch.take('request-a'), false)
  assert.equal(latch.take('request-b'), true)
})

test('空请求标识不会留下截断信号', () => {
  const latch = new GenerationInterruptLatch()
  assert.equal(latch.request('   '), false)
  assert.equal(latch.take('   '), false)
})
