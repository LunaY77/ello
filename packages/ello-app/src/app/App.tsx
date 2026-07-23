
import { AppProvider } from './AppProvider';
import { AppRouter } from './AppRouter';

import { ErrorBoundary } from '@/components/layout/ErrorBoundary';

export function App() {
  return (
    <ErrorBoundary>
      <AppProvider>
        <AppRouter />
      </AppProvider>
    </ErrorBoundary>
  );
}
