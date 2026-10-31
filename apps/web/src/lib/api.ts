import axios from 'axios';
const baseURL = import.meta.env.VITE_API_URL ?? '/api';
export const api = axios.create({ baseURL, withCredentials: true, timeout: 15000 });
let accessToken: string | undefined;
type LoginResult = { user: SessionUser; accessToken: string };
export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'staff' | 'customer';
  permissions: string[];
};
export function setAccessToken(token?: string) {
  accessToken = token;
}
let refreshing: Promise<LoginResult> | undefined;
export async function refreshSession() {
  if (!refreshing)
    refreshing = axios
      .post<{ data: LoginResult }>(
        `${baseURL}/auth/refresh`,
        {},
        { withCredentials: true, timeout: 10000 },
      )
      .then((response) => {
        accessToken = response.data.data.accessToken;
        return response.data.data;
      })
      .finally(() => {
        refreshing = undefined;
      });
  return refreshing;
}
api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (
      error.response?.status === 401 &&
      config &&
      !config._retried &&
      !config.url.startsWith('/auth/')
    ) {
      config._retried = true;
      try {
        await refreshSession();
        return api(config);
      } catch {
        accessToken = undefined;
        window.dispatchEvent(new Event('session-expired'));
      }
    }
    return Promise.reject(error);
  },
);
import type { Row } from './types';
export type { Row } from './types';
export type ListResult = { data: Row[]; meta?: { total: number; page: number; pageSize: number } };
export { errorMessage } from './errors';
export const money = (minor: unknown) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(minor ?? 0) / 100);
export async function download(path: string, filename: string) {
  const response = await api.get(path, { responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const command = (path: string, body: unknown = {}) =>
  api.post(path, body, { headers: { 'Idempotency-Key': crypto.randomUUID() } });
