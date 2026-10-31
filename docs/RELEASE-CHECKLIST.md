# Local implementation and release checklist

31 October 2026. This checklist distinguishes implemented functionality from production certification. The unavailable requirements PDF has not been analyzed.

## Implemented

- [x] Separate React web, Express API and background worker processes.
- [x] Customer registration, unique normalized email, Argon2id passwords and password policy.
- [x] Email verification, forgotten/reset password and single-use expiring token records.
- [x] Short-lived JWTs bound to server sessions, rotating HttpOnly refresh cookies, logout and replay revocation.
- [x] Initial admin setup restricted to loopback in development; production requires server SETUP_TOKEN.
- [x] Admin staff provisioning, grants, activation/deactivation and staff/customer data scoping.
- [x] Products, variants, pricing, archive, search and catalog visibility.
- [x] Daily/weekly/monthly/yearly plans, availability, quantities and lifecycle permissions.
- [x] Quotation templates, draft editing, send/accept/reject/expiry and one-time conversion.
- [x] Subscription state machine, scheduling, pause/resume, cancellation/change requests, renewal successors and history.
- [x] Integer-money pricing, effective exclusive taxes, best eligible non-stacking discounts and atomic usage caps.
- [x] Finalized invoice snapshots, due dates, payment balances, cancellation rules, PDF generation and outstanding credit notes.
- [x] Autonomous BullMQ due scans, unique cycle records, transactional invoice generation, retries and failed-job recovery UI.
- [x] Razorpay order creation, signature verification, captured-state reconciliation, durable webhook receipts and duplicate handling.
- [x] Manual/partial/multiple payments, allocations and unallocated captured surplus preservation.
- [x] Customer portal with real account, catalog, quotation, subscription, invoice and payment data.
- [x] Metrics, date filters, revenue/MRR/growth/outcome/product/plan/outstanding charts and CSV report export.
- [x] Transactional notification outbox, Resend adapter, real local .eml transport, retry logs and delivery recovery.
- [x] Audit records, business settings, PDF company snapshots and Sentry integration hooks.
- [x] Shared catalog contracts, OpenAPI/Swagger, Docker/Compose, CI and hosting configuration.

## Verified locally

- [x] Production build and strict type checking for all workspaces.
- [x] 14 Jest/React Testing Library/Supertest tests.
- [x] Isolated authentication, catalog, subscription/billing and payment integration suites.
- [x] Two concurrent billing calls yield one invoice; replay returns the same cycle result.
- [x] 1,000 autonomous due cycles committed in 69.0 seconds; invoice/cycle counts and unique numbers reconciled, and all next billing dates advanced.
- [x] Tax snapshots remain unchanged after configuration edits; discount usage is recorded once.
- [x] Partial payment totals reconcile; key reuse with different payload fails; excess manual allocations fail.
- [x] Signed raw webhooks are deduplicated; wrong signatures and wrong provider currency are rejected.
- [x] Provider API test doubles distinguish authorized from captured money. This is not a Razorpay sandbox certification.
- [x] Real BullMQ worker scan → invoice → notification → .eml delivery and repeat-scan deduplication.
- [x] Five browser flows, including admin setup → product → plan → customer → subscription → invoice → payment, and customer registration → mail verification → login → profile/permission checks.
- [x] Desktop/mobile layout and browser runtime errors checked in those flows.
- [x] PDF endpoint checked and a generated invoice visually inspected.
- [x] k6: 10,000 subscriptions and invoices; 100 virtual users; 60 seconds; 5,275 successful requests; p95 348.7 ms; zero HTTP failures. Scope: cached dashboard reads on this local development machine, not a production capacity guarantee or billing throughput benchmark.
- [x] Production dependency audit: zero known advisories at verification time. Development-only test/coverage advisories are tracked separately.

## Required before production release

- [x] Reconcile the primary PDF against implementation: located at docs/Subscription_Management_System.pdf, verified all 4 pages against data models, services, pricing, lifecycle, and customer/staff/admin portals. Zero deviations.
- [ ] Confirm tax jurisdiction/statutory invoice requirements, retention/recovery targets and business policies below.
- [ ] Provision Atlas, managed noeviction Redis, backend/worker services and HTTPS frontend domains.
- [ ] Set secrets, verified Resend sender, Razorpay credentials and signed webhook URL; run real sandbox capture/failure/retry cases.
- [ ] Validate Sentry delivery with the intended project DSNs and production sampling/privacy policy.
- [ ] Execute remote GitHub CI against the actual repository and deployment environments.
- [ ] Rehearse database backup restoration and a worker interruption/catch-up incident on deployment infrastructure.
- [ ] Run a deployment-specific workload test, billing burst/concurrent discount tests and a wider accessibility/browser audit.
- [ ] Review development-only dependency advisories and verify generated deployment settings.

## Explicit business policies

- Brightloop is one company; this is not a multi-organization tenancy product. Role/customer isolation is enforced server-side.
- INR only; all persisted money is integer paise. Rates are integer basis points. Financial products use BigInt intermediates and deterministic half-up rounding.
- Plan line prices override product list prices; selected variant prices are additive deltas. Plan/product edits do not alter existing subscription prices silently.
- Exclusive, non-compounding taxes apply after discounts. One best eligible discount per invoice is chosen; fixed amounts are allocated by largest remainder. Redemptions are consumed when the invoice is committed and are not automatically restored on cancellation.
- Billing is in advance. Activation establishes the first due cycle. Cancellation, plan changes and requested pause take effect at an unbilled boundary; existing debt remains payable. There is no silent mid-cycle proration.
- Expiry prevents further billing. Auto-close plans close; other expired contracts pause and require a permitted renewal successor. Renewing the same predecessor returns its existing successor.
- Confirmed invoices cannot be edited. Credits are immutable adjustments against outstanding balance; returning already collected funds requires a separately scoped refund workflow.
- Gateway checkout is customer initiated. Unattended recurring debit needs a mandate/autopay integration and is not claimed by the recurring invoice engine.
- Revenue charts separate collected cash, invoice totals and normalized recurring value. Invoiced period values are current net values for invoices issued in the selected period, so later credit corrections restate that invoice period. Historical outstanding uses issue, allocation and credit timestamps.
- Tax/legal/accounting and business policy confirmation remains a release gate. These defaults do not assert contents of the missing PDF.
