import * as Sentry from '@sentry/react';
if (import.meta.env.VITE_SENTRY_DSN)
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    environment: import.meta.env.MODE,
    beforeSend(event) {
      delete event.user;
      delete event.request;
      return event;
    },
  });
export { ErrorBoundary } from '@sentry/react';
