import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vera - Meta QA",
  description: "Social ad QA tool",
  icons: {
    icon: "/icon.png",
  },
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
