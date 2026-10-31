import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Layers3, ArrowRight, ShieldCheck } from 'lucide-react';
import { api, setAccessToken, errorMessage, type SessionUser } from '../lib/api';
import { signedIn } from '../app/store';
import { Button } from '../components/ui/button';
const schema = z.object({
  name: z.string().optional(),
  email: z.string(),
  password: z.string(),
  setupToken: z.string().optional(),
});
export function AuthPage({
  mode,
}: {
  mode: 'login' | 'register' | 'forgot-password' | 'reset-password' | 'verify-email' | 'setup';
}) {
  const [params] = useSearchParams();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [needsSetup, setNeedsSetup] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '', setupToken: '' },
  });
  useEffect(() => {
    void api
      .get('/auth/setup-status')
      .then((response) => setNeedsSetup(response.data.data.required))
      .catch(() => {});
  }, []);
  const title = {
    login: 'Welcome back.',
    register: 'Start your workspace journey.',
    setup: 'Create your administrator.',
    'forgot-password': 'Reset your password.',
    'reset-password': 'Choose a new password.',
    'verify-email': 'Verify your email.',
  }[mode];
  const submit = handleSubmit(async (values) => {
    setError('');
    setMessage('');
    try {
      if (
        ['register', 'setup', 'reset-password'].includes(mode) &&
        !/^(?=.*[a-z])(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{9,128}$/.test(values.password)
      )
        throw new Error(
          'Use at least 9 characters with uppercase, lowercase and a special character.',
        );
      const payload =
        mode === 'login'
          ? { email: values.email, password: values.password }
          : mode === 'register'
            ? { name: values.name, email: values.email, password: values.password }
            : mode === 'setup'
              ? {
                  name: values.name,
                  email: values.email,
                  password: values.password,
                  ...(values.setupToken ? { setupToken: values.setupToken } : {}),
                }
              : mode === 'forgot-password'
                ? { email: values.email }
                : mode === 'reset-password'
                  ? { token: params.get('token'), password: values.password }
                  : { token: params.get('token') };
      const response = await api.post(`/auth/${mode}`, payload);
      const result = response.data.data as {
        user?: SessionUser;
        accessToken?: string;
        message?: string;
      };
      if (result.user && result.accessToken) {
        setAccessToken(result.accessToken);
        dispatch(signedIn(result.user));
        navigate('/app');
      } else setMessage(result.message ?? 'Request completed.');
    } catch (error) {
      setError(errorMessage(error));
    }
  });
  return (
    <div className="auth-shell">
      <section className="auth-story">
        <Link className="brand" to="/">
          <span className="brand-icon">
            <Layers3 size={24} />
          </span>
          SubscriptIQ
        </Link>
        <span className="auth-eyebrow">BRIGHTLOOP SOFTWARE</span>
        <h1>
          Every subscription.
          <br />A clearer picture.
        </h1>
        <p>Keep your plans, customers and billing connected in one considered workspace.</p>
        <div className="auth-trust">
          <ShieldCheck size={20} />
          Secure access. Clear ownership. Reliable records.
        </div>
      </section>
      <main className="auth-content">
        <div className="auth-card">
          <span className="eyebrow">YOUR SUBSCRIPTION WORKSPACE</span>
          <h1>{title}</h1>
          <p>
            {mode === 'setup'
              ? 'Set up the first admin account. Choose your own credentials. Local setup is restricted to this computer.'
              : mode === 'login'
                ? 'Sign in to manage your subscription operations.'
                : 'Follow the steps below to securely manage your account.'}
          </p>
          {needsSetup && mode === 'login' && (
            <Link className="setup-callout" to="/setup-admin">
              First time here? Create the administrator <ArrowRight size={16} />
            </Link>
          )}
          {message ? (
            <div className="success" role="status">
              {message}
              <p>Email delivery in local development is saved in the server’s var/mail folder.</p>
              <Link to="/login">Back to sign in</Link>
            </div>
          ) : (
            <form onSubmit={submit}>
              {(mode === 'register' || mode === 'setup') && (
                <label>
                  Full name
                  <input {...register('name')} required minLength={2} autoComplete="name" />
                </label>
              )}
              {['login', 'register', 'forgot-password', 'setup'].includes(mode) && (
                <label>
                  Email address
                  <input type="email" {...register('email')} required autoComplete="email" />
                </label>
              )}
              {['login', 'register', 'reset-password', 'setup'].includes(mode) && (
                <label>
                  Password
                  <input
                    aria-label="Password"
                    type="password"
                    {...register('password')}
                    required
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                  {mode !== 'login' && (
                    <small>
                      At least 9 characters, uppercase, lowercase and a special character.
                    </small>
                  )}
                </label>
              )}
              {mode === 'setup' && (
                <label>
                  Server setup token <small>(required for production only)</small>
                  <input type="password" {...register('setupToken')} autoComplete="off" />
                </label>
              )}
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <Button disabled={isSubmitting} type="submit">
                {isSubmitting
                  ? 'Please wait…'
                  : mode === 'login'
                    ? 'Sign in'
                    : mode === 'verify-email'
                      ? 'Verify email'
                      : mode === 'setup'
                        ? 'Create administrator'
                        : 'Continue'}
                <ArrowRight size={16} />
              </Button>
            </form>
          )}
          <div className="auth-links">
            {mode === 'login' ? (
              <>
                <Link to="/forgot-password">Forgot password?</Link>
                <Link to="/register">Create customer account</Link>
              </>
            ) : (
              <Link to="/login">Back to sign in</Link>
            )}
          </div>
          <Link className="muted-link" to="/infrastructure">
            View infrastructure status
          </Link>
        </div>
      </main>
    </div>
  );
}
