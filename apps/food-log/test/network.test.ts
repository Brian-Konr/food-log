import { expect, test } from 'vitest'
import { networkState } from '@/data/network'

test('瀏覽器離線就是 offline，有快取、pending 0 也一樣', () => {
  expect(networkState({
    browserOnline: false, backendOk: true, pending: 0, failStreak: 0, hasCache: true,
  })).toBe('offline')
  expect(networkState({
    browserOnline: false, backendOk: true, pending: 0, failStreak: 0, hasCache: false,
  })).toBe('offline')
})

test('寫入還沒用盡、backend 仍 ok 時有 pending 仍是 online', () => {
  expect(networkState({
    browserOnline: true, backendOk: true, pending: 1, failStreak: 0, hasCache: false,
  })).toBe('online')
})

test('backendOk false 且 pending > 0 是 unreachable，有沒有快取都一樣', () => {
  expect(networkState({
    browserOnline: true, backendOk: false, pending: 1, failStreak: 0, hasCache: true,
  })).toBe('unreachable')
  expect(networkState({
    browserOnline: true, backendOk: false, pending: 1, failStreak: 0, hasCache: false,
  })).toBe('unreachable')
})

test('有快取的讀取失敗不出橫幅', () => {
  expect(networkState({
    browserOnline: true, backendOk: true, pending: 0, failStreak: 2, hasCache: true,
  })).toBe('online')
})

test('沒快取且 failStreak 1 是 online', () => {
  expect(networkState({
    browserOnline: true, backendOk: true, pending: 0, failStreak: 1, hasCache: false,
  })).toBe('online')
  expect(networkState({
    browserOnline: true, backendOk: false, pending: 0, failStreak: 1, hasCache: false,
  })).toBe('online')
})

test('沒快取且連續兩次讀取失敗（含逾時）是 unreachable', () => {
  expect(networkState({
    browserOnline: true, backendOk: true, pending: 0, failStreak: 2, hasCache: false,
  })).toBe('unreachable')
})
