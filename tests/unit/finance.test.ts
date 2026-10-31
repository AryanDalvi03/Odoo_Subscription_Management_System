import { test, expect } from '@jest/globals';
import { calculate, recurringRevenue } from '../../packages/domain/src/finance.js';
const lines = [{ productId: 'p', name: 'Accounting', quantity: 3, unitPriceMinor: 156000 }];
test('integer tax after percentage discount and variant-inclusive price', () => {
  const invoice = calculate(
    lines,
    [{ id: 't', name: 'Tax', rateBps: 1800, productIds: [] }],
    [
      {
        id: 'd',
        name: 'Offer',
        kind: 'percentage',
        value: 1000,
        productIds: [],
        minPurchaseMinor: 0,
        minQuantity: 1,
      },
    ],
  );
  expect(invoice.subtotalMinor).toBe(468000);
  expect(invoice.discountMinor).toBe(46800);
  expect(invoice.taxMinor).toBe(75816);
  expect(invoice.totalMinor).toBe(497016);
});
test('fixed discounts allocate exact paise and never make a negative invoice', () => {
  const result = calculate(
    [
      { ...lines[0]!, quantity: 1, unitPriceMinor: 1 },
      { ...lines[0]!, quantity: 1, unitPriceMinor: 2 },
    ],
    [],
    [
      {
        id: 'd',
        name: 'Fixed',
        kind: 'fixed',
        value: 2,
        productIds: [],
        minPurchaseMinor: 0,
        minQuantity: 1,
      },
    ],
  );
  expect(result.lines.map((line) => line.discountMinor)).toEqual([1, 1]);
  expect(result.totalMinor).toBe(1);
});
test('product eligibility and minimum quantity exclude discounts', () => {
  expect(
    calculate(
      lines,
      [],
      [
        {
          id: 'd',
          name: 'Other',
          kind: 'fixed',
          value: 100,
          productIds: ['other'],
          minPurchaseMinor: 0,
          minQuantity: 1,
        },
      ],
    ).discountMinor,
  ).toBe(0);
});
test('fractional quantities, unsafe integers and negative money fail', () => {
  expect(() => calculate([{ ...lines[0]!, quantity: 1.5 }], [], [])).toThrow();
  expect(() =>
    calculate([{ ...lines[0]!, unitPriceMinor: Number.MAX_SAFE_INTEGER }], [], []),
  ).toThrow();
  expect(() => calculate([{ ...lines[0]!, unitPriceMinor: -1 }], [], [])).toThrow();
});

test('MRR rounds after aggregating contracts and ARR remains exact', () => {
  expect(
    recurringRevenue([
      { amountMinor: 6, frequency: 'yearly' },
      { amountMinor: 6, frequency: 'yearly' },
    ]),
  ).toEqual({ mrrMinor: 1, arrMinor: 12 });
});
