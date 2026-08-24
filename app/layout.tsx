import './globals.css';
import type { Metadata, Viewport } from 'next';
import PwaRegister from '@/components/PwaRegister';
import PullToRefresh from '@/components/PullToRefresh';
import Watermark from '@/components/Watermark';
import AppUpdater from '@/components/AppUpdater';
import FloatingButton from '@/components/FloatingButton';
import LocationReporter from '@/components/LocationReporter';

export const metadata: Metadata = {
  title: 'Stallion Field Tickets',
  description: 'Order tracking and delivery management',
  manifest: '/manifest.webmanifest',
  // iOS "Add to Home Screen" treats this app as a standalone PWA (no
  // Safari chrome) with the Stallion icon and our app title.
  appleWebApp: {
    capable: true,
    title: 'Stallion',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/brand/stallion-mark.svg',
    apple: '/brand/stallion-mark.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#0F3D5C',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Apply the saved theme before paint to avoid a flash of light mode. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');if(t==='medium'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}`,
          }}
        />
      </head>
      <body>
        <PwaRegister />
        <AppUpdater />
        <LocationReporter />
        <PullToRefresh />
        {children}
        <FloatingButton />
        <Watermark />
      </body>
    </html>
  );
}
