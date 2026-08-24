// Catalog of toggleable nav features, shown in the master-admin Settings tab and
// used by the nav bars to hide disabled tabs. Each feature's key is "role:href";
// a feature_flags row with enabled = false hides that tab from that role.

export type FeatureGroup = 'admin' | 'salesman' | 'driver' | 'customer';
export type Feature = { key: string; label: string; group: FeatureGroup };

export const FEATURE_GROUP_TITLES: { group: FeatureGroup; title: string }[] = [
  { group: 'admin', title: 'Admin tabs' },
  { group: 'salesman', title: 'Salesman tabs' },
  { group: 'driver', title: 'Driver tabs' },
  { group: 'customer', title: 'Customer tabs' },
];

// Map a profile role to its nav group key (admin + master_admin share the
// admin nav). Returns null for roles with no toggleable nav.
export function navGroupForRole(role: string): FeatureGroup | null {
  if (role === 'admin' || role === 'master_admin') return 'admin';
  if (role === 'salesman') return 'salesman';
  if (role === 'driver' || role === 'mechanic') return 'driver';
  if (role === 'customer') return 'customer';
  return null;
}

export const featureKey = (group: FeatureGroup, href: string) => `${group}:${href}`;

export const FEATURES: Feature[] = [
  // Admin
  { group: 'admin', key: 'admin:/admin', label: 'Orders' },
  { group: 'admin', key: 'admin:/admin/customer-orders', label: 'Confirm' },
  { group: 'admin', key: 'admin:/admin/delivery-log', label: 'Delivery Log' },
  { group: 'admin', key: 'admin:/admin/customers', label: 'Customers' },
  { group: 'admin', key: 'admin:/admin/sales-log', label: 'Salesman' },
  { group: 'admin', key: 'admin:/admin/fuel-prices', label: 'Fuel' },
  { group: 'admin', key: 'admin:/admin/fuel-history', label: 'Fuel History' },
  { group: 'admin', key: 'admin:/admin/inventory', label: 'Inventory' },
  { group: 'admin', key: 'admin:/admin/bills', label: 'Bills' },
  { group: 'admin', key: 'admin:/admin/card-charges', label: 'Card Charges' },
  { group: 'admin', key: 'admin:/admin/forms', label: 'Forms' },
  { group: 'admin', key: 'admin:/admin/documents', label: 'Documents' },
  { group: 'admin', key: 'admin:/admin/chat-logs', label: 'Chat Logs' },
  { group: 'admin', key: 'admin:/admin/dashboard', label: 'Dashboard' },
  // Salesman
  { group: 'salesman', key: 'salesman:/salesman/orders', label: 'Orders' },
  { group: 'salesman', key: 'salesman:/salesman/order', label: 'Place Order' },
  { group: 'salesman', key: 'salesman:/salesman/all-customers', label: 'Customers' },
  { group: 'salesman', key: 'salesman:/salesman/customers', label: 'My Customers' },
  { group: 'salesman', key: 'salesman:/salesman/earnings', label: 'Commissions' },
  { group: 'salesman', key: 'salesman:/salesman/inventory', label: 'Inventory' },
  { group: 'salesman', key: 'salesman:/salesman/fuel', label: 'Fuel' },
  { group: 'salesman', key: 'salesman:/salesman/forms', label: 'Forms' },
  { group: 'salesman', key: 'salesman:/tasks', label: 'Tasks' },
  { group: 'salesman', key: 'salesman:/reminders', label: 'Reminders' },
  // Driver
  { group: 'driver', key: 'driver:/driver', label: 'Orders' },
  { group: 'driver', key: 'driver:/driver/delivery-log', label: 'Delivery Log' },
  { group: 'driver', key: 'driver:/driver/customers', label: 'Customers' },
  { group: 'driver', key: 'driver:/driver/inventory', label: 'Inventory' },
  { group: 'driver', key: 'driver:/driver/hours', label: 'My hours' },
  { group: 'driver', key: 'driver:/salesman/order', label: 'Place Order' },
  { group: 'driver', key: 'driver:/tasks', label: 'Tasks' },
  { group: 'driver', key: 'driver:/reminders', label: 'Reminders' },
  // Customer
  { group: 'customer', key: 'customer:/shop/account', label: 'My account' },
];
