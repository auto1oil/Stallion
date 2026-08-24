import DeliveryDetail from '@/components/DeliveryDetail';

// Salesmen can mark a dispatched order delivered and collect a signature — the
// same flow drivers use.
export default function SalesmanDeliverPage({ params }: { params: { id: string } }) {
  return <DeliveryDetail orderId={params.id} backHref="/salesman/orders" />;
}
