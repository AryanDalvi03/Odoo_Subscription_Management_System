import type { Field, Option } from '../components/ResourceForm';
import type { Row } from '../lib/api';
export type Lookup = Record<string, Row[]>;
export const options = (lookup: Lookup, key: string): Option[] =>
  (lookup[key] ?? []).map((row) => ({
    value: row._id,
    label: String(row.name ?? row.number ?? row.email ?? row._id),
  }));
export function resourceFields(resource: string, lookup: Lookup): Field[] {
  const pick = (name: string, label: string, key: string, required = true): Field => ({
    name,
    label,
    type: 'select',
    options: options(lookup, key),
    required,
  });
  const name: Field = { name: 'name', label: 'Name', required: true };
  const description: Field = { name: 'description', label: 'Description', type: 'textarea' };
  switch (resource) {
    case 'products':
      return [
        name,
        { name: 'type', label: 'Product type', initial: 'software', required: true },
        description,
        { name: 'salesPriceMinor', label: 'Sales price (INR)', type: 'money', required: true },
        { name: 'costPriceMinor', label: 'Cost price (INR)', type: 'money', required: true },
        { name: 'notes', label: 'Internal notes', type: 'textarea' },
      ];
    case 'plans':
      return [
        name,
        description,
        {
          name: 'frequency',
          label: 'Billing frequency',
          type: 'select',
          options: ['daily', 'weekly', 'monthly', 'yearly'].map((value) => ({
            value,
            label: value[0]!.toUpperCase() + value.slice(1),
          })),
          initial: 'monthly',
          required: true,
        },
        {
          name: 'minQuantity',
          label: 'Minimum quantity',
          type: 'number',
          initial: 1,
          required: true,
        },
        {
          name: 'products',
          label: 'Included products and unit prices',
          type: 'products',
          options: options(lookup, 'products'),
          initial: [],
          required: true,
        },
        { name: 'availableFrom', label: 'Available from', type: 'date' },
        { name: 'availableUntil', label: 'Available until', type: 'date' },
        { name: 'allowPause', label: 'Allow pause and resume', type: 'checkbox' },
        { name: 'allowEarlyClosure', label: 'Allow early closure', type: 'checkbox' },
        { name: 'allowRenewal', label: 'Allow renewal', type: 'checkbox', initial: true },
        { name: 'autoClose', label: 'Close automatically at expiry', type: 'checkbox' },
      ];
    case 'customers':
      return [
        name,
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'company', label: 'Company' },
        { name: 'phone', label: 'Phone' },
        { name: 'address', label: 'Billing address', type: 'textarea' },
        { name: 'taxId', label: 'Tax identifier' },
      ];
    case 'quotations':
      return [
        pick('customerId', 'Customer', 'customers'),
        pick('planId', 'Plan', 'plans', false),
        pick('templateId', 'Quotation template', 'quotation-templates', false),
        { name: 'quantity', label: 'Quantity', type: 'number', initial: 1, required: true },
        {
          name: 'expiryAt',
          label: 'Quotation expiry',
          type: 'date',
          initial: new Date(Date.now() + 7 * 86400_000).toISOString(),
          required: true,
        },
        { name: 'terms', label: 'Terms and conditions', type: 'textarea' },
      ];
    case 'quotation-templates':
      return [
        name,
        pick('planId', 'Plan', 'plans'),
        { name: 'quantity', label: 'Default quantity', type: 'number', initial: 1 },
        { name: 'terms', label: 'Terms and conditions', type: 'textarea' },
      ];
    case 'subscriptions':
      return [
        pick('customerId', 'Customer', 'customers'),
        pick('planId', 'Plan', 'plans'),
        { name: 'quantity', label: 'Quantity', type: 'number', initial: 1, required: true },
        { name: 'startAt', label: 'Start date', type: 'date', initial: new Date().toISOString() },
        { name: 'expiryAt', label: 'Expiry date', type: 'date' },
        { name: 'paymentTermsDays', label: 'Payment terms (days)', type: 'number', initial: 7 },
        { name: 'billingTimezone', label: 'Billing timezone', initial: 'Asia/Kolkata' },
      ];
    case 'taxes':
      return [
        name,
        { name: 'rateBps', label: 'Tax percentage', type: 'money', required: true },
        {
          name: 'productIds',
          label: 'Applicable products',
          type: 'multi',
          options: options(lookup, 'products'),
          help: 'Leave empty to apply to all products.',
        },
        {
          name: 'effectiveFrom',
          label: 'Effective from',
          type: 'date',
          initial: new Date().toISOString(),
          required: true,
        },
        { name: 'effectiveUntil', label: 'Effective until', type: 'date' },
        { name: 'active', label: 'Active', type: 'checkbox', initial: true },
      ];
    case 'discounts':
      return [
        name,
        {
          name: 'kind',
          label: 'Discount type',
          type: 'select',
          initial: 'percentage',
          options: [
            { value: 'percentage', label: 'Percentage' },
            { value: 'fixed', label: 'Fixed amount' },
          ],
          required: true,
        },
        {
          name: 'value',
          label: 'Discount value (INR for fixed, % for percentage)',
          type: 'money',
          required: true,
        },
        { name: 'minPurchaseMinor', label: 'Minimum purchase (INR)', type: 'money', initial: '0' },
        { name: 'minQuantity', label: 'Minimum quantity', type: 'number', initial: 1 },
        {
          name: 'scope',
          label: 'Discount scope',
          type: 'select',
          initial: 'subscription',
          options: [
            { value: 'subscription', label: 'Entire subscription' },
            { value: 'product', label: 'Selected products' },
          ],
        },
        {
          name: 'productIds',
          label: 'Applicable products',
          type: 'multi',
          options: options(lookup, 'products'),
        },
        {
          name: 'startAt',
          label: 'Starts',
          type: 'date',
          initial: new Date().toISOString(),
          required: true,
        },
        {
          name: 'endAt',
          label: 'Ends',
          type: 'date',
          initial: new Date(Date.now() + 30 * 86400_000).toISOString(),
          required: true,
        },
        { name: 'maxRedemptions', label: 'Maximum redemptions', type: 'number' },
        { name: 'active', label: 'Active', type: 'checkbox', initial: true },
      ];
    case 'payments':
      return [
        pick('invoiceId', 'Invoice', 'invoices'),
        { name: 'amountMinor', label: 'Payment amount (INR)', type: 'money', required: true },
        {
          name: 'method',
          label: 'Method',
          type: 'select',
          initial: 'bank_transfer',
          options: ['bank_transfer', 'cash', 'upi', 'card', 'other'].map((value) => ({
            value,
            label: value.replace('_', ' '),
          })),
        },
        { name: 'reference', label: 'Transaction reference', required: true },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ];
    case 'staff':
      return [
        name,
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'password', label: 'Initial password', type: 'password', required: true },
        {
          name: 'permissions',
          label: 'Permissions',
          type: 'multi',
          options: [
            'customers:read',
            'customers:write',
            'quotations:write',
            'subscriptions:write',
            'invoices:write',
            'payments:write',
            'reports:read',
            'taxes:read',
            'discounts:read',
          ].map((value) => ({ value, label: value.replace(':', ' · ') })),
        },
      ];
    default:
      return [];
  }
}
