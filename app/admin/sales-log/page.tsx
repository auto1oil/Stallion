import SalesLog from '@/components/SalesLog';
import AdminSubNav from '@/components/AdminSubNav';

export default function AdminSalesLogPage() {
  return (
    <div>
      <AdminSubNav
        tabs={[
          { href: '/admin/sales-log', label: 'Visit log' },
          { href: '/admin/hours', label: 'Hours' },
          { href: '/admin/commissions', label: 'Commissions' },
        ]}
      />
      <SalesLog />
    </div>
  );
}
