import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

/*
 * Typography: Satoshi for the interface, JetBrains Mono for every identifier,
 * timestamp and figure. Satoshi is a grotesque with enough character to not read
 * as a default, and it stays legible at the small sizes an operations console
 * lives at. Serifs are deliberately absent; this is software, not an essay.
 */
const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "ParcelPilot Support Console",
  description:
    "Policy-aware support agent for ParcelPilot: source precedence, account-scoped data access, and confirmed actions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} h-full antialiased`}>
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link
          href="https://api.fontshare.com/v2/css?f[]=satoshi@400,500,700,900&display=swap"
          rel="stylesheet"
        />
        <style>{`:root{--font-ui:"Satoshi","Segoe UI",system-ui,-apple-system,sans-serif;}`}</style>
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
