import Link from 'next/link';
import OrderForm from '@/components/OrderForm';

export const metadata = { title: 'Create order' };

export default function NewOrderPage() {
  return (
    <div>
      <Link href="/work-orders/orders" className="text-sm text-brand-700 hover:underline">← Orders</Link>
      <h1 className="text-2xl font-semibold mt-2 mb-1">Create order</h1>
      <p className="text-sm text-gray-600 mb-4">
        An order is a specific job. Tickets and hauler dispatches all point at
        one, so this is what an invoice gets checked against.
      </p>
      <OrderForm order={null} />
    </div>
  );
}
