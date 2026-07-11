import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { APP_VERSION } from "@/lib/version";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "dobrostanSTUDIOvisualisation",
  description: "Wizualizacja i edycja wnętrz z pomocą AI (FLUX Kontext + Claude)",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pl"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[#F4F4F2] text-[#1A1A1A]">
        {children}
        <span
          className="pointer-events-none fixed bottom-1.5 right-2 z-50 select-none text-[30px] font-medium leading-none tabular-nums text-[#a5a29a]/70"
          title="Wersja aplikacji — rośnie o 1 z każdą poprawką. Jeśli po wdrożeniu widzisz nowy numer, nowa wersja jest już na stronie."
        >
          v{APP_VERSION}
        </span>
      </body>
    </html>
  );
}
