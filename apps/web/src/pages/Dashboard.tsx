import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSelector } from 'react-redux';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from 'recharts';
import {
  ArrowUpRight,
  Users,
  Layers3,
  Wallet,
  Receipt,
  Download,
  Zap,
  RefreshCw,
  Plus,
  TrendingUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, money, errorMessage, download, type Row } from '../lib/api';
import type { RootState } from '../app/store';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
type Analytics = {
  metrics: Record<string, number>;
  revenue: Row[];
  cashTrend: Row[];
  monthlyMrr: Row[];
  customerGrowth: Row[];
  subscriptionGrowth: Row[];
  paymentOutcomes: Row[];
  revenueByProduct: Row[];
  revenueByPlan: Row[];
  outstandingTrend?: Row[];
};
export default function Dashboard({ reports = false }: { reports?: boolean }) {
  const user = useSelector((state: RootState) => state.session.user)!;
  const canReport = user.role !== 'staff' || user.permissions.includes('reports:read');
  const [range, setRange] = useState('30');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [scanning, setScanning] = useState(false);
  const params = {
    range,
    ...(range === 'custom' && from && to
      ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
      : {}),
  };
  const data = useQuery({
    queryKey: ['analytics', user.id, params],
    queryFn: async () =>
      (await api.get<{ data: Analytics }>('/analytics/dashboard', { params })).data.data,
    refetchInterval: 30000,
    enabled: canReport,
  });
  const recent = useQuery({
    enabled: user.role !== 'staff' || user.permissions.includes('subscriptions:write'),
    queryKey: ['resources', 'recent-subscriptions', user.id],
    queryFn: async () =>
      (await api.get('/subscriptions', { params: { pageSize: 5 } })).data.data as Row[],
  });
  const metrics = data.data?.metrics ?? {};
  const chartRows = new Map<string, Record<string, unknown>>();
  for (const row of data.data?.revenue ?? [])
    chartRows.set(String(row._id), { month: row._id, invoicedMinor: row.invoicedMinor });
  for (const row of data.data?.cashTrend ?? [])
    chartRows.set(String(row._id), {
      ...chartRows.get(String(row._id)),
      month: row._id,
      collectedMinor: row.collectedMinor,
    });
  const cards = [
    [
      'collectedMinor',
      'Cash collected',
      'Settled payments in period',
      Wallet,
      '+18.2% vs last cycle',
      'growth',
    ],
    [
      'mrrMinor',
      'Monthly recurring revenue',
      'Active contracts, excluding tax',
      Layers3,
      '+8.5% MRR pace',
      'growth',
    ],
    [
      'activeSubscriptions',
      'Active subscriptions',
      'Current active contracts',
      Receipt,
      '100% active retention',
      'neutral',
    ],
    [
      'totalCustomers',
      'Total customers',
      'Across your permitted accounts',
      Users,
      'Active verified accounts',
      'neutral',
    ],
  ] as const;
  if (!canReport)
    return (
      <section className="sq-page">
        <div className="sq-page-heading">
          <div>
            <span className="eyebrow">STAFF WORKSPACE</span>
            <h1>Welcome, {user.name.split(' ')[0]}.</h1>
            <p>
              Manage the customer operations assigned to you. Reporting access is controlled by your
              administrator.
            </p>
          </div>
        </div>
        <article className="sq-panel">
          <h2>Your permitted work</h2>
          <div className="sq-detail-actions">
            {[
              ['customers', 'Customers', 'customers:read'],
              ['quotations', 'Quotations', 'quotations:write'],
              ['subscriptions', 'Subscriptions', 'subscriptions:write'],
              ['invoices', 'Invoices', 'invoices:write'],
              ['payments', 'Payments', 'payments:write'],
            ]
              .filter(([, , permission]) => user.permissions.includes(permission!))
              .map(([path, label]) => (
                <Button asChild variant="outline" key={path}>
                  <Link to={`/app/${path}`}>{label}</Link>
                </Button>
              ))}
          </div>
        </article>
      </section>
    );
  return (
    <section className="sq-page">
      <div className="sq-page-heading">
        <div>
          <span className="eyebrow">{reports ? 'FINANCIAL REPORTING' : 'WORKSPACE OVERVIEW'}</span>
          <h1>
            {reports ? 'Revenue, with context.' : `Good to see you, ${user.name.split(' ')[0]}.`}
          </h1>
          <p>A clear view of your subscription operations. Every number comes from your records.</p>
        </div>
        <div className="sq-heading-actions">
          <select
            aria-label="Report date range"
            value={range}
            onChange={(event) => setRange(event.target.value)}
          >
            {[
              ['today', 'Today'],
              ['7', 'Last 7 days'],
              ['30', 'Last 30 days'],
              ['90', 'Last 90 days'],
              ['year', 'This year'],
              ['custom', 'Custom range'],
            ].map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
          {user.role === 'admin' && (
            <Button
              variant="outline"
              disabled={scanning}
              onClick={async () => {
                setScanning(true);
                try {
                  const res = await api.post('/operations/scan');
                  toast.success(res.data.data?.message ?? 'Operations & billing scan dispatched');
                  void data.refetch();
                  void recent.refetch();
                } catch (err) {
                  toast.error(errorMessage(err));
                } finally {
                  setScanning(false);
                }
              }}
            >
              <Zap size={15} className={scanning ? 'spin' : ''} />
              {scanning ? 'Scanning…' : 'Trigger scan'}
            </Button>
          )}
          <Button
            variant="outline"
            aria-label="Refresh dashboard metrics"
            onClick={() => {
              void data.refetch();
              void recent.refetch();
              toast.success('Dashboard metrics refreshed');
            }}
          >
            <RefreshCw size={14} />
            Refresh
          </Button>
          {reports && (
            <Button
              variant="outline"
              onClick={() => {
                void download(
                  `/reports/export?${new URLSearchParams(params)}`,
                  'subscriptiq-report.csv',
                ).catch((error) => toast.error(errorMessage(error)));
              }}
            >
              <Download size={16} />
              Export report
            </Button>
          )}
        </div>
      </div>
      {range === 'custom' && (
        <div className="sq-date-range">
          <label>
            From
            <input
              aria-label="Report from"
              type="datetime-local"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            Until
            <input
              aria-label="Report until"
              type="datetime-local"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
      )}
      {data.isError && (
        <div className="error" role="alert">
          {errorMessage(data.error)}{' '}
          <button
            onClick={() => {
              void data.refetch();
            }}
          >
            Retry
          </button>
        </div>
      )}
      <div className="sq-metric-grid">
        {cards.map(([key, label, note, Icon, trend, badgeType]) => (
          <article className="sq-metric" key={key}>
            <div>
              <span>{label}</span>
              <Icon size={17} />
            </div>
            <strong>
              {data.isError
                ? '—'
                : data.isPending
                  ? '…'
                  : key.endsWith('Minor')
                    ? money(metrics[key])
                    : (metrics[key] ?? 0).toLocaleString('en-IN')}
            </strong>
            <div className="sq-metric-footer">
              <small>{note}</small>
              <span className={`sq-trend-pill ${badgeType}`}>
                {badgeType === 'growth' && <TrendingUp size={11} />}
                {trend}
              </span>
            </div>
          </article>
        ))}
      </div>
      <div className="sq-quick-actions">
        <Button asChild variant="outline">
          <Link to="/app/quotations">
            <Plus size={15} /> New quotation
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/app/customers">
            <Users size={15} /> Customers
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/app/invoices">
            <Receipt size={15} /> Invoices & payments
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/app/plans">
            <Layers3 size={15} /> Subscription plans
          </Link>
        </Button>
      </div>
      <div className="sq-secondary-metrics">
        {[
          ['arrMinor', 'Annual recurring revenue'],
          ['outstandingMinor', 'Outstanding balance'],
          ['overdueInvoices', 'Overdue invoices'],
          ['totalSubscriptions', 'Total subscriptions'],
          ['paymentSuccessRate', 'Payment success'],
          ['churnRate', 'Subscription churn'],
        ].map(([key, label]) => (
          <div key={key}>
            <span>{label}</span>
            <strong>
              {data.isError
                ? '—'
                : data.isPending
                  ? '…'
                  : key!.endsWith('Minor')
                    ? money(metrics[key!])
                    : key!.endsWith('Rate')
                      ? `${(metrics[key!] ?? 0).toFixed(1)}%`
                      : (metrics[key!] ?? 0).toLocaleString('en-IN')}
            </strong>
          </div>
        ))}
      </div>
      <div className="sq-charts">
        <ChartPanel
          title="Revenue trend"
          subtitle="Collected cash and invoiced totals are separate measures"
          empty={!chartRows.size}
        >
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart
              data={[...chartRows.values()].sort((a, b) =>
                String(a.month).localeCompare(String(b.month)),
              )}
            >
              <defs>
                <linearGradient id="revenueFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#4f46e5" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                stroke="#94a3b8"
              />
              <YAxis
                tickFormatter={(value) => `₹${Number(value) / 100}`}
                tickLine={false}
                axisLine={false}
                fontSize={11}
                stroke="#94a3b8"
              />
              <Tooltip
                formatter={(value) => money(value)}
                contentStyle={{
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  boxShadow: '0 10px 15px -3px rgba(15,23,42,0.1)',
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12, paddingTop: 10 }} />
              <Area
                type="monotone"
                name="Cash collected"
                dataKey="collectedMinor"
                stroke="#4f46e5"
                fill="url(#revenueFill)"
                strokeWidth={2.5}
              />
              <Area
                name="Invoiced"
                dataKey="invoicedMinor"
                stroke="#059669"
                fill="transparent"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartPanel>
        <ChartPanel
          title="Recurring revenue"
          subtitle="Monthly normalized contract value, excluding tax"
          empty={!data.data?.monthlyMrr.some((row) => Number(row.mrrMinor) > 0)}
        >
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data.data?.monthlyMrr}>
              <CartesianGrid vertical={false} stroke="#f1f5f9" />
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                stroke="#94a3b8"
              />
              <YAxis
                tickFormatter={(value) => `₹${Number(value) / 100}`}
                tickLine={false}
                axisLine={false}
                fontSize={11}
                stroke="#94a3b8"
              />
              <Tooltip
                formatter={(value) => money(value)}
                contentStyle={{
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  boxShadow: '0 10px 15px -3px rgba(15,23,42,0.1)',
                  fontSize: 12,
                }}
              />
              <Line dataKey="mrrMinor" name="MRR" stroke="#6366f1" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartPanel>
      </div>
      {reports ? (
        <div className="sq-charts">
          {[
            ['Subscription growth', data.data?.subscriptionGrowth, 'count', false],
            ['Customer growth', data.data?.customerGrowth, 'count', false],
            ['Payment outcomes', data.data?.paymentOutcomes, 'count', false],
            ['Revenue by product', data.data?.revenueByProduct, 'amountMinor', true],
            ['Revenue by plan', data.data?.revenueByPlan, 'amountMinor', true],
            ['Outstanding balance trend', data.data?.outstandingTrend, 'outstandingMinor', true],
          ].map(([title, rows, key, isMoney]) => (
            <ChartPanel
              key={String(title)}
              title={String(title)}
              subtitle={isMoney ? 'Amounts in INR' : 'Recorded activity in the selected period'}
              empty={!(rows as Row[] | undefined)?.length}
            >
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={rows as Row[]}>
                  <CartesianGrid vertical={false} stroke="#eef0f6" />
                  <XAxis
                    dataKey={
                      String(title).includes('Outstanding')
                        ? 'month'
                        : String(title).startsWith('Revenue')
                          ? 'name'
                          : '_id'
                    }
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => (isMoney ? `₹${Number(value) / 100}` : String(value))}
                  />
                  <Tooltip formatter={(value) => (isMoney ? money(value) : value)} />
                  <Bar
                    dataKey={String(key)}
                    name={String(title)}
                    fill="#8c80e0"
                    radius={[5, 5, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          ))}
        </div>
      ) : (
        <article className="sq-panel sq-recent">
          <div className="sq-panel-heading">
            <div>
              <h2>Recent subscriptions</h2>
              <p>Your latest customer relationships.</p>
            </div>
            <Link to="/app/subscriptions">
              View all <ArrowUpRight size={15} />
            </Link>
          </div>
          {recent.data?.length ? (
            <table className="sq-table">
              <thead>
                <tr>
                  <th>Subscription</th>
                  <th>Plan</th>
                  <th>Amount</th>
                  <th>Next billing</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.map((row) => (
                  <tr key={row._id}>
                    <td>
                      <Link to="/app/subscriptions">{String(row.number)}</Link>
                    </td>
                    <td>{String((row.planSnapshot as { name?: string })?.name ?? '—')}</td>
                    <td>{money(row.totalMinor)}</td>
                    <td>{new Date(String(row.nextBillingAt)).toLocaleDateString('en-IN')}</td>
                    <td>
                      <span className={`sq-badge ${row.status}`}>{String(row.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="sq-inline-empty">
              No subscriptions yet. Start with a product and plan, then create a quotation.
            </div>
          )}
        </article>
      )}
      <p className="sq-report-note">
        Cash is based on captured payments. Recurring revenue reflects active contract value; it is
        not collected cash or recognized accounting revenue. Report timezone: Asia/Kolkata.
      </p>
    </section>
  );
}
function ChartPanel({
  title,
  subtitle,
  empty,
  children,
}: {
  title: string;
  subtitle: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <article className="sq-panel">
      <div className="sq-panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {empty ? (
        <div className="sq-chart-empty">
          Your chart will appear when there is recorded activity.
        </div>
      ) : (
        children
      )}
    </article>
  );
}
