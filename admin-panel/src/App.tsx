import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Layout from '@/components/Layout';
import ProtectedRoute from '@/components/ProtectedRoute';
import { AuthProvider } from '@/context/AuthContext';
import { ThemeProvider } from '@/context/ThemeContext';

import Analytics from '@/pages/Analytics';
import ClientDetail from '@/pages/ClientDetail';
import Clients from '@/pages/Clients';
import Commissions from '@/pages/Commissions';
import Dashboard from '@/pages/Dashboard';
import Login from '@/pages/Login';
import Payouts from '@/pages/Payouts';
import Revenue from '@/pages/Revenue';
import Transactions from '@/pages/Transactions';
import WalletBalances from '@/pages/WalletBalances';
import WebhookLogs from '@/pages/WebhookLogs';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />

              {/* Authenticated area */}
              <Route element={<ProtectedRoute />}>
                <Route element={<Layout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="clients" element={<Clients />} />
                  <Route path="clients/:id" element={<ClientDetail />} />
                  <Route path="transactions" element={<Transactions />} />
                  <Route path="payouts" element={<Payouts />} />
                  <Route path="revenue" element={<Revenue />} />
                  <Route path="webhook-logs" element={<WebhookLogs />} />
                  <Route path="wallets" element={<WalletBalances />} />
                  <Route path="analytics" element={<Analytics />} />

                  {/* super_admin only */}
                  <Route element={<ProtectedRoute roles={['super_admin']} />}>
                    <Route path="commissions" element={<Commissions />} />
                  </Route>
                </Route>
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
