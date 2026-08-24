import DeliveryDetail from '@/components/DeliveryDetail';

// Admins can mark a dispatched order delivered and collect a signature — the
// same flow drivers use.
export default function AdminDeliverPage({ params }: { params: { id: string } }) {
  return <DeliveryDetail orderId={params.id} backHref="/admin" />;
}
