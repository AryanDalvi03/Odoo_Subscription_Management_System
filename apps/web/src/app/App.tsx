import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { useSelector, useDispatch } from 'react-redux';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Layers3,
  LayoutDashboard,
  Users,
  Package,
  CalendarDays,
  FileText,
  RefreshCw,
  Receipt,
  Wallet,
  Tag,
  ChartNoAxesCombined,
  ShieldCheck,
  Settings,
  LogOut,
  Menu,
  X,
  Search,
  ClipboardList,
  Bell,
  Activity,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, refreshSession, setAccessToken, errorMessage } from '../lib/api';
import { signedIn, signedOut, type RootState } from './store';
const AuthPage = lazy(() =>
  import('../pages/Auth').then((module) => ({ default: module.AuthPage })),
);
const ResourcePage = lazy(() =>
  import('../pages/Resources').then((module) => ({ default: module.ResourcePage })),
);
const Catalog = lazy(() =>
  import('../pages/Catalog').then((module) => ({ default: module.Catalog })),
);
const Foundation = lazy(() =>
  import('../pages/Foundation').then((module) => ({ default: module.Foundation })),
);
const Architecture = lazy(() =>
  import('../pages/Foundation').then((module) => ({ default: module.Architecture })),
);
import { ResourceForm } from '../components/ResourceForm';
const Dashboard = lazy(() => import('../pages/Dashboard'));
function SessionLoader() {
  const dispatch = useDispatch();
  const qc = useQueryClient();
  useEffect(() => {
    let mounted = true;
    void refreshSession()
      .then((result) => {
        if (mounted) dispatch(signedIn(result.user));
      })
      .catch(() => {
        if (mounted) dispatch(signedOut());
      });
    const expired = () => {
      dispatch(signedOut());
      qc.clear();
    };
    window.addEventListener('session-expired', expired);
    return () => {
      mounted = false;
      window.removeEventListener('session-expired', expired);
    };
  }, [dispatch, qc]);
  return null;
}
const navigation = [
  ['', 'Dashboard', LayoutDashboard],
  ['customers', 'Customers', Users],
  ['products', 'Products', Package],
  ['plans', 'Plans', CalendarDays],
  ['quotations', 'Quotations', FileText],
  ['subscriptions', 'Subscriptions', RefreshCw],
  ['invoices', 'Invoices', Receipt],
  ['payments', 'Payments', Wallet],
  ['discounts', 'Discounts', Tag],
  ['reports', 'Reports', ChartNoAxesCombined],
  ['staff', 'Staff management', ShieldCheck],
  ['settings', 'Settings', Settings],
] as const;
function Layout() {
  const user = useSelector((state: RootState) => state.session.user)!;
  const dispatch = useDispatch();
  const qc = useQueryClient();
  const [mobile, setMobile] = useState(false);
  const staffAllowed = (key: string) =>
    key === '' ||
    ['plans'].includes(key) ||
    (key === 'reports' && user.permissions.includes('reports:read')) ||
    user.permissions.includes(`${key}:${key === 'customers' ? 'read' : 'write'}`);
  const customerKeys = ['', 'plans', 'quotations', 'subscriptions', 'invoices', 'payments'];
  const links = navigation.filter(
    ([key]) =>
      user.role === 'admin' ||
      (user.role === 'staff' && staffAllowed(key)) ||
      (user.role === 'customer' && customerKeys.includes(key)),
  );
  const label = (key: string, title: string) =>
    user.role === 'customer'
      ? ({
          '': 'Overview',
          plans: 'Available plans',
          quotations: 'My quotations',
          subscriptions: 'My subscriptions',
          invoices: 'My invoices',
          payments: 'Payment history',
        }[key] ?? title)
      : title;
  return (
    <div className={`sq-app ${mobile ? 'mobile-open' : ''}`}>
      <aside className="sq-sidebar">
        <Link to="/app" className="brand" onClick={() => setMobile(false)}>
          <span className="brand-icon">
            <Layers3 size={23} />
          </span>
          Subscript<span>IQ</span>
        </Link>
        <div className="sq-workspace">
          <span className="sq-workspace-avatar">B</span>
          <div>
            Brightloop Software
            <small>{user.role[0]!.toUpperCase() + user.role.slice(1)} workspace</small>
          </div>
        </div>
        <span className="sq-nav-title">WORKSPACE</span>
        <nav aria-label="Workspace navigation">
          {links.map(([key, title, Icon]) => (
            <NavLink
              key={key}
              to={`/app${key ? `/${key}` : ''}`}
              end
              onClick={() => setMobile(false)}
            >
              <Icon size={17} />
              {label(key, title)}
            </NavLink>
          ))}
          <NavLink to="/app/profile" onClick={() => setMobile(false)}>
            <Users size={17} />
            My profile
          </NavLink>
        </nav>
        {user.role === 'admin' && (
          <>
            <span className="sq-nav-title">OPERATIONS</span>
            <nav aria-label="Operations navigation">
              {[
                ['taxes', 'Tax configuration', Receipt],
                ['quotation-templates', 'Quote templates', ClipboardList],
                ['change-requests', 'Change requests', RefreshCw],
                ['notifications', 'Email delivery', Bell],
                ['audit-logs', 'Audit trail', ShieldCheck],
                ['jobs/failed', 'Failed jobs', Activity],
              ].map(([key, title, Icon]) => {
                const Component = Icon as typeof Users;
                return (
                  <NavLink to={`/app/${key}`} key={String(key)} onClick={() => setMobile(false)}>
                    <Component size={16} />
                    {String(title)}
                  </NavLink>
                );
              })}
            </nav>
          </>
        )}
        {user.role === 'staff' && user.permissions.includes('subscriptions:write') && (
          <nav>
            <NavLink to="/app/change-requests">
              <RefreshCw size={17} />
              Change requests
            </NavLink>
          </nav>
        )}
        <div className="sq-user">
          <span>{user.name[0]}</span>
          <div>
            <strong>{user.name}</strong>
            <small>{user.email}</small>
          </div>
          <button
            aria-label="Sign out"
            onClick={() => {
              void api
                .post('/auth/logout')
                .catch(() => {})
                .finally(() => {
                  setAccessToken();
                  dispatch(signedOut());
                  qc.clear();
                });
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="sq-main">
        <header className="sq-header">
          <button
            className="sq-mobile-toggle"
            aria-label={mobile ? 'Close menu' : 'Open menu'}
            onClick={() => setMobile(!mobile)}
          >
            {mobile ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="sq-breadcrumb">
            Workspace <span>/</span> <strong>Brightloop Software</strong>
          </div>
          <div className="sq-header-right">
            <span className="sq-environment">
              <span />
              Connected workspace
            </span>
            <Link to="/app/profile" className="sq-avatar" aria-label="Your profile">
              {user.name[0]}
            </Link>
          </div>
        </header>
        <Suspense fallback={<div className="sq-skeleton">Loading your workspace…</div>}>
          <Outlet />
        </Suspense>
        <footer className="sq-footer">
          <span>© {new Date().getFullYear()} Brightloop Software</span>
          <Link to="/infrastructure">Service status</Link>
        </footer>
      </main>
    </div>
  );
}
function Protected() {
  const state = useSelector((state: RootState) => state.session);
  if (state.loading)
    return (
      <div className="sq-initializing" role="status">
        Opening your workspace…
      </div>
    );
  return state.user ? <Layout /> : <Navigate to="/login" replace />;
}
function Home() {
  const state = useSelector((state: RootState) => state.session);
  return state.loading ? (
    <div className="sq-initializing">Opening your workspace…</div>
  ) : (
    <Navigate to={state.user ? '/app' : '/login'} replace />
  );
}
function Gate({ resource, children }: { resource: string; children: React.ReactNode }) {
  const user = useSelector((state: RootState) => state.session.user)!;
  const admin = [
    'products',
    'discounts',
    'taxes',
    'staff',
    'settings',
    'quotation-templates',
    'audit-logs',
    'notifications',
    'jobs/failed',
  ];
  const forbidden =
    (admin.includes(resource) && user.role !== 'admin') ||
    (user.role === 'staff' && resource === 'reports' && !user.permissions.includes('reports:read'));
  return forbidden ? (
    <section className="sq-page">
      <h1>Access restricted</h1>
      <p>Your account does not have permission to open this page.</p>
      <Link to="/app">Back to overview</Link>
    </section>
  ) : (
    children
  );
}
function Profile() {
  const qc = useQueryClient();
  const profile = useQuery({
    queryKey: ['profile'],
    queryFn: async () => (await api.get('/me')).data.data,
  });
  return (
    <section className="sq-page">
      <div className="sq-page-heading">
        <div>
          <span className="eyebrow">YOUR ACCOUNT</span>
          <h1>Profile & billing details</h1>
          <p>Keep your contact and invoice information up to date.</p>
        </div>
      </div>
      <article className="sq-panel sq-profile">
        {profile.isPending ? (
          'Loading profile…'
        ) : profile.isError ? (
          <div className="error">{errorMessage(profile.error)}</div>
        ) : (
          <ResourceForm
            fields={[
              { name: 'name', label: 'Full name', required: true },
              { name: 'company', label: 'Company' },
              { name: 'phone', label: 'Phone' },
              { name: 'address', label: 'Billing address', type: 'textarea' },
              { name: 'taxId', label: 'Tax identifier' },
            ]}
            initial={{
              ...profile.data,
              ...profile.data.customer,
              _id: profile.data.id,
              name: profile.data.name,
            }}
            onSubmit={async (data) => {
              await api.patch('/me', data);
              toast.success('Profile updated');
              await qc.invalidateQueries({ queryKey: ['profile'] });
            }}
          />
        )}
      </article>
    </section>
  );
}
function SettingsPage() {
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await api.get('/settings')).data.data,
  });
  return (
    <section className="sq-page">
      <div className="sq-page-heading">
        <div>
          <span className="eyebrow">WORKSPACE CONFIGURATION</span>
          <h1>Business settings</h1>
          <p>Manage the defaults used by your team.</p>
        </div>
      </div>
      <article className="sq-panel sq-profile">
        {settings.isPending ? (
          'Loading settings…'
        ) : settings.isError ? (
          <div className="error">{errorMessage(settings.error)}</div>
        ) : (
          <ResourceForm
            fields={[
              {
                name: 'companyName',
                label: 'Company name',
                required: true,
                initial: 'Brightloop Software',
              },
              {
                name: 'defaultTermsDays',
                label: 'Default payment terms (days)',
                type: 'number',
                required: true,
                initial: 7,
              },
              { name: 'invoiceFooter', label: 'Invoice footer', type: 'textarea' },
            ]}
            initial={{
              _id: 'settings',
              ...settings.data.find((row: { key: string }) => row.key === 'business')?.value,
            }}
            onSubmit={async (data) => {
              await api.patch('/settings', data);
              toast.success('Business settings saved');
            }}
          />
        )}
      </article>
    </section>
  );
}
export function App() {
  return (
    <BrowserRouter>
      <SessionLoader />
      <Suspense fallback={<div className="sq-initializing">Opening your workspace…</div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          {(
            ['login', 'register', 'forgot-password', 'reset-password', 'verify-email'] as const
          ).map((mode) => (
            <Route path={`/${mode}`} element={<AuthPage mode={mode} />} key={mode} />
          ))}
          <Route path="/setup-admin" element={<AuthPage mode="setup" />} />
          <Route path="/infrastructure" element={<Foundation />} />
          <Route path="/architecture" element={<Architecture />} />
          <Route path="/app" element={<Protected />}>
            <Route index element={<Dashboard />} />
            <Route path="profile" element={<Profile />} />
            <Route
              path="settings"
              element={
                <Gate resource="settings">
                  <SettingsPage />
                </Gate>
              }
            />
            <Route path="plans" element={<PlansRoute />} />
            <Route
              path="reports"
              element={
                <Gate resource="reports">
                  <Dashboard reports />
                </Gate>
              }
            />
            {[
              'customers',
              'products',
              'quotations',
              'subscriptions',
              'invoices',
              'payments',
              'discounts',
              'taxes',
              'staff',
              'quotation-templates',
              'change-requests',
              'audit-logs',
              'notifications',
              'billing-records',
              'jobs/failed',
            ].map((resource) => (
              <Route
                path={resource}
                key={resource}
                element={
                  <Gate resource={resource}>
                    <ResourcePage key={resource} resource={resource} />
                  </Gate>
                }
              />
            ))}
          </Route>
          <Route
            path="*"
            element={
              <div className="sq-initializing">
                <h1>Page not found</h1>
                <Link to="/">Back to workspace</Link>
              </div>
            }
          />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
function PlansRoute() {
  const user = useSelector((state: RootState) => state.session.user)!;
  return user.role === 'customer' ? <Catalog /> : <ResourcePage resource="plans" />;
}
