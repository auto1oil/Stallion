import DeliveryDetail from '@/components/DeliveryDetail';

export default function DriverOrderDetail({ params }: { params: { id: string } }) {
  return <DeliveryDetail orderId={params.id} backHref="/driver" />;
}
