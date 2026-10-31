import { Temporal } from '@js-temporal/polyfill';
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export function reportPeriodStart(date: Date, period: 'today' | 'year', timezone = 'Asia/Kolkata') {
  let local = Temporal.Instant.from(date.toISOString()).toZonedDateTimeISO(timezone);
  if (period === 'year') local = local.with({ month: 1, day: 1 });
  return new Date(local.startOfDay().epochMilliseconds);
}
export function reportMonths(from: Date, to: Date, timezone = 'Asia/Kolkata') {
  let month = Temporal.Instant.from(from.toISOString())
    .toZonedDateTimeISO(timezone)
    .with({ day: 1 })
    .startOfDay();
  const result: { label: string; until: Date }[] = [];
  while (month.epochMilliseconds < to.getTime()) {
    const next = month.add({ months: 1 });
    result.push({
      label: `${month.year}-${String(month.month).padStart(2, '0')}`,
      until: new Date(next.epochMilliseconds),
    });
    month = next;
  }
  return result;
}
export function nextBillingDate(
  current: Date,
  frequency: Frequency,
  timezone: string,
  anchorDay: number,
  anchorMonth: number,
) {
  const local = Temporal.Instant.from(current.toISOString()).toZonedDateTimeISO(timezone);
  let next: Temporal.ZonedDateTime;
  if (frequency === 'daily' || frequency === 'weekly')
    next = local.add({ days: frequency === 'daily' ? 1 : 7 });
  else if (frequency === 'monthly') {
    const target = local.with({ day: 1 }).add({ months: 1 });
    next = target.with({ day: Math.min(anchorDay, target.daysInMonth) });
  } else {
    const target = local.with({ day: 1, month: anchorMonth }).add({ years: 1 });
    next = target.with({ day: Math.min(anchorDay, target.daysInMonth) });
  }
  return new Date(next.epochMilliseconds);
}
export function anchorFor(date: Date, timezone: string) {
  const local = Temporal.Instant.from(date.toISOString()).toZonedDateTimeISO(timezone);
  return { anchorDay: local.day, anchorMonth: local.month };
}
export const allowedTransitions: Record<string, string[]> = {
  draft: ['quotation', 'confirmed'],
  quotation: ['confirmed'],
  confirmed: ['active', 'cancelled'],
  active: ['paused', 'cancelled', 'closed'],
  paused: ['active', 'cancelled', 'closed'],
  cancelled: [],
  closed: [],
};
export function assertTransition(from: string, to: string) {
  if (!allowedTransitions[from]?.includes(to))
    throw new Error(`Cannot change subscription from ${from} to ${to}`);
}
