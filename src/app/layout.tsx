import type { Metadata } from "next";
import { Header } from "@/components/command-center/Header";
import { Nav } from "@/components/command-center/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "BA/PO/PM Command Center",
  description: "An AI-native daily command center for IT Business Analysts, Product Owners, and Project Managers.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg antialiased">
        <Header />
        <Nav />
        <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
