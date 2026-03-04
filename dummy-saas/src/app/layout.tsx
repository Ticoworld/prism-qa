import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus — B2B Workspace Platform",
  description: "The all-in-one workspace for modern teams.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
