import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ad QA — Commit Agency",
  description: "Social ad QA tool",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
