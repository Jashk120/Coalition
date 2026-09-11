import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coalition — Pool Dashboard",
  description:
    "Deterministic 4-agent pool flow: resolution, fill progress, and demo-loop trigger.",
};

const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("coalition-theme");if(t!=="light"&&t!=="dark"){t="dark";}document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
