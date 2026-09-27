/*!
 * cafeca-connect.js — Sign in with CAFECA 瀏覽器 SDK（協定 v1，規格 §15）
 *
 * <script src="https://<CAFECA 錢包網域>/sdk/cafeca-connect.js"></script>
 * const cafeca = CafecaConnect.create({ wallet: "https://<CAFECA 錢包網域>" });
 * const response = await cafeca.signIn({ nonce: getNonce, channel: true });
 * await fetch("/api/login", { method: "POST", body: JSON.stringify(response) }); // 後端驗證（見 README）
 * const ch = await cafeca.channel(response);                                     // 簽章通道（§15.8）
 * const { signature } = await ch.signMessage("同意條款 v3", { title: "同意服務條款" });
 *
 * SDK 只負責傳遞；簽章與登入結果一定要在你的後端驗證。
 */
(function (global) {
  "use strict";

  var VERSION = 1;
  var CLAIMS = ["kyc_level", "handle"];
  var DEFAULT_TTL = 300;
  var REQUEST_TTL = 300;
  var enc = new TextEncoder();

  // ───────────────────────── 工具 ─────────────────────────

  function bytesToB64u(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64uToBytes(s) {
    var bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function b64url(str) {
    return bytesToB64u(enc.encode(str));
  }
  function unb64url(s) {
    return new TextDecoder().decode(b64uToBytes(s));
  }
  function hexId(n) {
    var b = crypto.getRandomValues(new Uint8Array(n));
    return Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function CafecaError(code, message) {
    var e = new Error(message || code);
    e.name = "CafecaError";
    e.code = code;
    return e;
  }

  var ERR_TEXT = {
    access_denied: "使用者拒絕登入",
    rejected: "使用者拒絕簽署",
    invalid_request: "錢包拒絕了這個請求",
    failed: "操作失敗",
    channel_closed: "使用者已關閉簽章通道",
  };

  /** nonce 可以是字串、Promise，或回傳兩者之一的函式；也可以回傳 { nonce, issuedAt, expiresAt } */
  function resolveNonce(n) {
    var v = typeof n === "function" ? n() : n;
    return Promise.resolve(v).then(function (r) {
      if (typeof r === "string") return { nonce: r };
      if (r && typeof r.nonce === "string") return r;
      throw CafecaError("invalid_nonce", "nonce 必須是字串");
    });
  }

  function openPopup(name) {
    var w = 420, h = 720;
    var left = (global.screenX || 0) + Math.max(0, ((global.outerWidth || w) - w) / 2);
    var top = (global.screenY || 0) + Math.max(0, ((global.outerHeight || h) - h) / 2);
    var p = global.open("about:blank", name, "popup,width=" + w + ",height=" + h + ",left=" + left + ",top=" + top);
    if (!p) throw CafecaError("popup_blocked", "瀏覽器擋下了 CAFECA 視窗，請允許彈出視窗後重試");
    return p;
  }

  // ───────────────────────── 通道金鑰（IndexedDB，私鑰不可匯出） ─────────────────────────

  function db() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open("cafeca-connect", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("keys"); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction("keys", mode);
        var req = fn(tx.objectStore("keys"));
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  var kv = {
    get: function (k) { return idb("readonly", function (s) { return s.get(k); }); },
    set: function (k, v) { return idb("readwrite", function (s) { return s.put(v, k); }); },
    del: function (k) { return idb("readwrite", function (s) { return s.delete(k); }); },
  };

  function newChannelKey() {
    return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]).then(function (kp) {
      return crypto.subtle.exportKey("raw", kp.publicKey).then(function (raw) {
        return { priv: kp.privateKey, pub: bytesToB64u(new Uint8Array(raw)) };
      });
    });
  }

  function deriveKey(priv, peerPub, channelId) {
    return crypto.subtle
      .importKey("raw", b64uToBytes(peerPub), { name: "ECDH", namedCurve: "P-256" }, false, [])
      .then(function (peer) { return crypto.subtle.deriveBits({ name: "ECDH", public: peer }, priv, 256); })
      .then(function (bits) { return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]); })
      .then(function (hk) {
        return crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: enc.encode(channelId), info: enc.encode("CAFECA-channel-v1") },
          hk,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      });
  }

  function seal(key, ch, id, obj) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle
      .encrypt({ name: "AES-GCM", iv: iv, additionalData: enc.encode(ch + "|" + id + "|req") }, key, enc.encode(JSON.stringify(obj)))
      .then(function (ct) { return { v: 1, ch: ch, id: id, iv: bytesToB64u(iv), ct: bytesToB64u(new Uint8Array(ct)) }; });
  }

  function openBox(key, box) {
    return crypto.subtle
      .decrypt({ name: "AES-GCM", iv: b64uToBytes(box.iv), additionalData: enc.encode(box.ch + "|" + box.id + "|res") }, key, b64uToBytes(box.ct))
      .then(function (pt) { return JSON.parse(new TextDecoder().decode(pt)); });
  }

  function parseChannelString(s) {
    var m = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{87})\.([A-Za-z0-9_-]{87})\.(\d{1,12})$/.exec(s || "");
    return m ? { id: m[1], sitePub: m[2], walletPub: m[3], expiresAt: Number(m[4]) } : null;
  }

  // ───────────────────────── 主要 API ─────────────────────────

  function create(options) {
    if (!options || !options.wallet) throw CafecaError("invalid_config", "需要 wallet（CAFECA 錢包網址）");
    var walletOrigin = new URL(options.wallet).origin;

    /** 要求簽章通道時先產生網站端金鑰，以 nonce 暫存；錢包回應後由 channel(response) 啟用 */
    function prepareChannel(o, nonce) {
      if (!o.channel) return Promise.resolve(null);
      var ttl = (typeof o.channel === "object" && o.channel.ttl) || 7 * 24 * 3600;
      return newChannelKey().then(function (k) {
        return kv.set("pending:" + nonce, { priv: k.priv, pub: k.pub, at: Date.now() }).then(function () {
          return { pub: k.pub, ttl: ttl };
        });
      });
    }

    function buildRequest(o, n, channel) {
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
      if (channel) req.channel = channel;
      return req;
    }

    function linkOf(req) {
      return walletOrigin + "/dl/auth?v=1&req=" + b64url(JSON.stringify(req));
    }

    /** 產生錢包深連結（QR code 或自行開啟），回傳 Promise<string> */
    function authLink(o) {
      return resolveNonce(o.nonce).then(function (n) {
        return prepareChannel(o, n.nonce).then(function (ch) { return linkOf(buildRequest(o, n, ch)); });
      });
    }

    /** 彈出視窗登入：必須在使用者點擊的事件中呼叫（避免被瀏覽器擋下彈出視窗） */
    function signIn(o) {
      o = o || {};
      var popup;
      try {
        popup = openPopup("cafeca-signin");
      } catch (e) {
        return Promise.reject(e);
      }
      var req;
      return resolveNonce(o.nonce)
        .then(function (n) {
          return prepareChannel(o, n.nonce).then(function (ch) {
            req = buildRequest(Object.assign({}, o, { mode: "popup" }), n, ch);
            popup.location.href = linkOf(req);
          });
        })
        .then(
          function () {
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
                  return done(null, CafecaError(d.error, ERR_TEXT[d.error] || "登入請求無效"));
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
      return authLink(Object.assign({}, o, { mode: "redirect" })).then(function (url) {
        global.location.assign(url);
      });
    }

    // ───────────── 簽章通道 ─────────────

    /** 以登入回應啟用簽章通道；使用者沒有同意開啟時回傳 null */
    function channel(response) {
      var c = response && response.message && parseChannelString(response.message.channel);
      if (!c) return Promise.resolve(null);
      var pk = "pending:" + response.message.nonce;
      return kv.get(pk).then(function (p) {
        if (!p) return kv.get("ch:" + c.id).then(function (x) { return x ? makeChannel(x) : null; });
        if (p.pub !== c.sitePub) throw CafecaError("invalid_channel", "通道公鑰不符");
        var rec = { id: c.id, priv: p.priv, sitePub: c.sitePub, walletPub: c.walletPub, expiresAt: c.expiresAt, account: response.account, wallet: walletOrigin };
        return kv.set("ch:" + c.id, rec).then(function () { return kv.del(pk); }).then(function () { return makeChannel(rec); });
      });
    }

    /** 之後的頁面載入：以通道 id 取回（網站自行記住 id，例如存在 session 或 localStorage） */
    function restoreChannel(id) {
      return kv.get("ch:" + id).then(function (rec) {
        if (!rec || rec.wallet !== walletOrigin) return null;
        if (rec.expiresAt * 1000 < Date.now()) return kv.del("ch:" + id).then(function () { return null; });
        return makeChannel(rec);
      });
    }

    function makeChannel(rec) {
      var keyP = null;
      function key() { return (keyP = keyP || deriveKey(rec.priv, rec.walletPub, rec.id)); }

      function normDesc(d) {
        if (typeof d === "string") d = { title: d };
        if (!d || !d.title) throw CafecaError("invalid_request", "每一筆簽章請求都必須附上說明（description.title）");
        return { title: String(d.title).slice(0, 60), detail: d.detail ? String(d.detail).slice(0, 500) : undefined };
      }

      function request(method, params, description, opts) {
        opts = opts || {};
        var desc;
        try {
          desc = normDesc(description);
        } catch (e) {
          return Promise.reject(e);
        }
        if (rec.expiresAt * 1000 < Date.now()) return Promise.reject(CafecaError("channel_closed", "簽章通道已過期"));
        var relay = opts.transport === "relay";
        var popup = null;
        if (!relay) {
          try {
            popup = openPopup("cafeca-sign");
          } catch (e) {
            return Promise.reject(e);
          }
        }
        var id = hexId(16);
        var now = Math.floor(Date.now() / 1000);
        var body = { v: 1, id: id, method: method, params: params, description: desc, iat: now, exp: now + (opts.ttl || REQUEST_TTL) };
        return key()
          .then(function (k) { return seal(k, rec.id, id, body); })
          .then(function (box) { return relay ? viaRelay(box, body, opts) : viaPopup(popup, box, body); })
          .then(function (box) { return key().then(function (k) { return openBox(k, box); }); })
          .then(function (res) {
            if (res.id !== id) throw CafecaError("invalid_response", "回應不符");
            if (res.error) throw CafecaError(res.error, res.message || ERR_TEXT[res.error] || res.error);
            return res.result;
          });
      }

      function viaPopup(popup, box, body) {
        popup.location.href = walletOrigin + "/dl/sign?v=1&ch=" + rec.id;
        return new Promise(function (resolve, reject) {
          var timer = setInterval(function () {
            if (popup.closed) done(null, CafecaError("closed", "使用者關閉了簽署視窗"));
          }, 400);
          var limit = setTimeout(function () { done(null, CafecaError("timeout", "簽署逾時")); }, (body.exp - body.iat + 5) * 1000);
          function onMessage(e) {
            if (e.origin !== walletOrigin || e.source !== popup) return;
            var d = e.data || {};
            if (d.type === "cafeca:channel-ready" && d.ch === rec.id) {
              popup.postMessage({ type: "cafeca:channel-request", v: 1, box: box }, walletOrigin);
            } else if (d.type === "cafeca:channel-response" && d.box && d.box.ch === rec.id && d.box.id === box.id) {
              done(d.box, null);
            } else if (d.type === "cafeca:channel-closed" && d.ch === rec.id) {
              kv.del("ch:" + rec.id);
              done(null, CafecaError("channel_closed", ERR_TEXT.channel_closed));
            }
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
      }

      function viaRelay(box, body, opts) {
        var base = walletOrigin + "/api/channel";
        return fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "push", box: box }) })
          .then(function (r) {
            if (r.status === 410) {
              kv.del("ch:" + rec.id);
              throw CafecaError("channel_closed", ERR_TEXT.channel_closed);
            }
            if (!r.ok) throw CafecaError("relay_error", "無法送出請求（HTTP " + r.status + "）");
            if (opts.onPending) opts.onPending({ link: walletOrigin + "/dl/sign?v=1&ch=" + rec.id + "&r=" + box.id });
            var poll = function () {
              if (Date.now() / 1000 > body.exp + 5) throw CafecaError("timeout", "簽署逾時");
              return fetch(base + "?ch=" + rec.id + "&r=" + box.id + "&res=1")
                .then(function (x) { return x.json(); })
                .then(function (j) {
                  if (j.box) return j.box;
                  if (j.closed) {
                    kv.del("ch:" + rec.id);
                    throw CafecaError("channel_closed", ERR_TEXT.channel_closed);
                  }
                  return sleep(opts.pollMs || 1500).then(poll);
                });
            };
            return poll();
          });
      }

      return {
        id: rec.id,
        account: rec.account,
        expiresAt: rec.expiresAt,
        /** EIP-191 文字訊息 → { signature }（ERC-1271） */
        signMessage: function (message, description, opts) {
          return request("sign_message", { message: String(message) }, description, opts);
        },
        /** EIP-712（數值請用 number 或十進位字串）→ { signature } */
        signTypedData: function (typedData, description, opts) {
          return request("sign_typed_data", { typedData: typedData }, description, opts);
        },
        /** 鏈上操作 [{ to, value?, data? }] → { txHash, success }（gas 由平台贊助） */
        sendCalls: function (calls, description, opts) {
          return request("send_calls", { calls: calls }, description, opts);
        },
        /** 刪除這台瀏覽器上的通道金鑰（使用者端的通道要在 CAFECA「安全」頁關閉） */
        forget: function () {
          return kv.del("ch:" + rec.id);
        },
      };
    }

    return { walletOrigin: walletOrigin, signIn: signIn, redirect: redirect, authLink: authLink, channel: channel, restoreChannel: restoreChannel };
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
      return d.error ? { error: CafecaError(d.error, ERR_TEXT[d.error] || "登入請求無效"), state: d.state } : { response: d, state: d.state };
    } catch {
      return null;
    }
  }

  global.CafecaConnect = { version: VERSION, create: create, handleRedirect: handleRedirect };
})(typeof window !== "undefined" ? window : this);
