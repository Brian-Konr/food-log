// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UndoToast } from '@/components/UndoToast'
import type { Toast } from '@/types'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function firePointer(
  el: Element,
  type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointerleave',
  coords: { pointerId?: number; clientX?: number; clientY?: number } = {},
) {
  const init = { pointerId: 1, clientX: 0, clientY: 0, ...coords }
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'pointerId', { value: init.pointerId, configurable: true })
  Object.defineProperty(ev, 'clientX', { value: init.clientX, configurable: true })
  Object.defineProperty(ev, 'clientY', { value: init.clientY, configurable: true })
  fireEvent(el, ev)
}

function Harness(props: {
  queued: boolean
  toast: Toast
  onGone: () => void
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!props.queued) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [props.queued])
  return <UndoToast toast={props.toast} onGone={() => props.onGone()} />
}

test('每秒重畫不會把 3 秒 toast 拖過 4000ms', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  render(
    <Harness
      queued
      toast={{ id: 'a', message: '已記錄' }}
      onGone={() => calls.push('gone')}
    />,
  )
  expect(screen.getByRole('status')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(1000) })
  act(() => { vi.advanceTimersByTime(1000) })
  expect(screen.getByRole('status')).toBeTruthy()
  expect(calls).toEqual([])
  act(() => { vi.advanceTimersByTime(1000) })
  expect(calls).toEqual(['gone'])
})

test('換成新的 id 會重設 3 秒', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  const t1: Toast = { id: 'a', message: '一' }
  const t2: Toast = { id: 'b', message: '二' }
  const { rerender } = render(
    <UndoToast toast={t1} onGone={() => calls.push('gone')} />,
  )
  act(() => { vi.advanceTimersByTime(2000) })
  expect(calls).toEqual([])
  rerender(<UndoToast toast={t2} onGone={() => calls.push('gone')} />)
  act(() => { vi.advanceTimersByTime(2000) })
  expect(calls).toEqual([])
  expect(screen.getByRole('status').textContent).toContain('二')
  act(() => { vi.advanceTimersByTime(1000) })
  expect(calls).toEqual(['gone'])
})

test('按住暫停，橫向滑開後只走剩下的時間', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  render(<UndoToast toast={{ id: 'a', message: '已記錄' }} onGone={() => calls.push('gone')} />)
  const el = screen.getByRole('status')
  firePointer(el, 'pointerdown', { clientX: 10, clientY: 10 })
  act(() => { vi.advanceTimersByTime(5000) })
  expect(calls).toEqual([])
  firePointer(el, 'pointerup', { clientX: 40, clientY: 10 })
  expect(calls).toEqual([])
  act(() => { vi.advanceTimersByTime(2999) })
  expect(calls).toEqual([])
  act(() => { vi.advanceTimersByTime(1) })
  expect(calls).toEqual(['gone'])
})

test('pointercancel 與沒有 capture 的 pointerleave 不會卡住 held', () => {
  vi.useFakeTimers()
  const cancelCalls: string[] = []
  const { unmount } = render(
    <UndoToast toast={{ id: 'c', message: '已記錄' }} onGone={() => cancelCalls.push('gone')} />,
  )
  const el = screen.getByRole('status')
  firePointer(el, 'pointerdown', { clientX: 10, clientY: 10 })
  firePointer(el, 'pointercancel')
  act(() => { vi.advanceTimersByTime(3000) })
  expect(cancelCalls).toEqual(['gone'])
  unmount()

  const leaveCalls: string[] = []
  render(<UndoToast toast={{ id: 'd', message: '已記錄' }} onGone={() => leaveCalls.push('gone')} />)
  const el2 = screen.getByRole('status')
  firePointer(el2, 'pointerdown', { pointerId: 2, clientX: 10, clientY: 10 })
  fireEvent.pointerLeave(el2)
  act(() => { vi.advanceTimersByTime(3000) })
  expect(leaveCalls).toEqual(['gone'])
})

test('點一下關掉，不呼叫 undo', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  render(
    <UndoToast
      toast={{ id: 'a', message: '已記錄', undo: () => calls.push('undo') }}
      onGone={() => calls.push('gone')}
    />,
  )
  const el = screen.getByRole('status')
  firePointer(el, 'pointerdown', { clientX: 20, clientY: 20 })
  firePointer(el, 'pointerup', { clientX: 22, clientY: 21 })
  expect(calls).toEqual(['gone'])
})

test('往下滑關掉', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  render(<UndoToast toast={{ id: 'a', message: '已記錄' }} onGone={() => calls.push('gone')} />)
  const el = screen.getByRole('status')
  firePointer(el, 'pointerdown', { clientX: 20, clientY: 20 })
  firePointer(el, 'pointerup', { clientX: 22, clientY: 50 })
  expect(calls).toEqual(['gone'])
})

test('點復原會 undo 一次並關掉', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  render(
    <UndoToast
      toast={{ id: 'a', message: '已記錄', undo: () => calls.push('undo') }}
      onGone={() => calls.push('gone')}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '復原' }))
  expect(calls).toEqual(['undo', 'gone'])
})

test('不傳 durationMs 時 2999ms 還在、3000ms 關掉', () => {
  vi.useFakeTimers()
  const calls: string[] = []
  render(<UndoToast toast={{ id: 'a', message: '已記錄' }} onGone={() => calls.push('gone')} />)
  act(() => { vi.advanceTimersByTime(2999) })
  expect(screen.getByRole('status')).toBeTruthy()
  expect(calls).toEqual([])
  act(() => { vi.advanceTimersByTime(1) })
  expect(calls).toEqual(['gone'])
})
