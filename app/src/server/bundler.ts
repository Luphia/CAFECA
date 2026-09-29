import "server-only";
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  decodeErrorResult,
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  numberToHex,
  pad,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { DEPLOYMENT } from "@/lib/config";
import {
  entryPointAbi,
  cafecaPaymasterAbi,
  keyringValidatorAbi,
  recoveryValidatorAbi,
  channelValidatorAbi,
  identityAccountFactoryAbi,
  cafecaAccountAbi,
} from "@/lib/contracts/abis";
import { nonceKey, type UserOp } from "@/lib/userop";
import { publicClient, operatorWallet, serialize, signerOf } from "./chain";
import { env } from "./env";
import { HttpError } from "./session";

const ALL_ERRORS = [
  ...entryPointAbi,
  ...keyringValidatorAbi,
  ...recoveryValidatorAbi,
  ...channelValidatorAbi,
  ...identityAccountFactoryAbi,
  ...cafecaAccountAbi,
].filter((x) => x.type === "error") as Abi;

const PM_VERIFICATION_GAS = 300_000n;
const PM_POSTOP_GAS = 100_000n;

function packUints(hi: bigint, lo: bigint): Hex {
  return pad(toHex((hi << 128n) | lo), { size: 32 });
}

function opForAbi(op: UserOp) {
  return {
    sender: op.sender,
    nonce: BigInt(op.nonce),
    initCode: op.initCode,
    callData: op.callData,
    accountGasLimits: op.accountGasLimits,
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: op.gasFees,
    paymasterAndData: op.paymasterAndData,
    signature: op.signature,
  };
}

/**
 * 交易額度只能由管理者調整：拒絕贊助任何「帳戶自行修改額度」的 UserOp。
 * KeyringValidator v2 在鏈上直接拒絕；v1（舊部署）靠這裡擋下，並由 paymaster 不贊助。
 */
export function assertNoSelfLimitChange(callData: Hex) {
  let execs: { target: Address; data: Hex }[] = [];
  try {
    const { functionName, args } = decodeFunctionData({ abi: cafecaAccountAbi, data: callData });
    if (functionName !== "execute") return;
    const [mode, ec] = args as [Hex, Hex];
    if (BigInt(mode) >> 248n === 1n) {
      const [list] = decodeAbiParameters([{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }], ec);
      execs = list.map((e) => ({ target: e.target, data: e.callData }));
    } else {
      execs = [{ target: `0x${ec.slice(2, 42)}` as Address, data: `0x${ec.slice(106)}` as Hex }];
    }
  } catch {
    return;
  }
  for (const e of execs) {
    if (e.target.toLowerCase() !== DEPLOYMENT.keyring.toLowerCase() || e.data.length < 10) continue;
    let fn: string;
    let fargs: readonly unknown[] = [];
    try {
      ({ functionName: fn, args: fargs = [] } = decodeFunctionData({ abi: keyringValidatorAbi, data: e.data }) as { functionName: string; args?: readonly unknown[] });
    } catch {
      continue;
    }
    const setLimitsAction = 2; // Action.SET_LIMITS
    if (fn === "setLimits" || ((fn === "schedule" || fn === "executeScheduled") && Number(fargs[0]) === setLimitsAction)) {
      throw new HttpError(403, "交易額度只能由 CAFECA 管理者調整，請聯絡客服");
    }
  }
}

export async function prepareUserOp(p: {
  sender: Address;
  validator: Address;
  callData: Hex;
  initCode?: Hex;
}): Promise<{ userOp: UserOp; userOpHash: Hex }> {
  assertNoSelfLimitChange(p.callData);
  const d = DEPLOYMENT;
  const nonce = await publicClient.readContract({
    address: d.entryPoint,
    abi: entryPointAbi,
    functionName: "getNonce",
    args: [p.sender, nonceKey(p.validator)],
  });
  const gasPrice = await publicClient.getGasPrice();
  const maxFee = (gasPrice * 12n) / 10n;
  const verificationGas = p.initCode && p.initCode !== "0x" ? 4_000_000n : 2_500_000n;
  const callGas = 1_500_000n;

  // 以鏈上時間計算贊助效期與每日額度（伺服器時鐘與鏈上時間可能有落差）
  const now = Number((await publicClient.getBlock()).timestamp);
  const day = Math.floor(now / 86400);
  const validAfter = day * 86400;
  const validUntil = validAfter + 86400;

  const pmPrefix = concat([
    d.paymaster,
    pad(toHex(PM_VERIFICATION_GAS), { size: 16 }),
    pad(toHex(PM_POSTOP_GAS), { size: 16 }),
    pad(toHex(validUntil), { size: 6 }),
    pad(toHex(validAfter), { size: 6 }),
    pad(toHex(day), { size: 6 }),
  ]);

  const userOp: UserOp = {
    sender: p.sender,
    nonce: numberToHex(nonce),
    initCode: p.initCode ?? "0x",
    callData: p.callData,
    accountGasLimits: packUints(verificationGas, callGas),
    preVerificationGas: numberToHex(150_000n),
    gasFees: packUints(gasPrice, maxFee),
    paymasterAndData: pmPrefix,
    signature: "0x",
  };

  // 平台全額贊助：政策服務簽署 paymasterData（額度硬上限在鏈上）
  const pmHash = await publicClient.readContract({
    address: d.paymaster,
    abi: cafecaPaymasterAbi,
    functionName: "getHash",
    args: [opForAbi(userOp), validUntil, validAfter, day],
  });
  const pmSig = await signerOf(env.paymasterSignerKey()).signMessage({ message: { raw: pmHash } });
  userOp.paymasterAndData = concat([pmPrefix, pmSig]);

  const userOpHash = await publicClient.readContract({
    address: d.entryPoint,
    abi: entryPointAbi,
    functionName: "getUserOpHash",
    args: [opForAbi(userOp)],
  });
  return { userOp, userOpHash };
}

export function explainRevert(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert?.data) {
      const { errorName, args } = revert.data;
      if (errorName === "FailedOp" || errorName === "FailedOpWithRevert") {
        const reason = String(args?.[1] ?? "");
        const inner = args?.[2] as Hex | undefined;
        return translateAA(reason) + (inner && inner !== "0x" ? `（${decodeInner(inner)}）` : "");
      }
      return errorName;
    }
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

function decodeInner(data: Hex): string {
  try {
    return decodeErrorResult({ abi: ALL_ERRORS, data }).errorName;
  } catch {
    return data.slice(0, 10);
  }
}

function translateAA(reason: string): string {
  if (reason.startsWith("AA24")) return "簽章驗證未通過或權限不足（AA24）：這個操作可能需要卡片確認，或超過額度";
  if (reason.startsWith("AA22")) return "尚未到可執行時間或已過期（AA22）";
  if (reason.startsWith("AA23")) return "帳戶驗證時發生錯誤（AA23）";
  if (reason.startsWith("AA25")) return "nonce 不正確（AA25）：請重試";
  if (reason.startsWith("AA3")) return `Paymaster 拒絕贊助（${reason}）：可能已達今日額度`;
  if (reason.startsWith("AA1")) return `帳戶建立失敗（${reason}）`;
  return reason;
}

export async function sendUserOp(op: UserOp): Promise<{ txHash: Hex; success: boolean; reason?: string }> {
  const d = DEPLOYMENT;
  return serialize(async () => {
    const wallet = operatorWallet();
    const args = [[opForAbi(op)], wallet.account.address] as const;
    try {
      await publicClient.simulateContract({
        address: d.entryPoint,
        abi: entryPointAbi,
        functionName: "handleOps",
        args,
        account: wallet.account,
      });
    } catch (e) {
      throw new HttpError(400, explainRevert(e));
    }
    const txHash = await wallet.writeContract({
      address: d.entryPoint,
      abi: entryPointAbi,
      functionName: "handleOps",
      args,
      gas: 8_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    let success = false;
    let reason: string | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== d.entryPoint.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: entryPointAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "UserOperationEvent") success = ev.args.success;
        if (ev.eventName === "UserOperationRevertReason") reason = decodeInner(ev.args.revertReason);
      } catch {
        /* 其他事件 */
      }
    }
    return { txHash, success, reason };
  });
}
