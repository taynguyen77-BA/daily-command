import type { Metadata } from "next";
import { Header } from "@/components/command-center/Header";
import { Nav } from "@/components/command-center/Nav";
import { AuthGate } from "@/components/command-center/AuthGate";
import "./globals.css";

export const metadata: Metadata = {
  title: "BA/PO/PM Command Center",
  description: "An AI-native daily command center for IT Business Analysts, Product Owners, and Project Managers.",
};

// L5 — team sign-in is opt-in (AUTH_ENABLED=true, read when the app is built — redeploy after
// changing it). Off: exactly the single-user layout. On: AuthGate settles who is signed in, and
// whose data the store opens, before anything renders.
const authEnabled = process.env.AUTH_ENABLED?.trim().toLowerCase() === "true";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg antialiased">
        {authEnabled ? (
          <AuthGate
            shell={
              <>
                <Header />
                <Nav />
              </>
            }
          >
            {children}
          </AuthGate>
        ) : (
          <>
            <Header />
            <Nav />
            <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 md:py-8">{children}</main>
          </>
        )}
      </body>
    </html>
  );
}
