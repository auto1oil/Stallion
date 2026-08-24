'use client';
import OrderStatusBoard from '@/components/OrderStatusBoard';

export default function SalesmanOrdersPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Orders</h1>
      <OrderStatusBoard />
    </div>
  );
}
