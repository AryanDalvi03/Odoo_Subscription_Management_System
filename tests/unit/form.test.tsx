/** @jest-environment jsdom */
import { test, expect, jest } from '@jest/globals';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ResourceForm } from '../../apps/web/src/components/ResourceForm.js';
test('currency entry submits exact paise and reports invalid precision accessibly', async () => {
  const submit = jest
    .fn<(data: Record<string, unknown>) => Promise<void>>()
    .mockResolvedValue(undefined);
  const view = render(
    <ResourceForm
      fields={[
        { name: 'amountMinor', label: 'Payment amount (INR)', type: 'money', required: true },
      ]}
      onSubmit={submit}
    />,
  );
  fireEvent.change(screen.getByLabelText('Payment amount (INR)'), { target: { value: '1000.15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith({ amountMinor: 100015 }));
  view.unmount();
  const invalid = jest
    .fn<(data: Record<string, unknown>) => Promise<void>>()
    .mockResolvedValue(undefined);
  render(
    <ResourceForm
      fields={[
        { name: 'amountMinor', label: 'Payment amount (INR)', type: 'money', required: true },
      ]}
      onSubmit={invalid}
    />,
  );
  fireEvent.change(screen.getByLabelText('Payment amount (INR)'), { target: { value: '1.234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toContain('two decimal places'),
  );
  expect(invalid).not.toHaveBeenCalled();
  cleanup();
});
