import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Zero-Trust AI Studio (Next.js)",
  description: "Modular Zero-Trust AI App Builder & Sandbox Studio",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 h-screen flex flex-col font-sans overflow-hidden">
        {children}
      </body>
    </html>
  );
}