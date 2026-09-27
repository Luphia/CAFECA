/*!
 * cafeca-connect.js — Sign in with CAFECA 瀏覽器 SDK（協定 v1，規格 §15）
 *
 * <script src="https://<CAFECA 錢包網域>/sdk/cafeca-connect.js"></script>
 * const cafeca = CafecaConnect.create({ wallet: "https://<CAFECA 錢包網域>" });
 * const response = await cafeca.signIn({ nonce: () => fetch("/api/nonce", { method: "POST" }).then(r => r.json()).then(j => j.nonce) });
 * await fetch("/api/login", { method: "POST", body: JSON.stringify(response) }); // 後端驗證（見 README）
 *
 * SDK 只負責把請求交給錢包、把回應交回你的頁面；它不驗證簽章——驗證一定要在你的後端做。
 */
(function (global) {
  "use strict";

  var VERSION = 1;
  var CLAIMS = ["kyc_level", "handle"];
  var DEFAULT_TTL = 300;

  function b64url(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function unb64url(s) {
    var bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function CafecaError(code, message) {
    var e = new Error(message || code);
    e.name = "CafecaError";
    e.code = code;
    return e;
  }

  /** nonce 可以是字串、Promise，或回傳兩者之一的函式；也可以回傳 { nonce, issuedAt, expiresAt } */
  function resolveNonce(n) {
    var v = typeof n === "function" ? n() : n;
    return Promise.resolve(v).then(function (r) {
      if (typeof r === "string") return { nonce: r };
      if (r && typeof r.nonce === "string") return r;
      throw CafecaError("invalid_nonce", "nonce 必須是字串");
    });
  }

  function create(options) {
    if (!options || !options.wallet) throw CafecaError("invalid_config", "需要 wallet（CAFECA 錢包網址）");
    var walletOrigin = new URL(options.wallet).origin;

    function buildRequest(o, n) {
      var now = Math.floor(Date.now() / 1000);
      var req = {
        v: VERSION,
        domain: global.location.origin,
        uri: o.uri || global.location.href.split("#")[0],
        nonce: n.nonce,
        issuedAt: n.issuedAt || now,
        expiresAt: n.expiresAt || now + (o.ttl || DEFAULT_TTL),
        mode: o.mode || "popup",
      };
      if (o.statement) req.statement = String(o.statement).slice(0, 200);
      if (o.claims) req.claims = o.claims.filter(function (c) { return CLAIMS.indexOf(c) >= 0; });
      if (o.redirectUri) req.redirectUri = new URL(o.redirectUri, global.location.href).href;
      if (o.responseUri) req.responseUri = new URL(o.responseUri, global.location.href).href;
      if (o.state) req.state = String(o.state);
      if (req.mode === "redirect" && !req.redirectUri) req.redirectUri = global.location.href.split("#")[0];
      return req;
    }

    /** 產生錢包深連結（QR code 或自行開啟）。nonce 必須已經是字串。 */
    function authLink(o) {
      if (typeof o.nonce !== "string" && !(o.nonce && o.nonce.nonce)) throw CafecaError("invalid_nonce", "authLink 需要已產生的 nonce");
      var req = buildRequest(o, typeof o.nonce === "string" ? { nonce: o.nonce } : o.nonce);
      return walletOrigin + "/dl/auth?v=1&req=" + b64url(JSON.stringify(req));
    }

    /** 彈出視窗登入：必須在使用者點擊的事件中呼叫（避免被瀏覽器擋下彈出視窗） */
    function signIn(o) {
      o = o || {};
      var w = 420, h = 720;
      var left = (global.screenX || 0) + Math.max(0, ((global.outerWidth || w) - w) / 2);
      var top = (global.screenY || 0) + Math.max(0, ((global.outerHeight || h) - h) / 2);
      var popup = global.open("about:blank", "cafeca-signin", "popup,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
      if (!popup) return Promise.reject(CafecaError("popup_blocked", "瀏覽器擋下了登入視窗，請允許彈出視窗後重試"));

      return resolveNonce(o.nonce).then(
        function (n) {
          var req = buildRequest(Object.assign({}, o, { mode: "popup" }), n);
          popup.location.href = walletOrigin + "/dl/auth?v=1&req=" + b64url(JSON.stringify(req));
          return new Promise(function (resolve, reject) {
            var timer = setInterval(function () {
              if (popup.closed) done(null, CafecaError("closed", "使用者關閉了登入視窗"));
            }, 400);
            var limit = setTimeout(function () {
              done(null, CafecaError("timeout", "登入逾時"));
            }, (req.expiresAt - Math.floor(Date.now() / 1000) + 5) * 1000);
            function onMessage(e) {
              // 只接受 CAFECA 錢包、而且是我們開的那個視窗送來的訊息
              if (e.origin !== walletOrigin || e.source !== popup) return;
              var d = e.data;
              if (!d || d.type !== "cafeca:auth" || d.v !== VERSION) return;
              if (d.error) {
                if (d.nonce && d.nonce !== req.nonce) return;
                return done(null, CafecaError(d.error, d.error === "access_denied" ? "使用者拒絕登入" : "登入請求無效"));
              }
              if (!d.message || d.message.nonce !== req.nonce) return;
              done(d, null);
            }
            function done(res, err) {
              clearInterval(timer);
              clearTimeout(limit);
              global.removeEventListener("message", onMessage);
              if (err) reject(err);
              else resolve(res);
            }
            global.addEventListener("message", onMessage);
          });
        },
        function (e) {
          popup.close();
          throw e;
        },
      );
    }

    /** 整頁導向登入（行動裝置、擋彈出視窗的環境）；回來後在 redirectUri 頁面呼叫 handleRedirect() */
    function redirect(o) {
      return resolveNonce(o.nonce).then(function (n) {
        global.location.assign(authLink(Object.assign({}, o, { mode: "redirect", nonce: n })));
      });
    }

    return { walletOrigin: walletOrigin, signIn: signIn, redirect: redirect, authLink: authLink };
  }

  /**
   * 在 redirectUri 頁面讀取錢包帶回的結果（放在 #fragment，不會送到任何伺服器），讀完即清除網址列。
   * 回傳 { response } / { error } / null（沒有結果）。
   */
  function handleRedirect() {
    var m = /(?:^#|&)cafeca=([A-Za-z0-9_-]+)/.exec(global.location.hash);
    if (!m) return null;
    history.replaceState(null, "", global.location.pathname + global.location.search);
    try {
      var d = JSON.parse(unb64url(m[1]));
      if (!d || d.type !== "cafeca:auth") return null;
      return d.error ? { error: CafecaError(d.error, d.error === "access_denied" ? "使用者拒絕登入" : "登入請求無效"), state: d.state } : { response: d, state: d.state };
    } catch {
      return null;
    }
  }

  global.CafecaConnect = { version: VERSION, create: create, handleRedirect: handleRedirect };
})(typeof window !== "undefined" ? window : this);
