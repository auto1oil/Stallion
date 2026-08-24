import './globals.css';
import type { Metadata, Viewport } from 'next';
import PwaRegister from '@/components/PwaRegister';
import PullToRefresh from '@/components/PullToRefresh';
import SupportChatWidget from '@/components/SupportChatWidget';
import Watermark from '@/components/Watermark';
import AppUpdater from '@/components/AppUpdater';
import FloatingButton from '@/components/FloatingButton';
import LocationReporter from '@/components/LocationReporter';

export const metadata: Metadata = {
  title: 'Auto1 Oil Dispatch',
  description: 'Order tracking and delivery management',
  manifest: '/manifest.webmanifest',
  // iOS "Add to Home Screen" treats this app as a standalone PWA (no
  // Safari chrome) with the Auto 1 icon and our app title.
  appleWebApp: {
    capable: true,
    title: 'Auto 1 Oil',
    statusBarStyle: 'default',
  },
  icons: {
    icon: '/brand/auto1-circle.png',
    apple: '/brand/auto1-circle.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b3a8a',
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
        <SupportChatWidget />
        <Watermark />
      </body>
    </html>
  );
}
