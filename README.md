# SubscriptIQ

Subscription management for **Brightloop Software**, built as a TypeScript modular monolith with separate web, API and background worker deployments.

The application implements admin, staff and customer portals with real MongoDB-backed records. No sample financial dataset or hardcoded production credentials are created. Local tests use isolated databases and provider test doubles. Production release gates are recorded in [the release checklist](docs/RELEASE-CHECKLIST.md); the referenced primary requirements PDF has not been supplied.

## Features

- Customer registration, email verification, password recovery, Argon2id password hashes, session-bound JWTs, rotating HttpOnly refresh cookies and replay revocation.
- Admin staff provisioning, operation grants, assigned customers and server-side ownership checks.
- Products/variants, plan pricing and availability, four billing frequencies, quantities and lifecycle permissions.
- Reusable quotation templates, acceptance/expiry, one-time conversion, subscription transitions and customer change requests.
- Integer-paise prices, effective taxes, eligible non-stacking discounts and transactionally enforced usage limits.
- Automated recurring invoices, non-payable draft previews, immutable finalized snapshots, PDF downloads/printing, credit adjustments, due and overdue balances.
- Razorpay orders, signed durable webhooks, captured-state verification, manual and partial payments, allocations and reconciliation.
- BullMQ billing/email/reconciliation workers, transactional notification outbox, delivery logs and admin recovery controls.
- Financial metrics/charts, scoped report exports, audit history and business settings.

## Technology and architecture

React 19 / Vite 8 / TypeScript / Tailwind 4 / shadcn-style Radix components / React Router / Redux Toolkit / TanStack Query / React Hook Form / Zod / Axios / Recharts / Lucide / Sonner.

Express 5 / Mongoose / MongoDB replica set / Redis / BullMQ / Argon2 / JWT / PDFKit / Razorpay / Resend / Pino / Sentry. Jest, Supertest, React Testing Library, Playwright and k6 cover the implementation boundaries.

```text
apps/web                  Role portals, forms, tables and charts
apps/api/src/modules      Auth, catalog, subscriptions, billing, invoices,
                          payments, analytics and operations
apps/api/src/models       Required financial/account collections and support records
apps/worker               Independent queue processors and heartbeat
packages/contracts        Shared Zod catalog contracts and API types
packages/domain           Integer arithmetic, discount allocation, recurrence, transitions
packages/ui               Shared UI utilities
infra/docker              Multi-stage non-root runtime image
infra/deploy              Render blueprint
apps/web/vercel.json       Vercel SPA configuration; optional generated API proxy
```

MongoDB owns financial truth. Due scans enqueue stable cycle identities; invoice creation, usage records, next billing date, audit and notification intent commit together in a transaction. Queue retries are safe because database uniqueness and state checks enforce idempotency. External delivery happens after commit. Customer/staff scopes apply to records, downloads, payments, reports and exports.

See [the architecture and relationships](docs/PHASE-1-PLAN.md), [progress](docs/PROGRESS.md), [release checklist](docs/RELEASE-CHECKLIST.md) and [operations guide](docs/OPERATIONS.md).

## Local installation

Requirements: Node **22.12+ in the Node 22 release line**, npm 10+, Docker Desktop with Linux containers. Ports: web 5173, API 4000, MongoDB 27018, Redis 6380. Existing services on 27017/6379 are not replaced.

```powershell
npm ci
npm run configure
npm run infra:up
npm run dev
```

`configure` creates `.env` from the example and generates an authentication secret without printing it. It preserves configured values and generates a public-only apps/web/.env.local from VITE_ entries; private backend settings are never loaded into the frontend build. `predev` builds shared/server packages before launching the web, API and worker. Open [the workspace](http://localhost:5173), choose **Create the administrator**, and select your own credentials. No default login is installed.

Use `http://localhost:5173` consistently: WEB_ORIGIN is checked exactly for cookie-authenticated actions. If you intentionally use 127.0.0.1, update WEB_ORIGIN to match. Local initial-admin setup is restricted to loopback; production setup additionally needs the server SETUP_TOKEN. Once an admin exists, setup is disabled.

Customer verification/reset emails are actually delivered to development `.eml` files under **var/mail** when MAIL_TRANSPORT=local. Open the file locally and follow its single-use link. In production, local delivery is disabled and Resend must be configured. Tokens are not exposed by an unauthenticated mailbox endpoint.

`Ctrl+C` stops development processes. `npm run infra:down` stops containers without deleting data volumes. A fresh terminal can restart with `npm run dev` after infrastructure is running.

## Environment

| Variable                              | Meaning                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| NODE_ENV / PORT / LOG_LEVEL           | Runtime mode, API port, structured logging level                                       |
| WEB_ORIGIN                            | Exact frontend origin allowed by CORS and refresh/logout origin checks                 |
| AUTH_SECRET                           | At least 48 characters; generated locally, platform secret in production               |
| SETUP_TOKEN                           | Required to provision the first administrator in production                            |
| COOKIE_SAME_SITE                      | strict by default; none only with production HTTPS when cross-site hosting requires it |
| MONGODB_URI                           | Replica-set connection URI; Atlas supported                                            |
| REDIS_URL                             | Redis/rediss connection URI; persistent noeviction configuration for queues            |
| QUEUE_PREFIX                          | Optional environment-specific BullMQ prefix                                            |
| MAIL_TRANSPORT / MAIL_DIRECTORY       | local development transport and actual .eml output directory                           |
| RESEND_API_KEY / EMAIL_FROM           | Real Resend credentials and verified sender                                            |
| RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET | Server-side order/payment configuration                                                |
| RAZORPAY_WEBHOOK_SECRET               | Separate raw-body webhook verification secret                                          |
| SENTRY_DSN / VITE_SENTRY_DSN          | Backend/private and frontend/public error reporting configuration                      |
| VITE_API_URL                          | Public API base URL including /api; defaults to same-origin /api                       |

Root `.env` is ignored by Git/image builds. Vite exposes only VITE_ variables; never prefix private secrets with VITE_. Runtime validation reports invalid variable names without echoing secrets. Sentry request/body/user collection is disabled in the supplied configuration.

Compose initializes MongoDB as a single-node replica set. Host MongoDB uses directConnection=true because its advertised mongo hostname belongs to the Docker network. Container clients use internal mongo:27017 and redis:6379. The development databases bind published ports to loopback and are not a production deployment template.

## API documentation

With the API running:

- [Swagger UI](http://localhost:4000/api/docs)
- [OpenAPI JSON](http://localhost:4000/api/openapi.json)
- [Liveness](http://localhost:4000/api/health/live)
- [Readiness](http://localhost:4000/api/health/ready)

API base is `/api`. Domain routes use Bearer access tokens and scoped backend authorization. Access tokens remain in browser memory; refresh cookies are HttpOnly. Success responses use `{ data, meta? }`; errors use `{ error: { code, message, requestId, fieldErrors? } }`.

Money is integer INR paise and rates are integer basis points. Catalog PATCH requires If-Match with the current document __v. Payment/order/credit/send commands use Idempotency-Key; reusing a key for a different payload fails. Webhooks require original raw bytes, a valid x-razorpay-signature and provider event identity. Never confirm payment from a frontend success redirect. Invoice previews reserve no discount usage and are not payable; confirmation or the due worker reprices/finalizes the same invoice atomically. Cancelling a draft withdraws its preview, not the subscription or future billing obligation.

Lists support bounded page/pageSize and allowlisted query filters. Normal listing endpoints are paginated; small configuration/reference views have explicit limits. Financial UI state comes from the API, not Redux mock datasets.

## Tests and performance

Build shared workspaces first on a fresh checkout:

```powershell
npm run build
npm run typecheck
npm test
npm run test:integration
npm run test:services
npm run test:workers
npx playwright install chromium
npm run test:e2e
npm run test:load
```

`test:integration` proves real MongoDB transaction commit and a BullMQ round trip. `test:services` runs isolated auth/catalog/lifecycle/payment suites, including concurrent cycle deduplication, discount caps, snapshot immutability, cross-customer denial, partial payments, signatures and captured-versus-authorized provider responses. Gateway HTTP doubles are limited to tests; real sandbox capture is still a release gate.

The separate billing-burst check (`npx tsx tests/performance/billing.ts`) committed 1,000 due cycles once in 69.0 seconds on this machine. It reconciles invoice/cycle counts, unique invoice numbers and advanced billing dates.

`test:workers` exercises a real due scan, billing worker and local .eml delivery in isolated queue/database namespaces. Playwright starts separate test API/web services on 4100/5180, tests desktop/mobile admin and customer flows, then removes its own database/queues. It does not seed your live workspace.

`test:load` uses Docker's grafana/k6 image against an isolated API and 10,000 subscriptions/invoices. Last recorded run: **100 virtual users, 60 seconds, 5,275 successful requests, p95 348.7 ms, zero failed requests**. It measures cached dashboard reads on this machine, not all endpoints or production capacity. Redis cache entries include actor, role, grants and resource scope, expire after ten seconds, and are invalidated on API mutations. Worker updates can appear with up to that cache delay.

CI performs build/type checks, unit tests, Compose startup, infrastructure/service/worker checks and Playwright. Remote CI has not been executed on a connected GitHub repository. Production dependency audit is clean at verification time; development-only coverage/tool advisories and wider release checks are documented separately.

## Docker and deployment

```powershell
npm run configure
docker compose --profile app build
docker compose --profile app up -d --wait
```

The app profile starts API and worker alongside MongoDB/Redis. Do not also run the host API on port 4000. After a local build, start just the frontend with `npm run dev -w @subscriptiq/web`. Container local email uses the mail-data volume. Images build from a clean npm ci, install production dependencies and run as the unprivileged node user; environment files and mail/token directories are excluded from the build context.

Production targets are Vercel frontend, Render or AWS API/worker, Atlas and managed Redis. The Render blueprint is in infra/deploy. Supply real environment values through secret stores, configure the verified Resend sender and Razorpay webhook, and run sandbox/provider checks before production credentials.

For Vercel, select apps/web as root and allow workspace files outside it. Configure a same-origin API proxy once the actual backend exists:

```powershell
$env:API_PUBLIC_ORIGIN = 'https://your-actual-backend.example'
npm run deploy:config
```

The command validates and writes a concrete proxy configuration; no fabricated backend destination ships by default. A same-origin proxy or same-site custom domains are preferred for refresh cookies. See the operations guide for cross-site cookie considerations, failed jobs, payment uncertainty and backup/restore rehearsal.

No external deployment has been performed. Missing PDF reconciliation, provider sandbox certification, production environment values, a restore rehearsal and deployment-specific validation remain required before claiming a production-ready release.
