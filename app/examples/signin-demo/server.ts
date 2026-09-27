/**
 * Sign in with CAFECA 範例網站（第三方）：npm run demo:signin → http://localhost:10003
 *
 * 模擬一個和 CAFECA 毫無關係、也沒有向 CAFECA 註冊的網站：
 * - 前端載入錢包提供的 cafeca-connect.js
 * - 後端用 sdk/cafeca-verify.ts 以公開 RPC 驗證 ERC-1271 簽章
 * 示範三種登入方式：彈出視窗、整頁導向、跨裝置 QR code；登入後以簽章通道（§15.8）請使用者簽署訊息、EIP-712 訂單與付款。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import type { Address, Hex, TypedDataDefinition } from "viem";
import { createCafecaVerifier, newNonce, type SignInResponse, type VerifiedSignIn } from "../../sdk/cafeca-verify";

const PORT = Number(process.env.PORT ?? 10003);
const ORIGIN = process.env.DEMO_ORIGIN ?? `http://localhost:${PORT}`;
const WALLET = process.env.CAFECA_WALLET ?? "http://localhost:10002";

const cafeca = createCafecaVerifier({ wallet: WALLET, rpcUrl: process.env.RPC_URL });

type Nonce = { sid: string; exp: number; used: boolean; result?: VerifiedSignIn; response?: SignInResponse; error?: string };
/** 範例商店收款地址（任意地址即可） */
const SHOP: Address = "0x000000000000000000000000000000000000cafe";
const nonces = new Map<string, Nonce>();
const sessions = new Map<string, VerifiedSignIn>();

function sidOf(req: IncomingMessage, res: ServerResponse): string {
  const m = /(?:^|;\s*)demo_sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? "");
  if (m) return m[1];
  const sid = randomBytes(16).toString("base64url");
  res.setHeader("set-cookie", `demo_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  return sid;
}

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) {
    s += c;
    if (s.length > 32_000) throw new Error("too large");
  }
  return s;
}

function json(res: ServerResponse, code: number, v: unknown, extra: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...extra });
  res.end(JSON.stringify(v));
}

/** 驗證並作廢 nonce；一個 nonce 只能成功使用一次 */
async function consume(response: SignInResponse): Promise<{ n: Nonce; user: VerifiedSignIn }> {
  const nonce = response?.message?.nonce;
  const n = nonce ? nonces.get(nonce) : undefined;
  if (!n || n.used || n.exp < Date.now() / 1000) throw new Error("nonce 無效或已使用");
  n.used = true; // 先作廢再驗證：同一個 nonce 不能重試
  const user = await cafeca.verify(response, { domain: ORIGIN, nonce: nonce! });
  return { n, user };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  try {
    // 網站自我介紹（錢包顯示名稱與圖示用，需開放 CORS）
    if (url.pathname === "/.well-known/cafeca-site.json") {
      return json(res, 200, { name: "咖啡豆小舖（範例）", icon: "/icon.svg" }, { "access-control-allow-origin": "*" });
    }
    if (url.pathname === "/icon.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "access-control-allow-origin": "*" });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6b3e26"/><ellipse cx="32" cy="32" rx="14" ry="19" fill="#c89b6d" transform="rotate(30 32 32)"/><path d="M26 18c8 8 4 20 12 28" stroke="#6b3e26" stroke-width="3" fill="none"/></svg>`);
    }

    const sid = sidOf(req, res);

    if (url.pathname === "/api/nonce" && req.method === "POST") {
      const nonce = newNonce();
      nonces.set(nonce, { sid, exp: Math.floor(Date.now() / 1000) + 300, used: false });
      return json(res, 200, { nonce });
    }

    // 彈出視窗／整頁導向：前端把錢包的回應交給後端
    if (url.pathname === "/api/login" && req.method === "POST") {
      const response = JSON.parse(await body(req)) as SignInResponse;
      const { n, user } = await consume(response);
      if (n.sid !== sid) throw new Error("nonce 不屬於這個瀏覽器");
      sessions.set(sid, user);
      return json(res, 200, user);
    }

    // 跨裝置 QR：錢包（使用者的手機）以 no-cors POST 直接送到這裡，沒有 cookie
    if (url.pathname === "/api/cafeca/callback" && req.method === "POST") {
      const raw = JSON.parse(await body(req)) as SignInResponse & { error?: string; nonce?: string };
      if (raw.error) {
        const n = raw.nonce ? nonces.get(raw.nonce) : undefined;
        if (n && !n.used) Object.assign(n, { used: true, error: raw.error });
        return json(res, 200, { ok: true });
      }
      const { n, user } = await consume(raw);
      n.result = user;
      n.response = raw; // 電腦頁面需要原始回應才能啟用簽章通道（通道金鑰在電腦的瀏覽器裡）
      return json(res, 200, { ok: true });
    }

    // 原本的電腦頁面輪詢：nonce 屬於這個瀏覽器才會把登入結果綁到它的 session
    if (url.pathname === "/api/poll") {
      const n = nonces.get(url.searchParams.get("nonce") ?? "");
      if (!n || n.sid !== sid) return json(res, 404, { error: "unknown" });
      if (n.error) return json(res, 200, { error: n.error });
      if (!n.result) return json(res, 200, { pending: true });
      sessions.set(sid, n.result);
      return json(res, 200, { ...n.result, response: n.response });
    }

    if (url.pathname === "/api/qr") {
      const svg = await QRCode.toString(url.searchParams.get("d") ?? "", { type: "svg", margin: 1, errorCorrectionLevel: "M" });
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end(svg);
    }

    // 簽章通道回傳的簽章：後端以 ERC-1271 驗證，而且只接受目前登入的帳戶
    if (url.pathname === "/api/verify-sig" && req.method === "POST") {
      const me = sessions.get(sid);
      if (!me) throw new Error("尚未登入");
      const b = JSON.parse(await body(req)) as { message?: string; typedData?: TypedDataDefinition; signature: Hex };
      const ok = b.typedData
        ? await cafeca.verifyTypedData({ account: me.account, typedData: b.typedData, signature: b.signature })
        : await cafeca.verifyMessage({ account: me.account, message: b.message ?? "", signature: b.signature });
      return json(res, 200, { valid: ok });
    }

    if (url.pathname === "/api/me") return json(res, 200, sessions.get(sid) ?? null);
    if (url.pathname === "/api/logout" && req.method === "POST") {
      sessions.delete(sid);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const cfg = await cafeca.config();
      return res.end(page(cfg.contracts?.twdc ?? "0x", cfg.chain.id));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

function page(twdc: string, chainId: number) {
  return /* html */ `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>咖啡豆小舖（Sign in with CAFECA 範例）</title>
<style>
  body{font-family:system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;background:#f6f1ec;color:#2b1d14;margin:0}
  main{max-width:520px;margin:40px auto;padding:0 16px}
  .card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px #0001;margin-bottom:16px}
  button{font:inherit;border:0;border-radius:12px;padding:12px 16px;cursor:pointer;width:100%;margin-top:8px}
  .cafeca{background:linear-gradient(90deg,#8e3fa0,#c0428e,#f0a040);color:#fff;font-weight:600}
  .ghost{background:#efe6de;color:#2b1d14}
  code{font-size:12px;word-break:break-all}
  label{display:flex;gap:6px;align-items:center;font-size:14px;margin-top:6px}
  #qr img,#chqr img{width:220px;height:220px;display:block;margin:12px auto}
  .muted{color:#8a7466;font-size:13px}
  .ok{color:#1d7a4d}.bad{color:#c33}
  select{font:inherit;padding:6px;border-radius:8px}
</style></head>
<body><main>
  <h1>☕ 咖啡豆小舖</h1>
  <p class="muted">這是示範用的第三方網站（${ORIGIN}），沒有向 CAFECA 註冊任何東西。</p>
  <div class="card" id="out"></div>
  <div class="card" id="in">
    <label><input type="checkbox" id="c-kyc" checked> 要求實名等級（kyc_level）</label>
    <label><input type="checkbox" id="c-handle" checked> 要求代稱（handle）</label>
    <label><input type="checkbox" id="c-channel" checked> 開啟簽章通道（之後可請你簽署與付款）</label>
    <button class="cafeca" id="popup">以 CAFECA 登入（彈出視窗）</button>
    <button class="ghost" id="redirect">以 CAFECA 登入（整頁導向）</button>
    <button class="ghost" id="qrbtn">用手機掃描 QR code 登入</button>
    <div id="qr"></div>
  </div>
  <div class="card" id="chan" style="display:none">
    <b>簽章通道</b>
    <div class="muted">通道 <code id="chid"></code>，每一筆都會在 CAFECA 錢包顯示說明，由你確認。</div>
    <label>傳遞方式 <select id="transport"><option value="popup">彈出視窗（同一台裝置）</option><option value="relay">中繼（手機上的 CAFECA）</option></select></label>
    <button class="ghost" id="b-msg">簽署：同意會員條款</button>
    <button class="ghost" id="b-712">簽署：EIP-712 訂單</button>
    <button class="cafeca" id="b-pay">付款 12 TWDC</button>
    <div id="chqr"></div>
    <div id="chout" class="muted"></div>
  </div>
</main>
<script src="${WALLET}/sdk/cafeca-connect.js"></script>
<script>
  const cafeca = CafecaConnect.create({ wallet: ${JSON.stringify(WALLET)} });
  const TWDC = ${JSON.stringify(twdc)}, SHOP = ${JSON.stringify(SHOP)}, CHAIN_ID = ${chainId};
  const $ = (id) => document.getElementById(id);
  const claims = () => [$("c-kyc").checked && "kyc_level", $("c-handle").checked && "handle"].filter(Boolean);
  const wantChannel = () => $("c-channel").checked;
  const getNonce = () => fetch("/api/nonce", { method: "POST" }).then((r) => r.json()).then((j) => j.nonce);
  const statement = "登入咖啡豆小舖，查看訂單與會員點數";
  let channel = null;

  async function login(response) {
    const r = await fetch("/api/login", { method: "POST", body: JSON.stringify(response) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    await attach(response);
    render(j);
  }
  async function attach(response) {
    channel = await cafeca.channel(response);
    if (channel) localStorage.setItem("demo.channel", channel.id);
  }
  function render(u) {
    $("in").style.display = u ? "none" : "";
    $("chan").style.display = u && channel ? "" : "none";
    if (channel) $("chid").textContent = channel.id.slice(0, 8) + "…";
    $("out").innerHTML = u
      ? '<b data-testid="demo-user">已登入</b><div><code id="acct">' + u.account + '</code></div>' +
        '<div class="muted">實名等級：<span id="kyc">' + (u.claims.kyc_level ?? "未提供") + '</span>　代稱：<span id="handle">' + (u.claims.handle ?? "未提供") + '</span></div>' +
        (u.recoveryPending ? '<div class="bad">此身分正在恢復中，建議限制敏感操作</div>' : '') +
        '<button class="ghost" id="logout">登出</button>'
      : '<span class="muted" id="status">尚未登入</span>';
    if (u) $("logout").onclick = () => fetch("/api/logout", { method: "POST" }).then(() => { channel = null; localStorage.removeItem("demo.channel"); render(null); });
  }
  function fail(e) { $("out").innerHTML = '<span class="bad" id="status">' + (e.message || e) + '</span>'; }
  function chResult(html) { $("chqr").innerHTML = ""; $("chout").innerHTML = html; }
  function chFail(e) { chResult('<span class="bad" id="chresult">✕ ' + (e.code ? e.code + "：" : "") + (e.message || e) + '</span>'); }

  $("popup").onclick = () => cafeca.signIn({ nonce: getNonce, claims: claims(), statement, channel: wantChannel() }).then(login).catch(fail);
  $("redirect").onclick = () => cafeca.redirect({ nonce: getNonce, claims: claims(), statement, channel: wantChannel() }).catch(fail);
  $("qrbtn").onclick = async () => {
    const nonce = await getNonce();
    const link = await cafeca.authLink({ nonce, mode: "post", responseUri: "/api/cafeca/callback", claims: claims(), statement, channel: wantChannel() });
    $("qr").innerHTML = '<img alt="QR" src="/api/qr?d=' + encodeURIComponent(link) + '"><div class="muted" style="text-align:center">用已登入 CAFECA 的手機掃描</div><code id="qrlink" style="display:none">' + link + '</code>';
    const t = setInterval(async () => {
      const j = await fetch("/api/poll?nonce=" + nonce).then((r) => r.json());
      if (j.pending) return;
      clearInterval(t);
      $("qr").innerHTML = "";
      if (j.error) return fail(new Error(j.error === "access_denied" ? "已在手機上拒絕登入" : j.error));
      await attach(j.response);
      $("transport").value = "relay"; // 以手機登入：之後的簽署也送到手機
      render(j);
    }, 1500);
  };

  // ───── 簽章通道 ─────
  const opts = () => ({
    transport: $("transport").value,
    onPending: ({ link }) => {
      $("chqr").innerHTML = '<div class="muted" id="chpending">已送到你的 CAFECA，請在手機上確認（或掃描 QR 開啟）</div><img alt="QR" src="/api/qr?d=' + encodeURIComponent(link) + '"><code id="chlink" style="display:none">' + link + '</code>';
    },
  });
  async function verifySig(body) {
    const j = await fetch("/api/verify-sig", { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
    return j.valid ? '<span class="ok" id="chresult">✓ 簽章有效（後端已以 ERC-1271 驗證）</span>' : '<span class="bad" id="chresult">✕ 簽章無效</span>';
  }
  $("b-msg").onclick = () => {
    const message = "咖啡豆小舖 會員條款 v3\\n我同意會員條款與隱私權政策。\\n時間：" + new Date().toISOString();
    channel.signMessage(message, { title: "同意會員條款 v3", detail: "簽署後代表你同意咖啡豆小舖的會員條款與隱私權政策，不會產生任何費用。" }, opts())
      .then(({ signature }) => verifySig({ message, signature })).then(chResult).catch(chFail);
  };
  window.orderTypedData = (extra) => Object.assign({
    domain: { name: "咖啡豆小舖", version: "1", chainId: CHAIN_ID, verifyingContract: SHOP },
    types: { Order: [{ name: "orderId", type: "string" }, { name: "item", type: "string" }, { name: "amount", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Order",
    message: { orderId: "A1024", item: "衣索比亞 耶加雪菲 200g", amount: 12000000, deadline: Math.floor(Date.now() / 1000) + 86400 },
  }, extra || {});
  $("b-712").onclick = () => {
    const typedData = orderTypedData();
    channel.signTypedData(typedData, { title: "確認訂單 A1024", detail: "衣索比亞 耶加雪菲 200g，12 TWDC。只是確認訂單內容，付款會另外請你確認。" }, opts())
      .then(({ signature }) => verifySig({ typedData, signature })).then(chResult).catch(chFail);
  };
  $("b-pay").onclick = () => {
    const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
    const data = "0xa9059cbb" + pad(SHOP) + pad((12000000).toString(16)); // transfer(SHOP, 12 TWDC)
    channel.sendCalls([{ to: TWDC, data }], { title: "付款 12 TWDC", detail: "訂單 A1024：衣索比亞 耶加雪菲 200g" }, opts())
      .then((r) => chResult((r.success ? '<span class="ok" id="chresult">✓ 付款成功</span>' : '<span class="bad" id="chresult">✕ 交易失敗</span>') + ' <code id="txhash">' + r.txHash + '</code>'))
      .catch(chFail);
  };
  window.demoChannel = () => channel; // E2E 測試用

  (async () => {
    const back = CafecaConnect.handleRedirect();
    if (back?.response) return login(back.response).catch(fail);
    if (back?.error) return fail(back.error);
    const me = await fetch("/api/me").then((r) => r.json());
    const id = localStorage.getItem("demo.channel");
    if (me && id) channel = await cafeca.restoreChannel(id);
    render(me);
  })();
</script>
</body></html>`;
}

server.listen(PORT, () => console.log(`Sign in with CAFECA demo: ${ORIGIN}  (wallet: ${WALLET})`));
