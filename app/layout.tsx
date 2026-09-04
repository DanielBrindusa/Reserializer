import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const publicBasePath = process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? '';
const publicAsset = (path: string) => `${publicBasePath}${path}`;

export const metadata: Metadata = {
  title: 'Desirializer',
  description:
    'Upload or paste JSON and inspect its nested structure with source line spans.',
  icons: {
    icon: [{ url: publicAsset('/desirializer-icon.png'), type: 'image/png' }],
    apple: [{ url: publicAsset('/desirializer-icon.png'), type: 'image/png' }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
