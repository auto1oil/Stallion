// Catalog of toggleable nav features, shown in the master-admin Settings tab and
// used by the nav bars to hide disabled tabs. Each feature's key is "role:href";
// a feature_flags row with enabled = false hides that tab from that role.

export type Role =
  | 'admin'
  | 'master_admin'
  | 'office'
  | 'driver'
  | 'contractor'
  | 'funder'
  | 'hauler'
  | 'mechanic'
  | 'labor'
  | 'customer';

export type FeatureGroup = 'admin' | 'office' | 'driver' | 'contractor' | 'funder' | 'hauler';
export type Feature = { key: string; label: string; group: FeatureGroup };

export const FEATURE_GROUP_TITLES: { group: FeatureGroup; title: string }[] = [
  { group: 'admin', title: 'Admin tabs' },
  { group: 'office', title: 'Office tabs' },
  { group: 'driver', title: 'Driver / crew tabs' },
  { group: 'contractor', title: 'Contractor tabs' },
  { group: 'funder', title: 'Funder tabs' },
  { group: 'hauler', title: 'Hauler tabs' },
];

// Map a profile role to its nav group key (admin + master_admin share the
// admin nav). Returns null for roles with no toggleable nav.
export function navGroupForRole(role: string): FeatureGroup | null {
  if (role === 'admin' || role === 'master_admin') return 'admin';
  if (role === 'office') return 'office';
  if (role === 'driver' || role === 'mechanic') return 'driver';
  if (role === 'contractor') return 'contractor';
  if (role === 'funder') return 'funder';
  if (role === 'hauler') return 'hauler';
  return null;
}

export const featureKey = (group: FeatureGroup, href: string) => `${group}:${href}`;

export const FEATURES: Feature[] = [
  // Admin
  { group: 'admin', key: 'admin:/work-orders/orders', label: 'Orders' },
  { group: 'admin', key: 'admin:/work-orders', label: 'Tickets' },
  { group: 'admin', key: 'admin:/admin', label: 'Deliveries' },
  { group: 'admin', key: 'admin:/admin/delivery-log', label: 'Delivery Log' },
  { group: 'admin', key: 'admin:/haulers', label: 'Haulers' },
  { group: 'admin', key: 'admin:/admin/customers', label: 'Customers' },
  { group: 'admin', key: 'admin:/admin/forms', label: 'Forms' },
  { group: 'admin', key: 'admin:/admin/documents', label: 'Documents' },
  { group: 'admin', key: 'admin:/admin/dashboard', label: 'Dashboard' },
  { group: 'admin', key: 'admin:/admin/po', label: 'PO #' },
  { group: 'admin', key: 'admin:/admin/hours', label: 'Time Clock' },
  { group: 'admin', key: 'admin:/admin/users', label: 'Users' },
  // Office
  { group: 'office', key: 'office:/work-orders/orders', label: 'Orders' },
  { group: 'office', key: 'office:/work-orders', label: 'Tickets' },
  { group: 'office', key: 'office:/haulers', label: 'Haulers' },
  { group: 'office', key: 'office:/driver/customers', label: 'Customers' },
  { group: 'office', key: 'office:/driver/hours', label: 'Hours' },
  { group: 'office', key: 'office:/tasks', label: 'Tasks' },
  { group: 'office', key: 'office:/reminders', label: 'Reminders' },
  // Driver / crew
  { group: 'driver', key: 'driver:/tickets', label: 'My Tickets' },
  { group: 'driver', key: 'driver:/tickets/new', label: 'New Ticket' },
  { group: 'driver', key: 'driver:/driver', label: 'Deliveries' },
  { group: 'driver', key: 'driver:/driver/delivery-log', label: 'Delivery Log' },
  { group: 'driver', key: 'driver:/driver/customers', label: 'Customers' },
  { group: 'driver', key: 'driver:/driver/hours', label: 'Hours' },
  { group: 'driver', key: 'driver:/tasks', label: 'Tasks' },
  { group: 'driver', key: 'driver:/reminders', label: 'Reminders' },
  // Contractor
  { group: 'contractor', key: 'contractor:/contractor', label: 'Work Orders' },
  { group: 'contractor', key: 'contractor:/contractor/approvals', label: 'Approvals' },
  { group: 'contractor', key: 'contractor:/contractor/rates', label: 'Rates' },
  { group: 'contractor', key: 'contractor:/messages', label: 'Messages' },
  // Funder
  { group: 'funder', key: 'funder:/funder', label: 'Orders' },
  { group: 'funder', key: 'funder:/funder/approve', label: 'Approve Funds' },
  // Hauler
  { group: 'hauler', key: 'hauler:/hauler', label: 'Loads' },
  { group: 'hauler', key: 'hauler:/tickets', label: 'Haul Tickets' },
  { group: 'hauler', key: 'hauler:/hauler/equipment', label: 'Trucks & Equipment' },
  { group: 'hauler', key: 'hauler:/hauler/availability', label: 'Availability' },
  { group: 'hauler', key: 'hauler:/messages', label: 'Messages' },
];
