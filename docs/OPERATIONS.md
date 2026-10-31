# Operations guide

## Services and signals

`GET /api/health/live` checks API process liveness. `/api/health/ready` checks MongoDB topology, Redis and an expiring worker heartbeat. A live API can be unready. Use external monitoring for queue lag, failures, missed worker heartbeats and provider delivery failures; do not treat HTTP 200 liveness as proof billing is progressing.

Queues: subscriptiq-operations (30-second scans, webhook/reconciliation), subscriptiq-billing (10 concurrent processors), subscriptiq-email (5 concurrent deliveries). QUEUE_PREFIX isolates environments; default is subscriptiq. Use a separate Redis deployment/database and prefix per environment.

MongoDB is authoritative. BullMQ delivery is at least once; unique subscription-cycle records and invoice links prevent duplicate posting. Billing writes invoice, redemption usage, next date, audit and notification intent in one replica-set transaction. External emails are sent afterward. Provider idempotency limits email duplication, but no networked email service is claimed to offer unlimited exactly-once delivery.

## Failed billing or email

1. Inspect Admin → Failed jobs and Admin → Billing records/Email delivery.
2. Correct database/Redis/provider configuration first. Check logs by request/job ID; never copy credentials or verification/reset links into tickets.
3. Retry the original failed job. Preserve its cycle identity; do not manually create another invoice for the same period.
4. For a failed email, use Retry delivery after fixing the provider; delivery attempts and last error remain observable.
5. Verify the invoice count, next billing date and payment allocations after recovery. Due scans catch up missed cycles in bounded batches rather than skipping periods.

Notification documents are the transactional email outbox: commits persist delivery intent, and scans enqueue pending records. No separate broker transaction is assumed. Completed/failed BullMQ retention is finite; archive incident evidence according to the agreed retention policy.

## Payment uncertainty

Never mark an invoice paid from a browser redirect. Verification fetches the provider payment and checks order, amount, INR currency and captured status. Webhooks validate the signature against original raw bytes and persist the receipt before asynchronous processing. Reconciliation revisits uncertain orders and payments.

If order creation times out after the provider accepted it, retry the original request key/receipt, inspect the provider order and reconcile it. Do not blindly create a second charge. Captured surplus is persisted as unallocated customer credit and requires financial review; it is not discarded or overallocated to an invoice.

## Secrets and deployment

Use platform secret stores for AUTH_SECRET, SETUP_TOKEN, database/Redis URLs, Razorpay secrets, Resend keys and private Sentry configuration. Never prefix secrets with VITE_. VITE_API_URL and VITE_SENTRY_DSN are public client configuration.

Set TRUST_PROXY_HOPS to the actual trusted ingress hop count, keeping 0 for direct local access. This preserves client IP rate limiting behind the production proxy without trusting arbitrary forwarded headers. Production uses Secure HttpOnly refresh cookies. Prefer a same-origin proxy or custom domains sharing the same site. If cross-site cookies are unavoidable, explicitly set COOKIE_SAME_SITE=none, use HTTPS, and retain the exact WEB_ORIGIN checks; browser third-party cookie policies may still require a same-origin proxy.

For local Docker, run `npm run configure` before Compose. Database volumes persist on normal shutdown. Mail transport local writes development .eml files under var/mail on host runs or the mail-data volume in container runs. It is disabled in NODE_ENV=production. Local mail directories contain single-use links and are excluded from Git and image build context.

## Backup and restore rehearsal

Use Atlas scheduled backups/PITR according to an agreed recovery objective. Before release, restore into a separately named staging deployment, verify indexes and transaction support, then reconcile invoice/payment allocation totals. Keep restored staging workers disabled until provider credentials and queue namespaces are isolated. Record restore duration and data-loss window. No restore exercise has been performed by this local implementation.

## Shipping

The Render blueprint prepares separate API and worker services; Atlas/managed Redis must be supplied. For Vercel use apps/web as project root and allow workspace files outside that root. Set API_PUBLIC_ORIGIN to the actual HTTPS backend and run `npm run deploy:config` to generate a same-origin /api proxy; inspect/commit that concrete configuration. Default SPA configuration contains no fabricated backend URL.

Configure real sender/provider sandbox keys first, complete sandbox and webhook checks, then change to production credentials through the hosting platform. GitHub Actions is prepared but has not run on a remote repository. Publishing requires an actual connected repository, hosting project and environment values.
