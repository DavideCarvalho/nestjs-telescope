import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://davidecarvalho.github.io/nestjs-telescope'),
  title: {
    default: 'nestjs-telescope',
    template: '%s — nestjs-telescope',
  },
  description:
    'Laravel Telescope-style observability for NestJS — requests, queries, jobs, mail, cache, and exceptions correlated under one batch, plus live queue management and a health dashboard.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
