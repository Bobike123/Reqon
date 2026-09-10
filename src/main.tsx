import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { AuthProvider } from './auth/AuthProvider.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'
import './index.css'

// One query client for the whole app. Server state lives here; there is no
// other state manager and the app does not need one.
const queryClient = new QueryClient()

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
