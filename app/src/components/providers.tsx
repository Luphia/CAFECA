"use client";

import type { ReactNode } from "react";
import { CardProvider } from "./card-provider";
import { ToastProvider } from "./ui";
import { WalletProvider } from "./wallet-provider";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <WalletProvider>
        <CardProvider>{children}</CardProvider>
      </WalletProvider>
    </ToastProvider>
  );
}
