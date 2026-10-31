import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { store } from './app/store';
import { App } from './app/App';
import { ErrorBoundary } from './lib/telemetry';
import './styles.css';
import './workspace.css';
const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={client}>
        <ErrorBoundary
          fallback={
            <div className="sq-initializing" role="alert">
              The workspace encountered an error. Reload the page to try again.
            </div>
          }
        >
          <App />
        </ErrorBoundary>
        <Toaster richColors position="bottom-right" />
      </QueryClientProvider>
    </Provider>
  </React.StrictMode>,
);
