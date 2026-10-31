import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Plus, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { Button } from './ui/button';
import { errorMessage } from '../lib/errors';
import type { Row } from '../lib/types';
export type Option = { value: string; label: string };
export type Field = {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'email'
    | 'password'
    | 'money'
    | 'number'
    | 'textarea'
    | 'checkbox'
    | 'select'
    | 'multi'
    | 'date'
    | 'products';
  options?: Option[];
  required?: boolean;
  initial?: unknown;
  help?: string;
};
export function decimalMinor(input: unknown) {
  const value = String(input ?? '0').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error('Enter a positive amount with up to two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (amount > 1_000_000_000n) throw new Error('Amount exceeds the supported limit');
  return Number(amount);
}
export function ResourceForm({
  fields,
  initial,
  onSubmit,
  submitLabel = 'Save',
}: {
  fields: Field[];
  initial?: Row;
  onSubmit: (data: Record<string, unknown>) => Promise<void>;
  submitLabel?: string;
}) {
  const defaults = Object.fromEntries(
    fields.map((field) => {
      let value =
        initial?.[field.name] ??
        field.initial ??
        (field.type === 'checkbox' ? false : field.type === 'multi' ? [] : '');
      if (field.type === 'money' && initial?.[field.name] !== undefined)
        value = (Number(value) / 100).toFixed(2);
      if (field.type === 'products' && Array.isArray(value))
        value = value.map((line) => ({
          productId: line.productId,
          price: (Number(line.unitPriceMinor) / 100).toFixed(2),
        }));
      if (field.type === 'date' && value) {
        const date = new Date(String(value));
        value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 16);
      }
      return [field.name, value];
    }),
  );
  const {
    register,
    control,
    handleSubmit,
    formState: { isSubmitting, errors },
  } = useForm<Record<string, unknown>>({ defaultValues: defaults });
  const [error, setError] = useState('');
  const submit = handleSubmit(async (values) => {
    setError('');
    try {
      const data: Record<string, unknown> = {};
      for (const field of fields) {
        const value = values[field.name];
        if (value === '' || value === undefined) {
          if (field.required) throw new Error(`${field.label} is required`);
          continue;
        }
        data[field.name] =
          field.type === 'money'
            ? decimalMinor(value)
            : field.type === 'number'
              ? z.coerce.number().int().nonnegative().parse(value)
              : field.type === 'date'
                ? new Date(String(value)).toISOString()
                : field.type === 'products'
                  ? (value as { productId: string; price: string }[]).map((line) => ({
                      productId: line.productId,
                      unitPriceMinor: decimalMinor(line.price),
                    }))
                  : value;
      }
      await onSubmit(data);
    } catch (error) {
      setError(errorMessage(error));
    }
  });
  return (
    <form className="resource-form" onSubmit={submit}>
      {fields.map((field) => (
        <div
          className={
            'field ' + (field.type === 'textarea' || field.type === 'products' ? 'full' : '')
          }
          key={field.name}
        >
          <label htmlFor={`field-${field.name}`}>
            {field.label}
            {field.required && <span aria-hidden="true"> *</span>}
          </label>
          {field.type === 'products' ? (
            <Controller
              name={field.name}
              control={control}
              render={({ field: input }) => (
                <ProductLines
                  options={field.options ?? []}
                  value={Array.isArray(input.value) ? input.value : []}
                  onChange={input.onChange}
                />
              )}
            />
          ) : field.type === 'textarea' ? (
            <textarea
              aria-label={field.label}
              id={`field-${field.name}`}
              {...register(field.name, { required: field.required })}
              rows={3}
            />
          ) : field.type === 'select' || field.type === 'multi' ? (
            <select
              aria-label={field.label}
              id={`field-${field.name}`}
              multiple={field.type === 'multi'}
              {...register(field.name, { required: field.required })}
            >
              <option value="" disabled={field.type === 'multi'}>
                {field.type === 'multi' ? 'Select applicable items' : 'Choose…'}
              </option>
              {field.options?.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={field.label}
              id={`field-${field.name}`}
              type={
                field.type === 'checkbox'
                  ? 'checkbox'
                  : field.type === 'date'
                    ? 'datetime-local'
                    : field.type === 'money'
                      ? 'text'
                      : (field.type ?? 'text')
              }
              inputMode={field.type === 'money' ? 'decimal' : undefined}
              {...register(field.name, { required: field.required })}
            />
          )}
          {field.help && <small>{field.help}</small>}
          {errors[field.name] && <small role="alert">Please complete this field.</small>}
        </div>
      ))}
      {error && (
        <div className="error full" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions full">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
function ProductLines({
  value,
  onChange,
  options,
}: {
  value: { productId: string; price: string }[];
  onChange: (value: { productId: string; price: string }[]) => void;
  options: Option[];
}) {
  return (
    <div className="product-lines">
      {value.map((line, index) => (
        <div className="product-line" key={index}>
          <select
            aria-label={`Product ${index + 1}`}
            value={line.productId}
            onChange={(event) =>
              onChange(
                value.map((item, i) =>
                  i === index ? { ...item, productId: event.target.value } : item,
                ),
              )
            }
            required
          >
            <option value="">Choose product</option>
            {options.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            aria-label={`Unit price ${index + 1} in INR`}
            placeholder="Unit price (INR)"
            inputMode="decimal"
            value={line.price}
            required
            onChange={(event) =>
              onChange(
                value.map((item, i) =>
                  i === index ? { ...item, price: event.target.value } : item,
                ),
              )
            }
          />
          <button
            type="button"
            aria-label={`Remove product ${index + 1}`}
            onClick={() => onChange(value.filter((_item, i) => i !== index))}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        onClick={() => onChange([...value, { productId: '', price: '' }])}
      >
        <Plus size={15} />
        Add product line
      </Button>
    </div>
  );
}
