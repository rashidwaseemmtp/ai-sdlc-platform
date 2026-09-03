import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI SDLC Platform',
  description: 'AI-native software delivery organization',
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/projects', label: 'Projects' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/agents', label: 'Agents' },
  { href: '/runs', label: 'Agent runs' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="layout">
          <aside className="sidebar">
            <div className="brand">AI SDLC Platform</div>
            <div className="brand-sub">Delivery organization</div>
            <nav className="nav">
              {NAV.map((item) => (
                <a key={item.href} href={item.href}>{item.label}</a>
              ))}
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
