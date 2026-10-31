export type PriceLine = {
  productId: string;
  variantId?: string;
  name: string;
  quantity: number;
  unitPriceMinor: number;
};
export type TaxRule = { id: string; name: string; rateBps: number; productIds: string[] };
export type DiscountRule = {
  id: string;
  name: string;
  kind: 'fixed' | 'percentage';
  value: number;
  productIds: string[];
  minPurchaseMinor: number;
  minQuantity: number;
};
/** Deterministically allocate integer minor units while preserving the total. */
export function allocateMinor(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + integer(weight), 0n);
  const shares = weights.map(() => 0);
  if (amount === 0) return shares;
  if (total === 0n) throw new Error('Cannot allocate an amount without positive weights');
  const remainders = weights
    .map((weight, index) => {
      const value = integer(amount) * integer(weight);
      shares[index] = Number(value / total);
      return { index, remainder: value % total };
    })
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  let left = amount - shares.reduce((sum, share) => sum + share, 0);
  for (const row of remainders) {
    if (left-- <= 0) break;
    shares[row.index]!++;
  }
  return shares;
}
function integer(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid monetary integer');
  return BigInt(value);
}
function safe(value: bigint) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Financial amount exceeds supported limits');
  return Number(value);
}
export const roundRatio = (value: number, numerator: number, denominator: number) =>
  safe((integer(value) * integer(numerator) + integer(denominator) / 2n) / integer(denominator));
export function calculate(lines: PriceLine[], taxes: TaxRule[], discounts: DiscountRule[]) {
  if (!lines.length) throw new Error('At least one product line is required');
  const bases = lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100_000)
      throw new Error('Invalid quantity');
    return safe(integer(line.unitPriceMinor) * integer(line.quantity));
  });
  const subtotalMinor = safe(bases.reduce((a, b) => a + integer(b), 0n));
  let chosen: DiscountRule | undefined;
  let chosenAmount = 0;
  let eligible: number[] = [];
  for (const discount of discounts) {
    const indexes = lines
      .map((line, index) =>
        discount.productIds.length === 0 || discount.productIds.includes(line.productId)
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    const amount = safe(indexes.reduce((sum, index) => sum + integer(bases[index]!), 0n));
    const qty = indexes.reduce((sum, index) => sum + lines[index]!.quantity, 0);
    if (amount < discount.minPurchaseMinor || qty < discount.minQuantity) continue;
    const reduction = Math.min(
      amount,
      discount.kind === 'fixed' ? discount.value : roundRatio(amount, discount.value, 10000),
    );
    if (reduction > chosenAmount) {
      chosen = discount;
      chosenAmount = reduction;
      eligible = indexes;
    }
  }
  // Largest remainder allocation preserves the exact invoice-wide discount in paise.
  const shares = bases.map(() => 0);
  const eligibleBase = eligible.reduce((sum, index) => sum + BigInt(bases[index]!), 0n);
  if (chosen && eligibleBase > 0n) {
    const remainders = eligible.map((index) => {
      const product = BigInt(chosenAmount) * BigInt(bases[index]!);
      shares[index] = Number(product / eligibleBase);
      return { index, remainder: product % eligibleBase };
    });
    let left = chosenAmount - shares.reduce((a, b) => a + b, 0);
    remainders.sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
    for (const remainder of remainders) {
      if (left-- <= 0) break;
      shares[remainder.index]!++;
    }
  }
  const priced = lines.map((line, index) => {
    const baseMinor = bases[index]!;
    const discountMinor = shares[index]!;
    const appliedTaxes = taxes
      .filter((tax) => !tax.productIds.length || tax.productIds.includes(line.productId))
      .map((tax) => ({
        taxId: tax.id,
        name: tax.name,
        rateBps: tax.rateBps,
        amountMinor: roundRatio(baseMinor - discountMinor, tax.rateBps, 10000),
      }));
    const taxMinor = safe(appliedTaxes.reduce((sum, tax) => sum + BigInt(tax.amountMinor), 0n));
    return {
      ...line,
      baseMinor,
      discountMinor,
      taxMinor,
      totalMinor: safe(BigInt(baseMinor) - BigInt(discountMinor) + BigInt(taxMinor)),
      taxes: appliedTaxes,
      discounts:
        chosen && discountMinor
          ? [{ discountId: chosen.id, name: chosen.name, amountMinor: discountMinor }]
          : [],
    };
  });
  const taxMinor = safe(priced.reduce((sum, line) => sum + BigInt(line.taxMinor), 0n));
  return {
    lines: priced,
    subtotalMinor,
    discountMinor: chosenAmount,
    taxMinor,
    totalMinor: safe(BigInt(subtotalMinor) - BigInt(chosenAmount) + BigInt(taxMinor)),
    discountId: chosen?.id,
  };
}
export function outstanding(invoice: {
  totalMinor: number;
  paidMinor?: number;
  creditedMinor?: number;
}) {
  return Math.max(0, invoice.totalMinor - (invoice.paidMinor ?? 0) - (invoice.creditedMinor ?? 0));
}
export function recurringRevenue(rows: { amountMinor: number; frequency: string }[]) {
  const factors: Record<string, bigint> = { daily: 365n, weekly: 52n, monthly: 12n, yearly: 1n };
  const annual = rows.reduce((sum, row) => {
    const factor = factors[row.frequency];
    if (!factor) throw new Error('Unknown billing frequency');
    return sum + integer(row.amountMinor) * factor;
  }, 0n);
  return { mrrMinor: safe((annual + 6n) / 12n), arrMinor: safe(annual) };
}
