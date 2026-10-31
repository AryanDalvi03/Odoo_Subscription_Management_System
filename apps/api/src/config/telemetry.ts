import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN)
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    beforeSend(event) {
      delete event.request;
      delete event.user;
      if (event.exception?.values)
        for (const exception of event.exception.values)
          if (exception.value)
            exception.value = exception.value.replace(
              /(mongodb(?:\+srv)?:\/\/)[^@\s]+@/gi,
              '$1[redacted]@',
            );
      return event;
    },
  });
export function captureFailure(error: unknown) {
  if (process.env.SENTRY_DSN) Sentry.captureException(error);
}
