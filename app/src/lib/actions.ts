"use client";

import { encodeFunctionData, erc20Abi, keccak256, toHex, type Address, type Hex } from "viem";
import { DEPLOYMENT } from "./config";
import { channelManagerAbi, keyringValidatorAbi } from "./contracts/abis";
import { publicClient, smartSigner, submitOp, type CardConfirm, type LocalWallet } from "./client";
import { execBatch, execCall } from "./userop";

/** 以權限矩陣自動選擇簽署方式並送出主帳戶 UserOp */
export async function runOp(wallet: LocalWallet, callData: Hex, confirmOnCard: CardConfirm) {
  const { signer, needs } = await smartSigner(wallet.address, callData, wallet.passkeys, confirmOnCard);
  const res = await submitOp({ sender: wallet.address, validator: DEPLOYMENT.keyring, callData, signer });
  return { ...res, needs };
}

export type Policy = {
  token: Address;
  perTxLimit: bigint;
  dailyLimit: bigint;
  confirmThreshold: bigint;
  validUntil: number;
  settlement: Address;
};

/** 建立支出通道並撥款（同一筆 batch：通道地址可事先由 CREATE2 算出） */
export async function createChannelWithFunding(
  wallet: LocalWallet,
  p: { channelType: number; operator: Address; policy: Policy; salt: Hex; funding: bigint },
  confirmOnCard: CardConfirm,
) {
  const channel = await publicClient.readContract({
    address: DEPLOYMENT.channelManager,
    abi: channelManagerAbi,
    functionName: "channelAddress",
    args: [wallet.address, p.salt],
  });
  const create = encodeFunctionData({
    abi: channelManagerAbi,
    functionName: "createChannel",
    args: [p.channelType, p.operator, p.policy, p.salt],
  });
  const execs = [{ target: DEPLOYMENT.channelManager, value: 0n, data: create }];
  if (p.funding > 0n) {
    execs.push({
      target: DEPLOYMENT.twdc,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [channel, p.funding] }),
    });
  }
  const res = await runOp(wallet, execBatch(execs), confirmOnCard);
  return { ...res, channel };
}

export function transferCall(to: Address, amount: bigint): Hex {
  return execCall(DEPLOYMENT.twdc, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }));
}

export function randomSalt(tag: string): Hex {
  return keccak256(toHex(`${tag}|${Date.now()}|${Math.random()}`));
}

// ───────────────────────── 本機排程紀錄（Scheduled 事件不含 payload） ─────────────────────────

export type LocalSchedule = { hash: Hex; action: number; payload: Hex; label: string; readyAt: number; account: Address };
const SK = "cafeca.schedules.v1";

export function loadSchedules(account: Address): LocalSchedule[] {
  try {
    return (JSON.parse(localStorage.getItem(SK) ?? "[]") as LocalSchedule[]).filter((s) => s.account === account);
  } catch {
    return [];
  }
}

export function saveSchedule(s: LocalSchedule) {
  try {
    const all = JSON.parse(localStorage.getItem(SK) ?? "[]") as LocalSchedule[];
    localStorage.setItem(SK, JSON.stringify([s, ...all.filter((x) => x.hash !== s.hash)]));
  } catch {
    /* ignore */
  }
}

export function removeSchedule(hash: Hex) {
  try {
    const all = JSON.parse(localStorage.getItem(SK) ?? "[]") as LocalSchedule[];
    localStorage.setItem(SK, JSON.stringify(all.filter((x) => x.hash !== hash)));
  } catch {
    /* ignore */
  }
}

export async function scheduledReadyAt(account: Address, hash: Hex): Promise<number> {
  return publicClient.readContract({
    address: DEPLOYMENT.keyring,
    abi: keyringValidatorAbi,
    functionName: "scheduledAt",
    args: [hash, account],
  });
}
