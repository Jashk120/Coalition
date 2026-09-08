import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coalition — Pool Dashboard",
  description:
    "Deterministic 4-agent pool flow: resolution, fill progress, and demo-loop trigger.",
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
