import { Suspense, lazy } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import ProtectedRoute from './components/ProtectedRoute';
import Layout from './components/Layout';
import MarketingLayout from './components/MarketingLayout';
import { LoadingPanel } from './components/Spinner';

// Login and NotFound stay EAGER: login is the most common entry for a returning
// merchant, and paying a round-trip to render it would be a regression for the
// path people use most.
import Login from './pages/Login';
import NotFound from './pages/NotFound';

// Every other dashboard page is lazy. They used to be static imports, which put
// all eighteen of them — plus the charting library they pull in — into the entry
// chunk. That meant a signed-out visitor reading the landing page downloaded the
// entire authenticated product before they could see a headline.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const CreatePayment = lazy(() => import('./pages/CreatePayment'));
const Payments = lazy(() => import('./pages/Payments'));
const PaymentDetail = lazy(() => import('./pages/PaymentDetail'));
const Payouts = lazy(() => import('./pages/Payouts'));
const ApiKeys = lazy(() => import('./pages/ApiKeys'));
const PaymentLinks = lazy(() => import('./pages/PaymentLinks'));
const Invoices = lazy(() => import('./pages/Invoices'));
const Subscriptions = lazy(() => import('./pages/Subscriptions'));
const UnexpectedDeposits = lazy(() => import('./pages/UnexpectedDeposits'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Settings = lazy(() => import('./pages/Settings'));
const WebhookLogs = lazy(() => import('./pages/WebhookLogs'));
const Commission = lazy(() => import('./pages/Commission'));
const Reports = lazy(() => import('./pages/Reports'));
const ApiDocs = lazy(() => import('./pages/ApiDocs'));

// Public marketing pages are lazy so the signed-in bundle does not carry the
// landing page, and a returning merchant does not download a sales site.
const Landing = lazy(() => import('./pages/public/Landing'));
const Pricing = lazy(() => import('./pages/public/Pricing'));
const Developers = lazy(() => import('./pages/public/Developers'));
const Signup = lazy(() => import('./pages/public/Signup'));
const CheckEmail = lazy(() => import('./pages/public/CheckEmail'));
const VerifyEmail = lazy(() => import('./pages/public/VerifyEmail'));
const ForgotPassword = lazy(() => import('./pages/public/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/public/ResetPassword'));
// Hosted checkout. Its own route with NO chrome and no auth: a customer paying
// a link has no account and must never be redirected to a login screen.
const Checkout = lazy(() => import('./pages/public/Checkout'));

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
          <Suspense fallback={<LoadingPanel />}>
            <Routes>
              {/* ---- Public marketing site (header + footer chrome) ---- */}
              <Route element={<MarketingLayout />}>
                <Route path="/" element={<Landing />} />
                <Route path="/pricing" element={<Pricing />} />
                <Route path="/developers" element={<Developers />} />
              </Route>

              {/* ---- Auth funnel (full-bleed split shell, no chrome) ---- */}
              <Route path="/login" element={<Login />} />
              <Route path="/signup" element={<Signup />} />
              <Route path="/check-email" element={<CheckEmail />} />
              <Route path="/verify-email" element={<VerifyEmail />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />

              {/* ---- Hosted checkout (public, unauthenticated) ---- */}
              <Route path="/pay/:token" element={<Checkout />} />

              {/* ---- Dashboard ---- */}
              <Route element={<ProtectedRoute />}>
                <Route element={<Layout />}>
                  <Route path="/onboarding" element={<Onboarding />} />
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/payments/new" element={<CreatePayment />} />
                  <Route path="/payments" element={<Payments />} />
                  <Route path="/payment-links" element={<PaymentLinks />} />
                  <Route path="/invoices" element={<Invoices />} />
                  <Route path="/subscriptions" element={<Subscriptions />} />
                  <Route path="/payments/:id" element={<PaymentDetail />} />
                  <Route path="/payouts" element={<Payouts />} />
                  <Route path="/unexpected-deposits" element={<UnexpectedDeposits />} />
                  <Route path="/reports" element={<Reports />} />
                  <Route path="/commission" element={<Commission />} />
                  <Route path="/api-keys" element={<ApiKeys />} />
                  <Route path="/webhook-logs" element={<WebhookLogs />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/docs" element={<ApiDocs />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
