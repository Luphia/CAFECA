import { decodeEventLog, erc20Abi, getAddress, isAddress, isHex, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEPLOYMENT, HANDLE_CHANGE_PRICE_TWDC, TWDC_DECIMALS } from "@/lib/config";
import { publicClient } from "@/server/chain";
import { env } from "@/server/env";
import { handle, HttpError, requireSession } from "@/server/session";
import { read, update, type Store } from "@/server/store";

/**
 * 使用者代稱（聊天、轉帳、第三方登入用），僅存在伺服器，不上鏈。
 *
 * - 第一次設定免費；設定後固定，之後每次變更需支付 HANDLE_CHANGE_PRICE_TWDC（TWDC 轉給 CAFECA 收款地址）
 * - 變更後舊代稱保留給原擁有者，其他人不能註冊（避免別人冒用舊代稱收款）
 * - 付款先登記為可用額度：變更失敗（例如代稱剛好被搶走）時不必重新付款
 */

const norm = (h: unknown) => (typeof h === "string" ? h.trim().replace(/^@+/, "").toLowerCase() : "");
const valid = (h: string) => /^[a-z0-9_]{3,20}$/.test(h);

/** 代稱變更費收款地址（測試網＝營運錢包） */
function treasury(): Address {
  return privateKeyToAccount(env.operatorKey()).address;
}

function takenBy(s: Store, h: string): string | undefined {
  return s.handles[h] ?? s.retiredHandles?.[h];
}

function unusedCredit(s: Store, me: string) {
  return Object.entries(s.handleFees ?? {}).find(([, f]) => f.owner === me && !f.used)?.[0] ?? null;
}

async function verifyFee(me: Address, txHash: Hex) {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== "success") throw new HttpError(402, "找不到這筆付款交易");
  const price = parseUnits(HANDLE_CHANGE_PRICE_TWDC, TWDC_DECIMALS);
  const to = treasury().toLowerCase();
  const paid = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== DEPLOYMENT.twdc.toLowerCase()) return false;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === me.toLowerCase() && ev.args.to.toLowerCase() === to && ev.args.value >= price;
    } catch {
      return false;
    }
  });
  if (!paid) throw new HttpError(402, `找不到 ${HANDLE_CHANGE_PRICE_TWDC} TWDC 的代稱變更付款`);
}

export const POST = handle(async (req: Request) => {
  const me = await requireSession();
  const body = (await req.json().catch(() => ({}))) as { handle?: unknown; txHash?: unknown };
  const h = norm(body.handle);
  if (!valid(h)) throw new HttpError(400, "代稱需為 3–20 個英文小寫、數字或底線（不含 @）");
  const txHash = typeof body.txHash === "string" ? (body.txHash.toLowerCase() as Hex) : undefined;
  if (txHash && (!isHex(txHash) || txHash.length !== 66)) throw new HttpError(400, "交易雜湊格式錯誤");

  // 先把付款登記成額度（鏈上查詢不放在寫入鎖裡）
  if (txHash) {
    const s0 = await read();
    const f = s0.handleFees?.[txHash];
    if (f && f.owner !== me) throw new HttpError(409, "這筆付款不屬於你");
    if (f?.used) throw new HttpError(409, "這筆付款已經使用過");
    if (!f) {
      await verifyFee(me, txHash);
      await update((s) => {
        s.handleFees ??= {};
        s.handleFees[txHash] ??= { owner: me, paidAt: Date.now(), used: false };
      });
    }
  }

  const result = await update((s) => {
    const cur = s.profiles[me]?.handle;
    if (cur === h) return { handle: h, changed: false };
    const owner = takenBy(s, h);
    if (owner && owner !== me) throw new HttpError(409, "此代稱已被使用");
    if (cur) {
      // 已設定過：變更需要一筆未使用的付款
      const credit = txHash && s.handleFees?.[txHash] && !s.handleFees[txHash].used ? txHash : unusedCredit(s, me);
      if (!credit) throw new HttpError(402, `代稱設定後即固定；變更需支付 ${HANDLE_CHANGE_PRICE_TWDC} TWDC`);
      s.handleFees![credit] = { ...s.handleFees![credit], used: true, usedFor: h, usedAt: Date.now() };
      delete s.handles[cur];
      s.retiredHandles ??= {};
      s.retiredHandles[cur] = me;
    }
    if (s.retiredHandles?.[h] === me) delete s.retiredHandles[h];
    s.handles[h] = me;
    s.profiles[me] = { handle: h, iss: s.profiles[me]?.iss ?? "", createdAt: s.profiles[me]?.createdAt ?? Date.now(), changedAt: cur ? Date.now() : undefined };
    return { handle: h, changed: !!cur };
  });
  return Response.json(result);
});

/**
 * GET ?q=<@代稱|地址>：查詢
 * GET ?check=<代稱>：是否可用、變更費用與收款地址、是否有尚未使用的付款（需登入）
 */
export const GET = handle(async (req: Request) => {
  const url = new URL(req.url);
  const s = await read();
  if (url.searchParams.has("check")) {
    const me = await requireSession();
    const h = norm(url.searchParams.get("check"));
    const owner = valid(h) ? takenBy(s, h) : undefined;
    return Response.json({
      handle: h,
      valid: valid(h),
      available: valid(h) && (!owner || owner === me),
      current: s.profiles[me]?.handle ?? null,
      price: HANDLE_CHANGE_PRICE_TWDC,
      treasury: treasury(),
      credit: unusedCredit(s, me),
    });
  }
  const q = (url.searchParams.get("q") ?? "").trim();
  if (isAddress(q)) {
    const a = getAddress(q);
    return Response.json({ address: a, handle: s.profiles[a]?.handle ?? null });
  }
  const a = s.handles[norm(q)];
  if (!a) throw new HttpError(404, "找不到此代稱");
  return Response.json({ address: a, handle: s.profiles[a]?.handle ?? null });
});
