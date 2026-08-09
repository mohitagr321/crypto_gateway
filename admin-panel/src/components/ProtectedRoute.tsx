import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import type { Role } from '@/types';

/**
 * Guards a route subtree. When `roles` is provided, the current user's role
 * must be included or they're redirected to the dashboard.
 */
export default function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { isAuthenticated, role } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (roles && (!role || !roles.includes(role))) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
