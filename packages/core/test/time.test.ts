import { expect, test } from 'vitest'
import { addDays, taipeiDay, weekStart } from '../src/time'

test('已知瞬間：15:59Z 仍是台北 10/10，16:00Z 是 10/11', () => {
  expect(taipeiDay(new Date('2026-10-10T15:59:59.000Z'))).toBe('2026-10-10')
  expect(taipeiDay(new Date('2026-10-10T16:00:00.000Z'))).toBe('2026-10-11')
})

test('weekStart 週一到週日，跨月', () => {
  expect(weekStart('2026-10-10')).toBe('2026-10-05')
  expect(weekStart('2026-10-11')).toBe('2026-10-05')
  expect(weekStart('2026-10-12')).toBe('2026-10-12')
  expect(weekStart('2026-10-01')).toBe('2026-09-28')
})

test('addDays 跨月', () => {
  expect(addDays('2026-10-01', -3)).toBe('2026-09-28')
  expect(addDays('2026-10-05', 6)).toBe('2026-10-11')
})
