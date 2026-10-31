import { useDeferredValue, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSelector } from 'react-redux';
import {
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Eye,
  Download,
  Pencil,
  Archive,
  MoreHorizontal,
  Zap,
  Printer,
} from 'lucide-react';
import { toast } from 'sonner';
import type { RootState } from '../app/store';
import { resourceFields, options, type Lookup } from '../app/resources';
import { ResourceForm, type Field } from '../components/ResourceForm';
import { Button } from '../components/ui/button';
import { Modal } from '../components/Modal';
import { api, command, download, errorMessage, money, type Row, type ListResult } from '../lib/api';
type Action = {
  title: string;
  path: string;
  fields: Field[];
  initial?: Row;
  method?: 'post' | 'patch' | 'delete';
  version?: number;
  perform?: (data: Record<string, unknown>) => Promise<void>;
};
const titles: Record<string, string> = {
  customers: 'Customers',
  products: 'Products',
  plans: 'Subscription plans',
  quotations: 'Quotations',
  subscriptions: 'Subscriptions',
  invoices: 'Invoices',
  payments: 'Payments',
  discounts: 'Discount rules',
  taxes: 'Tax configuration',
  staff: 'Staff management',
  'quotation-templates': 'Quotation templates',
  'change-requests': 'Change requests',
  'audit-logs': 'Audit trail',
  notifications: 'Email delivery',
  'billing-records': 'Billing records',
  'jobs/failed': 'Failed jobs',
};
const statuses: Record<string, string[]> = {
  products: ['active', 'archived'],
  plans: ['active', 'inactive', 'archived'],
  quotations: ['draft', 'sent', 'accepted', 'rejected', 'expired'],
  subscriptions: ['draft', 'quotation', 'confirmed', 'active', 'paused', 'cancelled', 'closed'],
  invoices: ['draft', 'confirmed', 'cancelled', 'overdue'],
  payments: ['captured', 'failed'],
  notifications: ['pending', 'sent', 'failed'],
};
function displayDate(value: unknown) {
  return value
    ? new Date(String(value)).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '—';
}
export function ResourcePage({ resource }: { resource: string }) {
  const user = useSelector((state: RootState) => state.session.user)!;
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState<Row | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [edit, setEdit] = useState<Row | null>(null);
  const search = useDeferredValue(params.get('q') ?? '');
  const page = Math.max(1, Number(params.get('page') ?? 1));
  const status = params.get('status') ?? '';
  const listing = useQuery({
    queryKey: ['resources', resource, page, search, status],
    queryFn: async () => {
      const response = await api.get<ListResult>(`/${resource}`, {
        params:
          resource === 'jobs/failed'
            ? {}
            : {
                page,
                pageSize: 20,
                ...(search ? { q: search } : {}),
                ...(status ? { status } : {}),
              },
      });
      return response.data;
    },
    refetchInterval: ['subscriptions', 'invoices', 'notifications', 'jobs/failed'].includes(
      resource,
    )
      ? 15000
      : false,
  });
  const lookup = useQuery({
    queryKey: ['lookups', user.id],
    queryFn: async () => {
      const names = ['products', 'plans', 'customers', 'quotation-templates', 'invoices'];
      const results = await Promise.allSettled(
        names.map((name) => api.get<ListResult>(`/${name}`, { params: { pageSize: 100 } })),
      );
      return Object.fromEntries(
        results.map((result, index) => [
          names[index]!,
          result.status === 'fulfilled' ? result.value.data.data : [],
        ]),
      ) as Lookup;
    },
    staleTime: 30000,
  });
  const lists = lookup.data ?? {};
  const fields = resourceFields(resource, lists);
  const canCreate =
    fields.length > 0 &&
    (user.role === 'admin' ||
      (user.role === 'staff' &&
        ['customers', 'quotations', 'subscriptions', 'payments'].includes(resource)));
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['resources'] });
    await queryClient.invalidateQueries({ queryKey: ['lookups'] });
    await queryClient.invalidateQueries({ queryKey: ['analytics'] });
  };
  const act = (row: Row, operation: string, extraFields: Field[] = []) =>
    setAction({
      title: `${operation[0]!.toUpperCase() + operation.slice(1).replaceAll('-', ' ')} ${String(row.number ?? row.name ?? 'record')}`,
      path: `/${resource}/${row._id}/${operation}`,
      fields: extraFields,
    });
  const reason: Field = { name: 'reason', label: 'Reason', type: 'textarea', required: true };
  const rowActions = (row: Row) => {
    const status = String(row.status ?? '');
    const buttons: { label: string; run: () => void }[] = [];
    if (resource === 'quotations') {
      if (status === 'draft' && user.role !== 'customer')
        buttons.push({ label: 'Send quote', run: () => act(row, 'send') });
      if (status === 'sent') {
        buttons.push(
          { label: 'Accept', run: () => act(row, 'accept') },
          { label: 'Reject', run: () => act(row, 'reject') },
        );
      }
      if (status === 'accepted')
        buttons.push({ label: 'Convert to subscription', run: () => act(row, 'convert') });
    }
    if (resource === 'subscriptions') {
      if (user.role !== 'customer' && status === 'draft')
        buttons.push({ label: 'Confirm', run: () => act(row, 'confirm') });
      if (status === 'confirmed')
        buttons.push({ label: 'Activate', run: () => act(row, 'activate') });
      const policy = row.planSnapshot as
        { allowPause?: boolean; allowRenewal?: boolean; allowEarlyClosure?: boolean } | undefined;
      if (status === 'active' && policy?.allowPause && !row.pauseAt)
        buttons.push({ label: 'Pause', run: () => act(row, 'pause', [reason]) });
      if (status === 'paused' || row.pauseAt)
        buttons.push({ label: 'Resume', run: () => act(row, 'resume', [reason]) });
      if (user.role === 'customer' && ['active', 'paused', 'confirmed'].includes(status))
        buttons.push({
          label: 'Request change',
          run: () =>
            setAction({
              title: 'Request a subscription change',
              path: `/subscriptions/${row._id}/change-requests`,
              fields: [
                {
                  name: 'kind',
                  label: 'Request type',
                  type: 'select',
                  required: true,
                  options: [
                    { value: 'cancel', label: 'Cancel at period end' },
                    { value: 'upgrade', label: 'Upgrade plan' },
                    { value: 'downgrade', label: 'Downgrade plan' },
                  ],
                },
                {
                  name: 'planId',
                  label: 'Target plan (for upgrades/downgrades)',
                  type: 'select',
                  options: options(lists, 'plans'),
                },
                reason,
              ],
            }),
        });
      if (user.role !== 'customer' && ['active', 'paused', 'confirmed'].includes(status))
        buttons.push({ label: 'Cancel', run: () => act(row, 'cancel', [reason]) });
      if (user.role !== 'customer' && status === 'active')
        buttons.push(
          {
            label: 'Change plan',
            run: () =>
              setAction({
                title: 'Change subscription plan at next billing',
                path: `/subscriptions/${row._id}/upgrade`,
                fields: [
                  {
                    name: 'planId',
                    label: 'Target plan',
                    type: 'select',
                    options: options(lists, 'plans'),
                    required: true,
                  },
                  reason,
                ],
              }),
          },
          {
            label: 'Downgrade',
            run: () =>
              act(row, 'downgrade', [
                {
                  name: 'planId',
                  label: 'Target plan',
                  type: 'select',
                  options: options(lists, 'plans'),
                  required: true,
                },
                reason,
              ]),
          },
        );
      if (
        user.role !== 'customer' &&
        policy?.allowEarlyClosure &&
        ['active', 'paused'].includes(status)
      )
        buttons.push({ label: 'Close early', run: () => act(row, 'close', [reason]) });
      if (
        policy?.allowRenewal &&
        (['closed', 'cancelled'].includes(status) ||
          (status === 'paused' &&
            Boolean(row.expiryAt && new Date(String(row.expiryAt)) <= new Date())))
      )
        buttons.push({ label: 'Renew', run: () => act(row, 'renew', [reason]) });
      if (user.role !== 'customer' && status === 'active')
        buttons.push({
          label: 'Generate due invoice',
          run: () =>
            setAction({
              title: 'Generate the due invoice',
              path: `/subscriptions/${row._id}/invoices`,
              fields: [],
            }),
        });
    }
    if (resource === 'subscriptions' && status === 'active' && user.role !== 'customer')
      buttons.push({
        label: 'Preview draft invoice',
        run: () =>
          setAction({
            title: 'Preview the upcoming invoice',
            path: `/subscriptions/${row._id}/invoices`,
            fields: [],
            perform: async () => {
              await command(`/subscriptions/${row._id}/invoices`, { draft: true });
            },
          }),
      });
    if (resource === 'invoices' && status === 'draft' && user.role !== 'customer')
      buttons.push(
        { label: 'Confirm invoice', run: () => act(row, 'confirm') },
        { label: 'Cancel draft', run: () => act(row, 'cancel', [reason]) },
      );
    if (resource === 'invoices') {
      buttons.push({
        label: 'Download PDF',
        run: () => {
          void download(`/invoices/${row._id}/pdf`, `${row.number}.pdf`).catch((error) =>
            toast.error(errorMessage(error)),
          );
        },
      });
      if (status === 'confirmed' && Number(row.outstandingMinor) > 0) {
        buttons.push({
          label: '⚡ Pay via UPI',
          run: () => {
            setAction({
              title: `Instant UPI Pay: ${row.number}`,
              path: '/payments',
              initial: {
                _id: '',
                upiId: user.email ? `${user.email.split('@')[0]}@upi` : 'abhishek@upi',
                amountMinor: row.outstandingMinor,
              },
              fields: [
                {
                  name: 'upiId',
                  label: 'UPI ID / VPA',
                  type: 'text',
                  required: true,
                  help: 'Click Confirm to automatically process and settle this invoice via UPI.',
                },
                {
                  name: 'amountMinor',
                  label: 'Payment amount (INR)',
                  type: 'money',
                  required: true,
                },
              ],
              perform: async (data) => {
                await command('/payments', {
                  invoiceId: row._id,
                  amountMinor: Number(data.amountMinor),
                  method: 'upi',
                  reference: String(data.upiId || `UPI-${Date.now()}`),
                  notes: 'Instant UPI Payment auto-processed by customer',
                });
                toast.success(`UPI Payment of ${money(data.amountMinor)} processed successfully!`);
                void queryClient.invalidateQueries({ queryKey: ['resources', resource] });
                void queryClient.invalidateQueries({ queryKey: ['analytics'] });
              },
            });
          },
        });
        buttons.push({
          label: 'Pay online (Razorpay)',
          run: () => {
            setAction({
              title: `Pay ${row.number} via Razorpay`,
              path: '/payments/create-order',
              initial: { _id: '', amountMinor: row.outstandingMinor },
              fields: [
                {
                  name: 'amountMinor',
                  label: 'Payment amount (INR)',
                  type: 'money',
                  required: true,
                },
              ],
              perform: async (data) => {
                await payInvoice({ ...row, outstandingMinor: data.amountMinor });
              },
            });
          },
        });
        if (user.role !== 'customer')
          buttons.push({
            label: 'Record payment',
            run: () =>
              setAction({
                title: 'Record a manual payment',
                path: '/payments',
                fields: resourceFields('payments', lists),
                initial: { _id: '', invoiceId: row._id, amountMinor: row.outstandingMinor },
              }),
          });
        if (user.role === 'admin')
          buttons.push({
            label: 'Credit adjustment',
            run: () =>
              setAction({
                title: 'Issue a credit note',
                path: `/invoices/${row._id}/credit-notes`,
                fields: [
                  {
                    name: 'amountMinor',
                    label: 'Credit amount (INR)',
                    type: 'money',
                    required: true,
                  },
                  reason,
                ],
              }),
          });
      }
      if (user.role !== 'customer' && status === 'confirmed') {
        buttons.push({ label: 'Send invoice', run: () => act(row, 'send') });
        if (!Number(row.paidMinor) && !Number(row.creditedMinor))
          buttons.push({ label: 'Cancel invoice', run: () => act(row, 'cancel', [reason]) });
      }
    }
    if (resource === 'staff')
      buttons.push({
        label: 'Edit permissions',
        run: () =>
          setAction({
            title: 'Update staff permissions',
            path: `/staff/${row._id}`,
            method: 'patch',
            initial: row,
            fields: [
              { name: 'name', label: 'Name', required: true },
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
                ].map((value) => ({ value, label: value })),
              },
              { name: 'active', label: 'Account active', type: 'checkbox' },
            ],
          }),
      });
    if (resource === 'plans' && user.role === 'admin' && status !== 'archived')
      buttons.push({
        label: status === 'active' ? 'Deactivate' : 'Activate',
        run: () => act(row, status === 'active' ? 'deactivate' : 'activate'),
      });
    if (resource === 'quotations' && status === 'draft' && user.role !== 'customer')
      buttons.push({
        label: 'Edit terms & expiry',
        run: () =>
          setAction({
            title: 'Edit draft quotation',
            path: `/quotations/${row._id}`,
            method: 'patch',
            initial: row,
            fields: [
              { name: 'expiryAt', label: 'Expiry date', type: 'date', required: true },
              { name: 'terms', label: 'Terms and conditions', type: 'textarea' },
            ],
          }),
      });
    if (resource === 'subscriptions')
      buttons.push({
        label: 'View lifecycle history',
        run: () => {
          void api
            .get(`/subscriptions/${row._id}/history`)
            .then((response) => setDetail({ ...row, events: response.data.data }))
            .catch((error) => toast.error(errorMessage(error)));
        },
      });
    if (resource === 'invoices')
      buttons.push({
        label: 'View payment history',
        run: () => {
          void api
            .get(`/invoices/${row._id}/history`)
            .then((response) => setDetail({ ...row, history: response.data.data }))
            .catch((error) => toast.error(errorMessage(error)));
        },
      });
    if (resource === 'invoices')
      buttons.push({
        label: 'Print invoice',
        run: () => {
          void printInvoice(row).catch((error) => toast.error(errorMessage(error)));
        },
      });
    if (resource === 'products' && user.role === 'admin')
      buttons.push(
        {
          label: 'Add variant',
          run: () =>
            setAction({
              title: `Add variant to ${row.name}`,
              path: `/products/${row._id}/variants`,
              fields: [
                { name: 'name', label: 'Variant name', required: true },
                {
                  name: 'additionalPriceMinor',
                  label: 'Additional unit price (INR)',
                  type: 'money',
                  required: true,
                },
              ],
            }),
        },
        {
          label: 'View variants',
          run: () => {
            void api
              .get(`/products/${row._id}/variants`)
              .then((response) => setDetail({ ...row, variants: response.data.data }))
              .catch((error) => toast.error(errorMessage(error)));
          },
        },
      );
    if (resource === 'customers' && user.role === 'admin')
      buttons.push({
        label: 'Assign staff',
        run: () => {
          void api
            .get('/staff')
            .then((response) =>
              setAction({
                title: `Assign ${row.name}`,
                path: `/customers/${row._id}/assignments`,
                method: 'patch',
                fields: [
                  {
                    name: 'assignedStaffIds',
                    label: 'Assigned staff',
                    type: 'multi',
                    options: response.data.data.map((staff: Row) => ({
                      value: staff._id,
                      label: staff.name,
                    })),
                  },
                ],
              }),
            )
            .catch((error) => toast.error(errorMessage(error)));
        },
      });
    if (resource === 'change-requests' && user.role !== 'customer' && status === 'pending')
      buttons.push(
        { label: 'Approve', run: () => act(row, 'approve') },
        { label: 'Reject', run: () => act(row, 'reject') },
      );
    if (resource === 'notifications' && status === 'failed')
      buttons.push({ label: 'Retry delivery', run: () => act(row, 'retry') });
    if (resource === 'jobs/failed')
      buttons.push({
        label: 'Retry job',
        run: () =>
          setAction({
            title: 'Retry failed job',
            path: `/jobs/${row.queue}/${row.id}/retry`,
            fields: [],
          }),
      });
    return buttons;
  };
  return (
    <section className="sq-page">
      <div className="sq-page-heading">
        <div>
          <span className="eyebrow">{user.role === 'customer' ? 'YOUR ACCOUNT' : 'WORKSPACE'}</span>
          <h1>{titles[resource] ?? resource}</h1>
          <p>
            {resource === 'invoices'
              ? 'Every invoice, payment and outstanding balance in one place.'
              : resource === 'plans'
                ? 'Flexible recurring plans with clear pricing and permissions.'
                : 'Manage records with a complete, connected history.'}
          </p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreate(true)}>
            <Plus size={16} />
            {resource === 'payments'
              ? 'Record payment'
              : `New ${resource === 'staff' ? 'staff member' : resource.replace(/s$/, '').replaceAll('-', ' ')}`}
          </Button>
        )}
      </div>
      <div className="sq-toolbar">
        <label className="sq-search">
          <Search size={16} />
          <input
            placeholder="Search records…"
            aria-label="Search records"
            value={params.get('q') ?? ''}
            onChange={(event) =>
              setParams({ ...Object.fromEntries(params), q: event.target.value, page: '1' })
            }
          />
        </label>
        {statuses[resource] && (
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) =>
              setParams({ ...Object.fromEntries(params), status: event.target.value, page: '1' })
            }
          >
            <option value="">All statuses</option>
            {statuses[resource]!.map((status) => (
              <option value={status} key={status}>
                {status[0]!.toUpperCase() + status.slice(1)}
              </option>
            ))}
          </select>
        )}
        <span>{listing.data?.meta?.total ?? listing.data?.data.length ?? 0} records</span>
      </div>
      {listing.isPending ? (
        <div className="sq-skeleton" role="status">
          Loading records…
        </div>
      ) : listing.isError ? (
        <div className="error" role="alert">
          {errorMessage(listing.error)}{' '}
          <button
            onClick={() => {
              void listing.refetch();
            }}
          >
            Retry
          </button>
        </div>
      ) : listing.data?.data.length === 0 ? (
        <div className="sq-empty">
          <div className="sq-empty-icon">
            <Plus size={24} />
          </div>
          <h2>No records yet</h2>
          <p>
            {search || status
              ? 'Try changing your filters.'
              : 'Records will appear here as you work through the subscription lifecycle.'}
          </p>
          {canCreate && <Button onClick={() => setCreate(true)}>Create the first record</Button>}
        </div>
      ) : (
        <div className="sq-table-wrap">
          <table className="sq-table">
            <thead>
              <tr>
                <th>Record</th>
                <th>Details</th>
                <th>Amount / value</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listing.data?.data.map((row, index) => (
                <tr key={row._id ?? String(row.id ?? index)}>
                  <td>
                    <strong>
                      {String(
                        row.name ??
                          row.number ??
                          row.subject ??
                          row.action ??
                          row.cycleKey ??
                          row.id ??
                          row._id,
                      )}
                    </strong>
                    <small>{String(row.email ?? row.method ?? row.resourceType ?? '')}</small>
                  </td>
                  <td>
                    {String(
                      row.frequency ??
                        row.kind ??
                        row.role ??
                        row.provider ??
                        row.type ??
                        row.queue ??
                        row.recipient ??
                        '—',
                    )}
                  </td>
                  <td>
                    {row.totalMinor !== undefined
                      ? money(row.totalMinor)
                      : row.amountMinor !== undefined
                        ? money(row.amountMinor)
                        : row.salesPriceMinor !== undefined
                          ? money(row.salesPriceMinor)
                          : row.rateBps !== undefined
                            ? `${Number(row.rateBps) / 100}%`
                            : '—'}
                    {row.outstandingMinor !== undefined && (
                      <small>Due {money(row.outstandingMinor)}</small>
                    )}
                  </td>
                  <td>
                    <span
                      className={`sq-badge ${String(row.paymentStatus ?? row.status ?? (row.active === false ? 'inactive' : 'active'))}`}
                    >
                      {String(
                        row.paymentStatus ??
                          row.status ??
                          (row.active === false ? 'inactive' : 'active'),
                      )}
                    </span>
                    {Boolean(row.pauseAt) && <small>Pause scheduled</small>}
                    {Boolean(row.cancelAt) && <small>Cancellation scheduled</small>}
                  </td>
                  <td>{displayDate(row.createdAt ?? row.timestamp)}</td>
                  <td>
                    <div className="sq-row-actions">
                      <button
                        aria-label={`View ${row.name ?? row.number ?? 'record'}`}
                        title="View details"
                        onClick={() => setDetail(row)}
                      >
                        <Eye size={16} />
                      </button>
                      {user.role === 'admin' &&
                        [
                          'products',
                          'plans',
                          'taxes',
                          'discounts',
                          'quotation-templates',
                          'customers',
                        ].includes(resource) && (
                          <button
                            aria-label={`Edit ${row.name}`}
                            title="Edit"
                            onClick={() => setEdit(row)}
                          >
                            <Pencil size={15} />
                          </button>
                        )}
                      {user.role === 'admin' &&
                        ['products', 'plans', 'taxes', 'discounts', 'quotation-templates'].includes(
                          resource,
                        ) && (
                          <button
                            aria-label={`Archive ${row.name}`}
                            title="Archive"
                            onClick={() =>
                              setAction({
                                title: `Archive ${row.name}`,
                                path: `/${resource}/${row._id}`,
                                method: 'delete',
                                fields: [],
                              })
                            }
                          >
                            <Archive size={15} />
                          </button>
                        )}
                      <details className="sq-action-menu">
                        <summary aria-label="More actions">
                          <MoreHorizontal size={18} />
                        </summary>
                        <div>
                          {rowActions(row).length ? (
                            rowActions(row).map((button) => (
                              <button
                                key={button.label}
                                onClick={(event) => {
                                  event.currentTarget.closest('details')?.removeAttribute('open');
                                  button.run();
                                }}
                              >
                                {button.label}
                              </button>
                            ))
                          ) : (
                            <span>No additional actions</span>
                          )}
                        </div>
                      </details>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sq-pagination">
        <span>Page {page}</span>
        <Button
          variant="outline"
          disabled={page === 1}
          onClick={() => setParams({ ...Object.fromEntries(params), page: String(page - 1) })}
        >
          <ChevronLeft size={14} />
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={page * 20 >= (listing.data?.meta?.total ?? listing.data?.data.length ?? 0)}
          onClick={() => setParams({ ...Object.fromEntries(params), page: String(page + 1) })}
        >
          Next
          <ChevronRight size={14} />
        </Button>
      </div>
      {(create || edit) && (
        <Modal
          title={edit ? `Edit ${edit.name}` : `Create ${resource.replace(/s$/, '')}`}
          onClose={() => {
            setCreate(false);
            setEdit(null);
          }}
        >
          <ResourceForm
            fields={fields}
            initial={edit ?? undefined}
            onSubmit={async (data) => {
              if (edit)
                await api.patch(`/${resource}/${edit._id}`, data, {
                  headers: { 'If-Match': edit.__v ?? 0 },
                });
              else await command(`/${resource}`, data);
              toast.success('Record saved');
              setCreate(false);
              setEdit(null);
              await refresh();
            }}
          />
        </Modal>
      )}
      {action && (
        <Modal title={action.title} onClose={() => setAction(null)}>
          <p className="sq-dialog-copy">
            This updates the selected record and keeps an audit history. Scheduled subscription
            changes apply at the next billing boundary.
          </p>
          <ResourceForm
            fields={action.fields}
            initial={action.initial}
            submitLabel="Confirm"
            onSubmit={async (data) => {
              if (action.perform) await action.perform(data);
              else if (action.method === 'delete') await api.delete(action.path);
              else if (action.method === 'patch') await api.patch(action.path, data);
              else await command(action.path, data);
              toast.success('Operation completed');
              setAction(null);
              await refresh();
            }}
          />
        </Modal>
      )}
      {detail && (
        <Modal
          title={String(detail.name ?? detail.number ?? 'Record details')}
          onClose={() => setDetail(null)}
        >
          <RecordDetails row={detail} />
          {Array.isArray(detail.variants) &&
            user.role === 'admin' &&
            (detail.variants as Row[]).map((variant) => (
              <div className="sq-detail-actions" key={variant._id}>
                <span>{String(variant.name)}</span>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDetail(null);
                    setAction({
                      title: 'Edit product variant',
                      path: `/products/${detail._id}/variants/${variant._id}`,
                      method: 'patch',
                      initial: variant,
                      fields: [
                        { name: 'name', label: 'Variant name', required: true },
                        {
                          name: 'additionalPriceMinor',
                          label: 'Additional price (INR)',
                          type: 'money',
                          required: true,
                        },
                      ],
                    });
                  }}
                >
                  Edit variant
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDetail(null);
                    setAction({
                      title: 'Archive variant',
                      path: `/products/${detail._id}/variants/${variant._id}`,
                      method: 'delete',
                      fields: [],
                    });
                  }}
                >
                  Archive variant
                </Button>
              </div>
            ))}
          <div className="sq-detail-actions">
            {rowActions(detail).map((button) => (
              <Button
                variant="outline"
                key={button.label}
                onClick={() => {
                  setDetail(null);
                  button.run();
                }}
              >
                {button.label}
              </Button>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
function RecordDetails({ row }: { row: Row }) {
  const fields = [
    'number',
    'name',
    'email',
    'company',
    'phone',
    'address',
    'description',
    'status',
    'frequency',
    'dueAt',
    'nextBillingAt',
    'startAt',
    'expiryAt',
    'reference',
    'method',
    'terms',
    'reason',
    'lastError',
    'failedReason',
  ];
  return (
    <div className="sq-record-details">
      {Boolean(row.frequency && (row.startAt || row.createdAt)) && (
        <div className="sq-stepper">
          <div className="sq-step done">
            <div className="sq-step-dot" />
            <span>Created</span>
            <small>{displayDate(row.createdAt ?? row.startAt)}</small>
          </div>
          <div className={`sq-step ${row.status !== 'draft' ? 'done' : 'current'}`}>
            <div className="sq-step-dot" />
            <span>{row.status === 'draft' ? 'Draft Quote' : 'Confirmed'}</span>
            <small>{String(row.status)}</small>
          </div>
          <div
            className={`sq-step ${row.status === 'active' ? 'current' : row.status === 'closed' || row.status === 'cancelled' ? 'done' : ''}`}
          >
            <div className="sq-step-dot" />
            <span>Recurring Billing</span>
            <small>{String(row.frequency)}</small>
          </div>
          <div className="sq-step">
            <div className="sq-step-dot" />
            <span>Next Renewal</span>
            <small>{row.nextBillingAt ? displayDate(row.nextBillingAt) : '—'}</small>
          </div>
        </div>
      )}
      <dl>
        {fields
          .filter((field) => row[field])
          .map((field) => (
            <div key={field}>
              <dt>{field.replace(/([A-Z])/g, ' $1').replace('At', 'date')}</dt>
              <dd>{field.endsWith('At') ? displayDate(row[field]) : String(row[field])}</dd>
            </div>
          ))}
      </dl>
      {Array.isArray(row.lines) && (
        <table className="sq-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty</th>
              <th>Unit price</th>
              <th>Discount</th>
              <th>Tax</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {(row.lines as Row[]).map((line, index) => (
              <tr key={index}>
                <td>{String(line.name)}</td>
                <td>{Number(line.quantity)}</td>
                <td>{money(line.unitPriceMinor)}</td>
                <td>{money(line.discountMinor)}</td>
                <td>{money(line.taxMinor)}</td>
                <td>{money(line.totalMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {Array.isArray(row.variants) && (
        <div>
          <h3>Product variants</h3>
          {(row.variants as Row[]).map((variant) => (
            <p key={variant._id}>
              {String(variant.name)} · additional {money(variant.additionalPriceMinor)}
            </p>
          ))}
        </div>
      )}
      {Array.isArray(row.events) && (
        <div>
          <h3>Lifecycle history</h3>
          {(row.events as Row[]).map((event) => (
            <p key={event._id}>
              {displayDate(event.effectiveAt)} · {String(event.action)} · {String(event.from)} →{' '}
              {String(event.to)} {String(event.reason ?? '')}
            </p>
          ))}
        </div>
      )}
      {Boolean(row.history) && (
        <div>
          <h3>Payments & credits</h3>
          {[
            ...((row.history as { allocations: Row[] }).allocations ?? []),
            ...((row.history as { credits: Row[] }).credits ?? []),
          ].map((item) => (
            <p key={item._id}>
              {String(item.number ?? 'Payment allocation')} · {money(item.amountMinor)} ·{' '}
              {displayDate(item.createdAt)}
            </p>
          ))}
        </div>
      )}
      {row.totalMinor !== undefined && (
        <div className="sq-totals">
          <span>
            Subtotal <strong>{money(row.subtotalMinor)}</strong>
          </span>
          <span>
            Discount <strong>{money(row.discountMinor)}</strong>
          </span>
          <span>
            Tax <strong>{money(row.taxMinor)}</strong>
          </span>
          <span>
            Total <strong>{money(row.totalMinor)}</strong>
          </span>
          {row.outstandingMinor !== undefined && (
            <span>
              Outstanding <strong>{money(row.outstandingMinor)}</strong>
            </span>
          )}
        </div>
      )}
      {Boolean(
        row.number &&
        String(row.number).startsWith('INV-') &&
        (row.outstandingMinor === undefined || Number(row.outstandingMinor) > 0),
      ) && (
        <div className="sq-upi-qr-card">
          <div className="sq-upi-qr-frame">
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(
                `upi://pay?pa=brightloop@upi&pn=Brightloop+Software&mc=0000&tid=${row.number}&tr=${row.number}&am=${(
                  Number(row.outstandingMinor ?? row.totalMinor) / 100
                ).toFixed(2)}&cu=INR`,
              )}`}
              alt="Scan & Pay via UPI"
              width={120}
              height={120}
            />
            <small>Scan with GPay / PhonePe / Paytm / BHIM</small>
          </div>
          <div className="sq-upi-details">
            <h4>Instant UPI & Card Settlement</h4>
            <p>
              Scan the QR code directly from your mobile UPI app, or click below to settle instantly
              without leaving the screen.
            </p>
            <div className="sq-upi-meta">
              <span>
                VPA: <strong>brightloop@upi</strong>
              </span>
              <span>
                Due:{' '}
                <strong className="due-amount">
                  {money(row.outstandingMinor ?? row.totalMinor)}
                </strong>
              </span>
            </div>
            <div className="sq-upi-actions">
              <Button
                className="sq-upi-btn"
                onClick={async () => {
                  try {
                    await api.post(`/payments/upi/${row._id}`);
                    toast.success('Instant UPI Payment confirmed! Invoice settled.');
                    window.location.reload();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                <Zap size={14} /> Pay via Instant UPI
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await payInvoice(row);
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                Razorpay Checkout
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  void printInvoice(row).catch((err) => toast.error(errorMessage(err)));
                }}
              >
                <Printer size={14} /> Print Invoice
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
async function payInvoice(invoice: Row) {
  const { data } = await command('/payments/create-order', {
    invoiceId: invoice._id,
    amountMinor: Number(invoice.outstandingMinor),
  });
  const order = data.data as { orderId: string; amountMinor: number; keyId: string };
  const browser = window as unknown as {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  };
  if (!browser.Razorpay)
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Could not load secure checkout'));
      document.body.appendChild(script);
    });
  await new Promise<void>((resolve, reject) => {
    const checkout = new browser.Razorpay!({
      key: order.keyId,
      amount: order.amountMinor,
      currency: 'INR',
      order_id: order.orderId,
      name: 'Brightloop Software',
      description: String(invoice.number),
      handler: async (response: unknown) => {
        try {
          await command('/payments/verify', response);
          toast.success('Payment submitted for server reconciliation');
          resolve();
        } catch (error) {
          reject(error);
        }
      },
      modal: { ondismiss: () => resolve() },
    });
    checkout.open();
  });
}

async function printInvoice(invoice: Row) {
  const view = window.open('', '_blank');
  if (!view) throw new Error('Allow popups to print this invoice');
  try {
    const response = await api.get(`/invoices/${invoice._id}/pdf`, { responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    view.addEventListener(
      'load',
      () => {
        view.focus();
        view.print();
      },
      { once: true },
    );
    view.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    view.close();
    throw error;
  }
}
