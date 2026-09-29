/**
 * HiPKI 跨平台網頁元件（中華電信，工商憑證／自然人憑證共用）
 *
 * 使用者電腦上的元件在 http://localhost:61161 提供服務（Windows 隨 HiCOS 卡片管理工具安裝，macOS／Linux 另有安裝檔，
 * 見 https://moeaca.nat.gov.tw/download/download_4.html）。手機與平板沒有元件，只能在桌機或筆電上使用。
 *
 * 協定（依政府憑證網頁元件的公開範例）：
 *   GET  /pkcs11info?withcert=true            讀卡機、卡片與憑證資訊
 *   開啟 /popupForm 視窗 → 視窗 postMessage {"func":"getTbs"} → 網頁回傳簽章參數（JSON 字串）
 *   → 元件以卡片簽署 → 視窗 postMessage {"func":"sign","ret_code":0,"signature":<PKCS#7 base64>,"certb64":…}
 *
 * PoC 注意：參數與錯誤碼依範例實作，尚待以實體工商憑證與讀卡機逐項確認。
 */

export const HIPKI_URL = process.env.NEXT_PUBLIC_HIPKI_URL ?? "http://localhost:61161";

export type HipkiCard = { slot: string; cardSN: string | null; subject: string | null; certb64: string | null };
export type HipkiSignature = { signature: string; certb64?: string; cardSN?: string };

export class HipkiError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
}

/** 常見錯誤碼（依範例；未列出的顯示原始碼） */
const MESSAGES: Record<number, string> = {
  0x76000001: "尚未插入讀卡機或工商憑證 IC 卡",
  0x76000031: "PIN 碼錯誤",
  0x76000044: "PIN 碼錯誤次數過多，卡片已鎖定",
  0x76000008: "找不到簽章憑證",
  0x7600001b: "使用者取消",
};

export function hipkiMessage(code: number | undefined, fallback?: string) {
  if (code === undefined) return fallback ?? "工商憑證簽章失敗";
  return MESSAGES[code] ?? `${fallback ?? "工商憑證元件回傳錯誤"}（0x${code.toString(16)}）`;
}

/** 偵測元件與卡片（元件沒有啟動時回傳 null） */
export async function hipkiCards(timeoutMs = 3000): Promise<HipkiCard[] | null> {
  try {
    const r = await fetch(`${HIPKI_URL}/pkcs11info?withcert=true`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = (await r.json()) as { ret_code?: number; slots?: { slotDescription?: string; token?: { serialNumber?: string; certs?: { certb64?: string; subjectDN?: string }[] } }[] };
    return (j.slots ?? []).map((s) => ({
      slot: s.slotDescription ?? "",
      cardSN: s.token?.serialNumber ?? null,
      subject: s.token?.certs?.[0]?.subjectDN ?? null,
      certb64: s.token?.certs?.[0]?.certb64 ?? null,
    }));
  } catch {
    return null;
  }
}

function b64utf8(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * 以工商憑證簽署 tbs（PKCS#7、SHA-256、附加內容）。
 * tbs 以 UTF-8 的 base64 傳給元件，避免中文編碼不一致。
 */
export function hipkiSign(p: { tbs: string; pin: string; timeoutMs?: number }): Promise<HipkiSignature> {
  return new Promise((resolve, reject) => {
    const nonce = crypto.getRandomValues(new Uint32Array(2)).join("");
    const popup = window.open(`${HIPKI_URL}/popupForm`, "hipki-sign", "height=240,width=320,left=100,top=40");
    if (!popup) return reject(new HipkiError("瀏覽器擋下了簽章視窗，請允許彈出視窗後再試"));
    const origin = new URL(HIPKI_URL).origin;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      clearInterval(watch);
      fn();
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== origin || ev.source !== popup) return;
      let m: { func?: string; ret_code?: number; message?: string; signature?: string; certb64?: string; cardSN?: string; last_error?: number };
      try {
        m = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      } catch {
        return;
      }
      if (m.func === "getTbs") {
        const pkg = {
          func: "MakeSignature",
          signatureType: "PKCS7",
          tbs: b64utf8(p.tbs),
          tbsEncoding: "base64",
          hashAlgorithm: "SHA256",
          withCardSN: "true",
          pin: p.pin,
          nonce,
        };
        popup.postMessage(JSON.stringify(pkg), origin);
      } else if (m.func === "sign") {
        finish(() => {
          if (m.ret_code === 0 && m.signature) resolve({ signature: m.signature, certb64: m.certb64, cardSN: m.cardSN });
          else reject(new HipkiError(hipkiMessage(m.last_error ?? m.ret_code, m.message), m.last_error ?? m.ret_code));
        });
      }
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => finish(() => reject(new HipkiError("工商憑證簽章逾時，請確認元件已啟動、卡片已插入"))), p.timeoutMs ?? 90_000);
    const watch = setInterval(() => {
      // 元件送出結果後會自行關閉視窗：稍等一下，讓最後一則訊息先送達
      if (popup.closed) setTimeout(() => finish(() => reject(new HipkiError("簽章視窗已關閉"))), 1000);
    }, 500);
  });
}
