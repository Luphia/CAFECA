"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { erc20Abi, type Address } from "viem";
import { DEPLOYMENT } from "@/lib/config";
import { attestationRegistryAbi, keyringValidatorAbi, recoveryValidatorAbi } from "@/lib/contracts/abis";
import { api, loadWallet, publicClient, type LocalWallet } from "@/lib/client";
import { encode1271 } from "@/lib/userop";
import { signWithPasskey } from "@/lib/webauthn";

type ChainState = {
  deployed: boolean;
  twdc: bigint;
  bolt: bigint;
  masterMode: boolean;
  level: number;
  recoveryPending: boolean;
  loaded: boolean;
};

type Ctx = {
  wallet: LocalWallet | null;
  hydrated: boolean;
  session: Address | null;
  handle: string | null;
  chain: ChainState;
  refresh: () => Promise<void>;
  refreshSession: () => Promise<void>;
  unlock: () => Promise<void>;
};

const EMPTY: ChainState = { deployed: false, twdc: 0n, bolt: 0n, masterMode: false, level: 0, recoveryPending: false, loaded: false };

const WalletCtx = createContext<Ctx | null>(null);

function subscribe(cb: () => void) {
  window.addEventListener("cafeca-wallet", cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener("cafeca-wallet", cb);
    window.removeEventListener("storage", cb);
  };
}

let cachedRaw: string | null = null;
let cachedWallet: LocalWallet | null = null;
function snapshot(): LocalWallet | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem("cafeca.wallet.v1");
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedWallet = loadWallet();
  }
  return cachedWallet;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useSyncExternalStore(subscribe, snapshot, () => null);
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const [session, setSession] = useState<Address | null>(null);
  const [handle, setHandle] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainState>(EMPTY);

  const refreshSession = useCallback(async () => {
    const me = await api<{ address: Address | null; handle: string | null }>("/api/auth/me").catch(() => ({ address: null, handle: null }));
    setSession(me.address);
    setHandle(me.handle);
  }, []);

  const refresh = useCallback(async () => {
    if (!wallet || !DEPLOYMENT.deployed) return;
    const a = wallet.address;
    try {
      const [code, twdc, bolt, st, att, pending] = await Promise.all([
        publicClient.getCode({ address: a }),
        publicClient.readContract({ address: DEPLOYMENT.twdc, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
        publicClient.getBalance({ address: a }),
        publicClient.readContract({ address: DEPLOYMENT.keyring, abi: keyringValidatorAbi, functionName: "accountState", args: [a] }),
        publicClient.readContract({ address: DEPLOYMENT.attestation, abi: attestationRegistryAbi, functionName: "levelOf", args: [a] }),
        publicClient.readContract({ address: DEPLOYMENT.recovery, abi: recoveryValidatorAbi, functionName: "isPending", args: [a] }),
      ]);
      setChain({
        deployed: !!code && code !== "0x",
        twdc,
        bolt,
        masterMode: st[1] > 0,
        level: att,
        recoveryPending: pending,
        loaded: true,
      });
    } catch (e) {
      console.warn("refresh failed", e);
      setChain((c) => ({ ...c, loaded: true }));
    }
  }, [wallet]);

  const unlock = useCallback(async () => {
    if (!wallet) throw new Error("尚未建立錢包");
    const { hash } = await api<{ hash: `0x${string}` }>(`/api/auth/challenge?address=${wallet.address}`);
    const { keyId, sig } = await signWithPasskey(hash, wallet.passkeys);
    await api("/api/auth/verify", { signature: encode1271(DEPLOYMENT.keyring, keyId, sig) });
    await refreshSession();
  }, [wallet, refreshSession]);

  useEffect(() => {
    // 首次載入時同步伺服器 session 與鏈上狀態（外部系統同步）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshSession();
  }, [refreshSession]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const value = useMemo(
    () => ({ wallet, hydrated, session, handle, chain, refresh, refreshSession, unlock }),
    [wallet, hydrated, session, handle, chain, refresh, refreshSession, unlock],
  );
  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}

export function useWallet() {
  const c = useContext(WalletCtx);
  if (!c) throw new Error("WalletProvider missing");
  return c;
}
