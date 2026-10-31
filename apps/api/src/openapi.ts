import { z } from 'zod';
import * as catalog from './modules/catalog/schemas.js';
import { orderInput, quotationInput } from './modules/subscriptions/service.js';
import { passwordSchema, emailSchema } from './modules/auth/service.js';
const definitions = {
  ProductInput: catalog.productInput,
  PlanInput: catalog.planInput,
  TaxInput: catalog.taxInput,
  DiscountInput: catalog.discountInput,
  CustomerInput: catalog.customerInput,
  VariantInput: catalog.variantInput,
  TemplateInput: catalog.templateInput,
  SubscriptionInput: orderInput,
  QuotationInput: quotationInput,
  LoginInput: z.object({ email: emailSchema, password: z.string() }),
  RegisterInput: z.object({
    name: z.string().min(2),
    email: emailSchema,
    password: passwordSchema,
  }),
  SetupInput: z.object({
    name: z.string(),
    email: emailSchema,
    password: passwordSchema,
    setupToken: z.string().optional(),
  }),
  EmailInput: z.object({ email: emailSchema }),
  VerifyInput: z.object({ token: z.string().length(64) }),
  ResetInput: z.object({ token: z.string().length(64), password: passwordSchema }),
  ActionInput: z.object({ reason: z.string().optional(), planId: catalog.id.optional() }),
  ManualPaymentInput: z.object({
    invoiceId: catalog.id,
    amountMinor: catalog.minor,
    method: z.enum(['bank_transfer', 'cash', 'upi', 'card', 'other']),
    reference: z.string(),
    notes: z.string().optional(),
  }),
  OrderInput: z.object({ invoiceId: catalog.id, amountMinor: catalog.minor }),
  PaymentVerifyInput: z.object({
    razorpay_order_id: z.string(),
    razorpay_payment_id: z.string(),
    razorpay_signature: z.string(),
  }),
  CreditInput: z.object({ amountMinor: catalog.minor, reason: z.string().min(3) }),
  RequestInput: z.object({
    kind: z.enum(['cancel', 'upgrade', 'downgrade']),
    planId: catalog.id.optional(),
    reason: z.string(),
  }),
  ProfileInput: z.object({
    name: z.string(),
    company: z.string().optional(),
    phone: z.string().optional(),
    address: z.string().optional(),
    taxId: z.string().optional(),
  }),
  SettingsInput: z.object({
    companyName: z.string(),
    defaultTermsDays: z.number().int(),
    invoiceFooter: z.string(),
  }),
  StaffInput: z.object({
    name: z.string(),
    email: emailSchema,
    password: passwordSchema,
    permissions: z.array(z.string()),
  }),
  StaffUpdateInput: z.object({
    name: z.string(),
    permissions: z.array(z.string()),
    active: z.boolean(),
  }),
  AssignmentInput: z.object({ assignedStaffIds: z.array(catalog.id) }),
  QuotationEditInput: z.object({
    expiryAt: z.iso.datetime(),
    terms: z.string(),
    planId: catalog.id.optional(),
    quantity: catalog.quantity.optional(),
    variants: z.record(catalog.id, catalog.id).optional(),
  }),
  InvoiceGenerationInput: z.object({ draft: z.boolean().default(false) }),
};
const paths: Record<string, Record<string, unknown>> = {};
function route(
  method: string,
  path: string,
  summary: string,
  schema?: keyof typeof definitions,
  publicRoute = false,
) {
  const parameters: Record<string, unknown>[] = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  if (
    method === 'get' &&
    !path.includes('{') &&
    !path.startsWith('/auth') &&
    !path.startsWith('/health')
  )
    parameters.push(
      ...['page', 'pageSize', 'q', 'status', 'sort'].map((name) => ({
        name,
        in: 'query',
        schema: { type: name === 'page' || name === 'pageSize' ? 'integer' : 'string' },
      })),
    );
  if (
    method === 'post' &&
    /payments$|create-order$|credit-notes$|invoices\/\{id\}\/send$/.test(path)
  )
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 8, maxLength: 100 },
    });
  if (method === 'patch' && /^\/(products|plans|taxes|discounts|quotation-templates)\//.test(path))
    parameters.push({
      name: 'If-Match',
      in: 'header',
      required: true,
      schema: { type: 'integer', minimum: 0 },
      description: 'Current document __v for optimistic concurrency',
    });
  const responses: Record<string, unknown> = {
    200: { description: 'Successful operation; JSON data envelope' },
    400: { description: 'Malformed request' },
    401: { description: 'Authentication required' },
    403: { description: 'Role, grant or origin denied' },
    404: { description: 'Not found or outside permitted scope' },
    409: { description: 'State, version or idempotency conflict' },
    422: { description: 'Validation failure' },
    429: { description: 'Rate limit exceeded' },
    503: { description: 'Required service/integration unavailable' },
  };
  if (method === 'post') responses['201'] = { description: 'Created' };
  if (method === 'delete' || path.endsWith('logout'))
    responses['204'] = { description: 'Completed, no response body' };
  paths[path] ??= {};
  paths[path]![method] = {
    summary,
    tags: [path.split('/')[1]],
    security: publicRoute ? [] : [{ bearerAuth: [] }],
    parameters,
    responses,
    ...(schema
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
          },
        }
      : {}),
  };
}
for (const [path, schema] of [
  ['register', 'RegisterInput'],
  ['login', 'LoginInput'],
  ['setup', 'SetupInput'],
  ['forgot-password', 'EmailInput'],
  ['resend-verification', 'EmailInput'],
  ['verify-email', 'VerifyInput'],
  ['reset-password', 'ResetInput'],
] as const)
  route('post', `/auth/${path}`, `Authentication: ${path}`, schema, true);
for (const path of ['logout', 'refresh', 'logout-all'])
  route(
    'post',
    `/auth/${path}`,
    `Cookie-authenticated ${path}; same-origin policy applies`,
    undefined,
    path !== 'logout-all',
  );
route('get', '/auth/me', 'Current session');
route('get', '/auth/setup-status', 'Whether initial admin setup is required', undefined, true);
for (const path of ['live', 'ready'])
  route('get', `/health/${path}`, `${path} health`, undefined, true);
for (const [path, schema] of [
  ['products', 'ProductInput'],
  ['plans', 'PlanInput'],
  ['taxes', 'TaxInput'],
  ['discounts', 'DiscountInput'],
  ['quotation-templates', 'TemplateInput'],
] as const) {
  route('get', `/${path}`, `Paginated ${path}; customer catalog scope or configured permission`);
  route('get', `/${path}/{id}`, `Scoped ${path} detail`);
  route('post', `/${path}`, `Admin: create ${path}`, schema);
  route('patch', `/${path}/{id}`, `Admin: update ${path}`, schema);
  route('delete', `/${path}/{id}`, `Admin: archive/deactivate ${path}`);
}
route('get', '/products/{id}/variants', 'Product variants');
route('post', '/products/{id}/variants', 'Admin: create variant', 'VariantInput');
route('patch', '/products/{id}/variants/{variantId}', 'Admin: edit variant', 'VariantInput');
route('delete', '/products/{id}/variants/{variantId}', 'Admin: archive variant');
for (const action of ['activate', 'deactivate'])
  route('post', `/plans/{id}/${action}`, `Admin: ${action} plan`);
for (const resource of ['customers', 'quotations', 'subscriptions', 'invoices', 'payments']) {
  route('get', `/${resource}`, `Paginated scoped ${resource}`);
  route('get', `/${resource}/{id}`, `Scoped ${resource} detail`);
}
route('post', '/customers', 'Create permitted customer', 'CustomerInput');
route('patch', '/customers/{id}', 'Edit permitted customer', 'CustomerInput');
route('patch', '/customers/{id}/assignments', 'Admin: assign active staff', 'AssignmentInput');
route('post', '/quotations', 'Create server-priced quotation', 'QuotationInput');
route('patch', '/quotations/{id}', 'Edit draft quotation terms/expiry', 'QuotationEditInput');
for (const action of ['send', 'accept', 'reject', 'convert'])
  route('post', `/quotations/{id}/${action}`, `Quotation ${action}; state and ownership enforced`);
route('post', '/subscriptions', 'Staff/admin: create draft subscription', 'SubscriptionInput');
route('patch', '/subscriptions/{id}', 'Edit draft subscription', 'SubscriptionInput');
for (const action of [
  'quote',
  'confirm',
  'activate',
  'pause',
  'resume',
  'renew',
  'cancel',
  'close',
  'upgrade',
  'downgrade',
])
  route(
    'post',
    `/subscriptions/{id}/${action}`,
    `Subscription ${action}; plan policy and grants enforced`,
    'ActionInput',
  );
route('get', '/subscriptions/{id}/history', 'Scoped lifecycle history');
route(
  'post',
  '/subscriptions/{id}/change-requests',
  'Request cancellation or plan change',
  'RequestInput',
);
route('get', '/change-requests', 'Scoped change requests');
for (const action of ['approve', 'reject'])
  route('post', `/change-requests/{id}/${action}`, `Staff/admin: ${action} request`);
route(
  'post',
  '/subscriptions/{id}/invoices',
  'Generate due cycle or preview a non-payable draft; confirmation reprices and finalizes the same cycle',
  'InvoiceGenerationInput',
);
for (const action of ['confirm', 'cancel', 'send'])
  route(
    'post',
    `/invoices/{id}/${action}`,
    `Staff/admin: ${action} invoice`,
    action === 'cancel' ? 'ActionInput' : undefined,
  );
route('get', '/invoices/{id}/pdf', 'Scoped PDFKit invoice PDF');
route('get', '/invoices/{id}/history', 'Payment allocations and credit notes');
route(
  'post',
  '/invoices/{id}/credit-notes',
  'Admin: immutable outstanding credit adjustment',
  'CreditInput',
);
route('post', '/payments', 'Staff/admin: record manual partial/full payment', 'ManualPaymentInput');
route('post', '/payments/create-order', 'Create owned Razorpay order', 'OrderInput');
route(
  'post',
  '/payments/verify',
  'Verify signature and reconcile captured payment',
  'PaymentVerifyInput',
);
route(
  'post',
  '/webhooks/razorpay',
  'Raw-body HMAC-verified durable webhook receipt',
  undefined,
  true,
);
for (const path of [
  'dashboard',
  'revenue',
  'subscriptions',
  'payments',
  'customers',
  'outstanding',
]) {
  route(
    'get',
    `/analytics/${path}`,
    'Scoped financial aggregates; use from/to ISO timestamps or range today/7/30/90/year/custom',
  );
  const operation = paths[`/analytics/${path}`]!.get as { parameters: unknown[] };
  operation.parameters = ['from', 'to', 'range'].map((name) => ({
    name,
    in: 'query',
    schema: { type: 'string' },
  }));
}
route('get', '/reports/export', 'Scoped metrics CSV; same range parameters as analytics');
route('get', '/me', 'Own profile');
route('patch', '/me', 'Update own profile', 'ProfileInput');
route('get', '/staff', 'Admin: staff list');
route('post', '/staff', 'Admin: create staff', 'StaffInput');
route('patch', '/staff/{id}', 'Admin: staff permissions and activation', 'StaffUpdateInput');
route('get', '/settings', 'Admin: business settings');
route('patch', '/settings', 'Admin: edit business settings', 'SettingsInput');
for (const path of ['audit-logs', 'notifications', 'billing-records', 'jobs/failed'])
  route('get', `/${path}`, `Admin: ${path}`);
route('post', '/notifications/{id}/retry', 'Admin: recover failed email delivery');
route('post', '/jobs/{queue}/{id}/retry', 'Admin: retry failed job with original cycle identity');
export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'SubscriptIQ API',
    version: '0.2.0',
    description:
      'Brightloop Software. Monetary values are integer INR paise; rates are integer basis points. All domain endpoints enforce role, grants, state and customer scope. API errors include requestId. No finalized invoice content may be edited.',
  },
  servers: [{ url: '/api' }],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: Object.fromEntries(
      Object.entries(definitions).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
      ]),
    ),
  },
};
