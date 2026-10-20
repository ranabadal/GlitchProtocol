import type { Metadata, Viewport } from "next";
import { CityBackdrop } from "@/components/CityBackdrop";
import "./globals.css";

export const metadata: Metadata = {
  title: "GLITCH PROTOCOL · Neon City",
  description: "NULL ne Neon City hack kar li hai. Robots se lado, vaults hack karo, data cores uplink tak pahunchao.",
};

export const viewport: Viewport = {
  themeColor: "#010506",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="hi-Latn">
      <body>
        <CityBackdrop />
        {children}
        <div className="scanlines" aria-hidden />
      </body>
    </html>
  );
}
