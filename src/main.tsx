import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { isPermissionError } from './data/errors.ts'
import { queryKeys } from './data/queryKeys.ts'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import './index.css'

// One query client for the whole app. Server state lives here; there is no
// other state manager and the app does not need one.
const queryClient: QueryClient = new QueryClient({
  mutationCache: new MutationCache({
    // A refusal can mean this person's roles changed since the screen loaded —
    // the President took one away. Re-read their roles so the screens stop
    // offering what is no longer allowed. The refusal itself is still shown
    // by the screen that made the request. (Role mutations also refresh roles
    // themselves when they settle; the overlap is deliberate and TanStack
    // Query merges the two into one request.)
    onError: (error) => {
      if (isPermissionError(error)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.memberRoles })
      }
    },
  }),
})

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('No #root element in index.html — cannot mount the app.')
}

createRoot(rootElement).render(
  <StrictMode>
    {/* Outermost boundary: catches anything, including a provider blowing up,
        so the app can never render a blank white page. */}
    <ErrorBoundary>
      {/* AuthProvider is inside QueryClientProvider because signing out clears
          the query cache. */}
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
