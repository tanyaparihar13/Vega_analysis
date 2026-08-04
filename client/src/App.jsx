import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import SiteLayout from './site/SiteLayout';
import Home from './site/pages/Home';
import Features from './site/pages/Features';
import PricingPage from './site/pages/Pricing';
import ContactPage from './site/pages/Contact';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import PendingApproval from './pages/PendingApproval';
import AdminLogin from './pages/AdminLogin';
import Dashboard from './pages/Dashboard';
import AdminDashboard from './pages/AdminDashboard';
import OptionChainPage from './pages/OptionChainPage'; // NEW — option chain
import DashboardLayout from './components/layout/DashboardLayout';
import VegaAnalysis from './features/vegaAnalysis';
import GreeksPage from './features/greeks';
import OpenInterestPage from './features/openInterest';
import WatchlistPage from './features/watchlist';

function ProtectedRoute({ children, roles }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      {/*
        PUBLIC MARKETING SITE — the front door.

        These four pages share SiteLayout (navbar + footer + its own light
        background). They are the only routes a signed-out visitor is meant to
        browse; everything below still requires a session exactly as before.

        Login / Register / PendingApproval deliberately sit OUTSIDE this layout:
        they are focused single-purpose screens in the app's own visual
        language, and wrapping them in the marketing chrome would put a "Get
        Access" call to action next to the form the user is already filling in.
      */}
      <Route element={<SiteLayout />}>
        <Route path="/" element={<Home />} />
        <Route path="/features" element={<Features />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/contact" element={<ContactPage />} />
      </Route>

      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/pending-approval" element={<PendingApproval />} />
      {/*
        PASSWORD RESET — public by design.

        Both screens must be reachable by someone who cannot sign in, which is
        the entire premise, so neither sits behind ProtectedRoute. The security
        boundary is the emailed token itself: /reset-password/:token is useless
        without a token that is random, single-use, 30-minute-lived, and stored
        server-side only as a SHA-256. Sitting outside the layouts for the same
        reason Login and Register do — they are focused single-purpose screens,
        not marketing pages.
      */}
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password/:token" element={<ResetPassword />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute roles={['free', 'premium', 'admin']}>
            <Dashboard />
          </ProtectedRoute>
          
        }
      />
      {/*
        NEW — option chain.
        Roles match the /dashboard route on purpose: your existing pattern is
        "route open to all logged-in users, component decides what to show".
        Dashboard.jsx does exactly this with its isPremium check.

        A free user therefore reaches the page and sees the "premium required"
        banner explaining why there is no data. If instead you list only
        ['premium', 'admin'] here, a free user clicking the sidebar item is
        silently bounced to /dashboard with no explanation, which reads as a
        broken link.

        The data itself is safe either way — requirePremium guards the REST
        endpoints and the WebSocket rejects non-premium on the upgrade
        handshake. This choice only affects what the user is told.
      */}
      <Route
        path="/option-chain"
        element={
          <ProtectedRoute roles={['free', 'premium', 'admin']}>
            <OptionChainPage />
          </ProtectedRoute>
        }
      />
      {/*
        Admin console. Wrapped in DashboardLayout like every other feature page
        so it keeps the sidebar — previously it rendered bare, so landing on
        /admin left you with no navigation back to Vega Analysis.
        /admin/dashboard is an alias for the same screen.
      */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={['admin']}>
            <DashboardLayout><AdminDashboard /></DashboardLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/dashboard"
        element={
          <ProtectedRoute roles={['admin']}>
            <DashboardLayout><AdminDashboard /></DashboardLayout>
          </ProtectedRoute>
        }
      />

      {/*
        Feature pages render inside DashboardLayout so they keep the sidebar and
        top bar. /vega-analysis previously rendered bare, which is why it had no
        navigation at all once you landed on it.
      */}
      <Route
        path="/vega-analysis"
        element={
          <ProtectedRoute roles={['free', 'premium', 'admin']}>
            <DashboardLayout><VegaAnalysis /></DashboardLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/greeks"
        element={
          <ProtectedRoute roles={['free', 'premium', 'admin']}>
            <DashboardLayout><GreeksPage /></DashboardLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/analytics"
        element={
          <ProtectedRoute roles={['free', 'premium', 'admin']}>
            <DashboardLayout><OpenInterestPage /></DashboardLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/watchlist"
        element={
          <ProtectedRoute roles={['free', 'premium', 'admin']}>
            <DashboardLayout><WatchlistPage /></DashboardLayout>
          </ProtectedRoute>
        }
      />

      {/* Unknown URL -> public landing page. Sending it to /dashboard would
          bounce a signed-out visitor through the auth redirect for no reason. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}