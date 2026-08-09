import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-50 px-4 text-center dark:bg-slate-950">
      <p className="text-6xl font-bold text-brand-600">404</p>
      <p className="text-slate-600 dark:text-slate-300">
        This page could not be found.
      </p>
      <Link to="/dashboard" className="btn-primary">
        Back to dashboard
      </Link>
    </div>
  );
}
