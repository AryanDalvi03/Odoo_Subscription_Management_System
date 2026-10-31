import { test, expect } from '@jest/globals';
import {
  nextBillingDate,
  assertTransition,
  reportPeriodStart,
  reportMonths,
} from '../../packages/domain/src/recurrence.js';
test('monthly anchor clamps February and recovers March 31', () => {
  const feb = nextBillingDate(new Date('2028-01-31T04:30:00Z'), 'monthly', 'Asia/Kolkata', 31, 1);
  expect(feb.toISOString()).toBe('2028-02-29T04:30:00.000Z');
  expect(nextBillingDate(feb, 'monthly', 'Asia/Kolkata', 31, 1).toISOString()).toBe(
    '2028-03-31T04:30:00.000Z',
  );
});
test('calendar days preserve local time across DST', () => {
  expect(reportPeriodStart(new Date('2026-10-31T02:00:00Z'), 'today').toISOString()).toBe(
    '2026-10-30T18:30:00.000Z',
  );
  expect(reportPeriodStart(new Date('2026-10-31T02:00:00Z'), 'year').toISOString()).toBe(
    '2025-12-31T18:30:00.000Z',
  );
  expect(reportMonths(new Date('2025-12-31T18:30:00Z'), new Date('2026-01-31T18:30:00Z'))).toEqual([
    { label: '2026-01', until: new Date('2026-01-31T18:30:00Z') },
  ]);
  expect(
    nextBillingDate(
      new Date('2026-03-07T17:00:00Z'),
      'daily',
      'America/New_York',
      7,
      3,
    ).toISOString(),
  ).toBe('2026-03-08T16:00:00.000Z');
});
test('closed subscriptions cannot reactivate', () => {
  expect(() => assertTransition('closed', 'active')).toThrow();
  expect(() => assertTransition('active', 'paused')).not.toThrow();
});
