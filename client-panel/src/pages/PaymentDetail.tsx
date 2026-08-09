import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { getPayment } from '@/lib/api';
import { isTerminal } from '@/lib/format';
import type { Payment } from '@/types';
import PageHeader from '@/components/PageHeader';
import PaymentCard from '@/components/PaymentCard';
import { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';

export default function PaymentDetail() {
  const { id = '' } = useParams();

  const query = useQuery({
    queryKey: ['payment', id],
    queryFn: () => getPayment(id),
    enabled: Boolean(id),
    refetchInterval: (q) => {
      const data = q.state.data as Payment | undefined;
      if (data && isTerminal(data.status)) return false;
      return 8000;
    },
  });

  return (
    <>
      <PageHeader
        title="Payment detail"
        description={id}
        actions={
          <Link to="/payments" className="btn-ghost">
            <ArrowLeft size={16} /> Back
          </Link>
        }
      />

      {query.isLoading ? (
        <LoadingPanel />
      ) : query.isError ? (
        <ErrorState
          message={(query.error as { message?: string })?.message}
          onRetry={() => query.refetch()}
        />
      ) : query.data ? (
        <PaymentCard
          payment={query.data}
          polling={!isTerminal(query.data.status)}
        />
      ) : null}
    </>
  );
}
