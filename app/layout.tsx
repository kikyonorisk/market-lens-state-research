import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Market Lens｜AI 市场大势研判",
  description: "查看 A 股市场状态、证据来源、判断边界与重新评估条件。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
