import Link from 'next/link';

const CARDS = [
  { href: '/admin/tasks',     title: 'Tasks',       desc: 'Assign tasks to staff and track completion.' },
  { href: '/admin/reminders', title: 'Reminders',   desc: 'Your personal reminders — payroll, sales tax, ordering supplies.' },
  { href: '/admin/chat-logs', title: 'Chat Logs',   desc: 'Review the AI assistant chat history.' },
  { href: '/admin/documents', title: 'Documents',   desc: 'Company documents and shared files.' },
  { href: '/admin/settings',  title: 'Permissions', desc: 'Manage staff roles, access, and which tabs each role sees.' },
];

export default function AdminDashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">Dashboard</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="block bg-white border border-gray-200 rounded-lg p-4 hover:border-brand-500 hover:shadow-sm transition"
          >
            <div className="font-semibold text-brand-800">{c.title}</div>
            <div className="text-sm text-gray-500 mt-1">{c.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
