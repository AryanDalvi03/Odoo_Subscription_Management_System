import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import axios from 'axios';
import {
  Activity,
  ArrowUpRight,
  Boxes,
  CheckCircle2,
  CircleDot,
  Layers3,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { Toaster, toast } from 'sonner';
import { serviceHealthSchema } from '@subscriptiq/contracts/health';
import '../styles.css';
const store = configureStore({ reducer: { preferences: (state = { compact: false }) => state } });
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
const api = axios.create({ baseURL: '/api', timeout: 8000, withCredentials: true });
export function Foundation() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      const response = await api.get('/health/ready', {
        validateStatus: (code) => code === 200 || code === 503,
      });
      return serviceHealthSchema.parse(response.data.data);
    },
    refetchInterval: 15_000,
  });
  const currentHealth = health.isError ? undefined : health.data;
  return (
    <div className="shell">
      <aside>
        <Link className="brand" to="/">
          <span className="brand-icon">
            <Layers3 size={23} />
          </span>
          Subscript<span>IQ</span>
        </Link>
        <div className="workspace">
          BRIGHTLOOP SOFTWARE<span>Subscription workspace</span>
        </div>
        <nav aria-label="Main">
          <Link className="selected" to="/">
            <Boxes size={18} />
            Workspace setup
          </Link>
          <Link to="/architecture">
            <Layers3 size={18} />
            Architecture
          </Link>
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={20} />
          <strong>Built on a solid foundation</strong>
          <p>Secure infrastructure comes before financial operations.</p>
        </div>
        <div className="company-avatar">
          B
          <span>
            Brightloop Software<small>Development environment</small>
          </span>
        </div>
      </aside>
      <main>
        <header>
          <span>
            Workspace / <strong>Foundation</strong>
          </span>
          <span className="phase">
            <CircleDot size={14} />
            System health
          </span>
        </header>
        <section className="content">
          <div className="eyebrow">LET’S GET THE FOUNDATION RIGHT</div>
          <div className="heading">
            <div>
              <h1>Your subscription workspace.</h1>
              <p>The infrastructure behind every plan, invoice and renewal.</p>
            </div>
            <button
              disabled={health.isFetching}
              onClick={() => {
                void health
                  .refetch()
                  .then((result) =>
                    result.isError
                      ? toast.error('Could not reach the API')
                      : toast.success('Service status refreshed'),
                  );
              }}
            >
              <RefreshCw size={16} className={health.isFetching ? 'spin' : ''} />
              Refresh status
            </button>
          </div>
          <div className="banner">
            <span className="banner-icon">
              <Layers3 size={28} />
            </span>
            <div>
              <span className="tag">LIVE INFRASTRUCTURE</span>
              <h2>A reliable starting point for SubscriptIQ</h2>
              <p>
                Frontend, API and worker services are separated and ready for the next
                implementation phases.
              </p>
            </div>
            <div className="banner-orbit" aria-hidden="true">
              ◎
            </div>
          </div>
          <div className="section-heading">
            <h2>Service health</h2>
            <span>
              <span className="live-dot" />
              Live checks · every 15 seconds
            </span>
          </div>
          {health.isError && (
            <div className="error" role="alert">
              The API is unreachable. Start MongoDB, Redis, the API and worker, then refresh. Your
              data is never replaced with simulated financial records.
            </div>
          )}
          <div className="health-grid">
            {(['database', 'redis', 'transactions', 'worker'] as const).map((key) => (
              <article className="health-card" key={key}>
                <div className="card-top">
                  <span className="service-icon">
                    <Server size={18} />
                  </span>
                  <span className={'status ' + (currentHealth?.checks[key] ? 'good' : '')}>
                    {health.isPending
                      ? 'Checking'
                      : currentHealth?.checks[key]
                        ? 'Connected'
                        : 'Unavailable'}
                  </span>
                </div>
                <h3>
                  {
                    {
                      database: 'MongoDB',
                      redis: 'Redis',
                      transactions: 'Transactions',
                      worker: 'Background worker',
                    }[key]
                  }
                </h3>
                <p>
                  {
                    {
                      database: 'Primary application database',
                      redis: 'Queue and cache connection',
                      transactions: 'Replica set capability',
                      worker: 'Recent infrastructure heartbeat',
                    }[key]
                  }
                </p>
              </article>
            ))}
          </div>
          <div className="bottom-grid">
            <article className="panel">
              <div className="section-heading">
                <h2>Implementation roadmap</h2>
                <Link to="/architecture">
                  View design <ArrowUpRight size={14} />
                </Link>
              </div>
              {[
                ['01', 'Architecture & planning', 'Complete'],
                ['02', 'Workspace & infrastructure', 'Complete'],
                ['03', 'Authentication & access', 'Complete'],
                ['04', 'Products & variants', 'Complete'],
              ].map(([num, title, status]) => (
                <div className="roadmap-row" key={num}>
                  <span className={'step ' + (num === '01' ? 'done' : '')}>
                    {num === '01' ? <CheckCircle2 size={19} /> : num}
                  </span>
                  <strong>{title}</strong>
                  <small>{status}</small>
                </div>
              ))}
            </article>
            <article className="panel next">
              <span className="service-icon">
                <ShieldCheck size={21} />
              </span>
              <h2>Connected subscription operations</h2>
              <p>
                Role-based portals for admins, staff and customers start with verified identities
                and server-side permissions.
              </p>
              <div className="notice">
                <Activity size={17} />
                <span>
                  Service checks reflect the configured database, queues and worker heartbeat.
                </span>
              </div>
            </article>
          </div>
          <footer>
            SubscriptIQ <span>Subscription operations, thoughtfully connected.</span>
          </footer>
        </section>
      </main>
    </div>
  );
}
export function Architecture() {
  return (
    <main className="document">
      <Link to="/">← Workspace</Link>
      <h1>One platform. Three services.</h1>
      <p>
        The React frontend calls the Express API. MongoDB stores authoritative records; Redis
        connects the API and background workers.
      </p>
      <div className="panel">
        <h2>Built for reliable billing</h2>
        <p>
          Transactional invoices, unique cycle keys, immutable financial snapshots and recoverable
          queue jobs protect the billing lifecycle.
        </p>
        <p>
          Authentication, catalog, subscriptions, invoices and reporting share server-side
          permissions and validated contracts.
        </p>
      </div>
    </main>
  );
}
function NotFound() {
  return (
    <main className="document">
      <h1>Page not found</h1>
      <Link to="/">Return to workspace</Link>
    </main>
  );
}
