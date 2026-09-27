import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CardFront, FingerprintMark } from "@/components/cafeca-card";
import { CafecaTile } from "@/components/cafeca-logo";
import { LandingCta } from "@/components/landing-cta";

export const metadata: Metadata = {
  title: "CAFECA 數位身分證｜你的身分，由你自己的金鑰掌握",
  description:
    "CAFECA 數位身分證以 FIDO2 金鑰建立在區塊鏈上的身分：不用帳號密碼、不怕釣魚，可以證明自己又不暴露個資，同時是能聊天、付款、交給 AI 代辦的錢包。",
};

const NAV = [
  { href: "#what", label: "是什麼" },
  { href: "#why", label: "為什麼需要" },
  { href: "#how", label: "怎麼使用" },
  { href: "#keys", label: "安全設計" },
  { href: "#faq", label: "常見問題" },
];

export default function Landing() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <CafecaTile className="size-8" />
            <span className="text-gradient text-sm font-bold tracking-[0.25em]">CAFECA</span>
          </Link>
          <nav className="hidden gap-6 text-sm text-ink-2 md:flex">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="hover:text-brand">
                {n.label}
              </a>
            ))}
          </nav>
          <LandingCta size="md" />
        </div>
      </header>

      <main>
        {/* ── Hero ── */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-12 sm:px-6 md:grid-cols-[1.1fr_0.9fr] md:pt-20">
          <div>
            <p className="text-gradient text-sm font-semibold tracking-[0.2em]">CAFECA 數位身分證</p>
            <h1 className="mt-3 text-[34px] font-bold leading-[1.2] sm:text-5xl">
              你的身分，
              <br />
              由你自己的金鑰掌握。
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-2 sm:text-lg">
              不用帳號密碼，也不用 Google 或 Apple 登入。手機上的指紋就是你的身分證：可以證明「我是我」、證明「我已成年」而不交出個資，
              同時是一個能聊天付款、能交給 AI 代辦事情的錢包。
            </p>
            <LandingCta className="mt-8" />
            <p className="mt-4 text-xs text-ink-3">目前為 Boltchain 測試網原型，使用測試幣，不涉及真實金錢。</p>
          </div>
          <div className="relative mx-auto w-full max-w-[380px]">
            <div className="absolute -inset-6 -z-10 rounded-[40px] bg-brand-bg blur-2xl" />
            <CardFront className="-rotate-6" holder="YOUR NAME" />
            <div className="-mt-10 ml-auto w-[62%] rotate-3 rounded-2xl border border-line bg-surface p-4 shadow-xl">
              <div className="text-xs text-ink-3">卡片螢幕 · 所見即所簽</div>
              <div className="mt-2 rounded-lg bg-epaper p-3 font-mono text-[13px] leading-snug text-epaper-ink">
                轉帳 20,000 TWDC
                <br />→ 0x8a3f…c21e
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-ink-2">
                <FingerprintMark className="size-4 text-brand" /> 按指紋確認
              </div>
            </div>
          </div>
        </section>

        {/* ── 是什麼 ── */}
        <Section id="what" eyebrow="是什麼" title="數位身分證是一把鑰匙、一份證明，也是一個錢包">
          <div className="grid gap-4 md:grid-cols-3">
            <Feature
              icon={<Icon d="M7 11V8a5 5 0 0110 0v3M5 11h14v10H5zM12 15v2" />}
              title="一把只有你能用的鑰匙"
              body="建立身分時，手機的安全晶片產生一把私鑰（FIDO2／Passkey）。私鑰永遠不離開晶片，每次使用都要你的指紋或臉部辨識。"
            />
            <Feature
              icon={<Icon d="M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />}
              title="一份可以驗證的證明"
              body="完成實名驗證後，區塊鏈上記錄的是「這個身分已通過 L2 實名」，而不是你的姓名與證號。需要時只揭露必要的欄位，例如「已滿 18 歲」。"
            />
            <Feature
              icon={<Icon d="M3 7h18v12H3zM3 7l2-3h14l2 3M16 13h2" />}
              title="一個能收付的錢包"
              body="身分本身就是智能合約錢包：在聊天裡直接付款、刷 CAFECA 卡、開一個有額度上限的子錢包給 AI 代理使用。"
            />
          </div>

          <div className="mt-8 overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-surface-2 text-ink-3">
                <tr>
                  <th className="px-4 py-3 font-medium"></th>
                  <th className="px-4 py-3 font-medium">實體身分證＋帳號密碼</th>
                  <th className="px-4 py-3 font-medium text-brand">CAFECA 數位身分證</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <Row k="在網路上證明你是你" a="上傳證件照片、輸入密碼與簡訊碼" b="按一下指紋，網站驗證金鑰簽章" />
                <Row k="被釣魚網站騙走" a="密碼、驗證碼都可能被騙走" b="金鑰綁定網域，假網站拿不到可用的簽章" />
                <Row k="證明已成年" a="交出整張證件（姓名、證號、住址）" b="只證明「已滿 18 歲」這一件事" />
                <Row k="遺失時" a="補辦證件、逐一重設各網站密碼" b="用其他裝置、實體卡或平台備援找回同一個身分" />
                <Row k="由誰掌控" a="每個平台各自保管一份你的帳號" b="身分在區塊鏈上，由你的金鑰控制" />
              </tbody>
            </table>
          </div>
        </Section>

        {/* ── 為什麼需要 ── */}
        <Section id="why" eyebrow="為什麼需要" title="網路上的「你」，太容易被偷走、被冒用、被過度蒐集" tone="alt">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Problem
              title="密碼與簡訊碼擋不住詐騙"
              body="釣魚網站、假客服、SIM 卡盜用，都能騙走密碼和一次性驗證碼。FIDO2 金鑰無法被複製，也不會在假網站上生效。"
            />
            <Problem
              title="你不知道自己簽了什麼"
              body="許多詐騙是讓你在看不懂的畫面上按「確認」。大額操作會顯示在 CAFECA 卡的電子紙螢幕上，卡片只簽它顯示的內容。"
            />
            <Problem
              title="個資給出去就收不回來"
              body="租車、註冊、驗年齡，常常要交出整張證件。數位身分證只揭露必要的欄位，原文保存在你的裝置上。"
            />
            <Problem
              title="AI 開始替你花錢"
              body="AI 代理訂票、買資料、付 API 費用時，不該拿到你整個帳戶。子錢包有額度與白名單，超過就要你用卡片核准。"
            />
          </div>
        </Section>

        {/* ── 怎麼使用 ── */}
        <Section id="how" eyebrow="怎麼使用" title="一個身分，用在生活的每個地方">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <UseCase n="01" title="聊天中直接付款" body="和朋友分帳、向店家付款：在端對端加密的聊天裡發送付款請求，對方按一下就付清。" />
            <UseCase n="02" title="登入網站不用密碼" body="支援的網站看到你的身分簽章就能登入，不必再記一組密碼、等一封驗證信。" />
            <UseCase n="03" title="證明年齡或身分等級" body="買酒、租車、參加活動，只出示「已實名、已成年」的證明，不必交出證件影本。" />
            <UseCase n="04" title="交給 AI 代理辦事" body="開一個每日上限 500 元的子錢包給 AI，它在額度內自行付款，超額才來問你。隨時可以收回。" />
            <UseCase n="05" title="刷 CAFECA 卡消費" body="實體卡支援 Visa 感應付款，扣款只會動到卡片專用的支出通道，碰不到主帳戶。" />
            <UseCase n="06" title="換手機不用重來" body="新手機連結既有身分，所有裝置同級、一起管理；舊手機遺失就直接移除它。" />
          </div>
        </Section>

        {/* ── 三種金鑰 ── */}
        <Section
          id="keys"
          eyebrow="安全設計"
          title="三種金鑰，各司其職"
          lead="日常用的裝置金鑰方便、可以有很多把；等級較高的平台備援金鑰與實體卡，裝置金鑰無法移除，確保手機被盜時你仍然找得回身分。"
          tone="alt"
        >
          <div className="grid gap-4 lg:grid-cols-3">
            <KeyCard
              tag="每台裝置一把"
              title="裝置金鑰"
              who="你的手機、筆電（Passkey）"
              when="建立身分時自動產生第一把"
              can={["日常轉帳（在每日額度內）", "新增或移除其他裝置（所有裝置同級、共管）", "取消任何可疑的恢復請求"]}
              cannot={["移除平台備援金鑰或實體卡", "超過額度的大額轉帳（有卡時需卡片）"]}
            />
            <KeyCard
              tag="完成實名後啟用"
              title="平台備援金鑰"
              who="CAFECA 以硬體安全模組（HSM）託管，每個身分一把"
              when="用身分證件＋錄一段臉部影像完成實名驗證後"
              can={["在你遺失所有裝置、重新驗證本人後，把新裝置加回身分"]}
              cannot={["轉帳、調額度、動子錢包或卡片", "立即生效：一律等待 48 小時（有卡 7 天），期間你可以取消"]}
              highlight
            />
            <KeyCard
              tag="選購"
              title="CAFECA 實體卡"
              who="你自己：指紋感應＋電子紙螢幕＋安全晶片"
              when="完成實名驗證的身分付費購買"
              can={["大額轉帳、放寬額度、建立 AI 子錢包（螢幕確認後簽署）", "手機遺失時立即把新裝置加回", "Visa 感應付款"]}
              cannot={["被裝置金鑰或平台移除（只有卡片本身或掛失補發能註銷）"]}
            />
          </div>

          <div className="mt-8 rounded-2xl border border-line bg-surface p-5 sm:p-6">
            <h3 className="text-lg font-semibold">平台備援金鑰如果被盜怎麼辦？</h3>
            <p className="mt-1 text-sm text-ink-2">
              任何由平台保管的金鑰都有被盜的可能，所以我們假設它「會」被盜，並讓被盜的後果可控：
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Mitigation title="權限最小化" body="它唯一能做的事是發起恢復；不能轉帳、不能改額度、不能移除你的卡片。" />
              <Mitigation title="時間鎖＋通知" body="恢復要等 48 小時（有卡 7 天），期間轉出凍結，你所有裝置都會收到通知並能一鍵取消。" />
              <Mitigation title="取消後冷卻" body="被取消後 7 天內不能再發起；有爭議時，平台人工複核後的升級恢復只有實體卡能擋下。" />
              <Mitigation title="一人一把、可輪替" body="每個身分一把獨立金鑰，單把外洩只影響一人；平台以離線保存的根金鑰立即輪替或撤銷。" />
            </div>
          </div>
        </Section>

        {/* ── 開始 ── */}
        <Section id="start" eyebrow="開始使用" title="三個步驟，由淺入深">
          <ol className="grid gap-4 md:grid-cols-3">
            <Step
              n={1}
              title="建立數位身分"
              body="按一次指紋，手機產生金鑰並在區塊鏈上部署你的身分合約。免費，gas 由平台全額贊助。"
              time="約 10 秒"
            />
            <Step
              n={2}
              title="實名驗證"
              body="拍攝身分證件，依畫面指示錄一段約 9 秒的臉部影像（轉頭、眨眼、念數字）。通過後自動啟用平台備援金鑰。"
              time="約 2 分鐘"
            />
            <Step
              n={3}
              title="購買 CAFECA 實體卡"
              body="選購。擁有一把不能被移除的實體金鑰：大額交易要卡片螢幕確認，手機掉了也能立刻找回身分。"
              time="選購"
            />
          </ol>
          <div className="mt-8 flex justify-center">
            <LandingCta />
          </div>
        </Section>

        {/* ── FAQ ── */}
        <Section id="faq" eyebrow="常見問題" title="如果……怎麼辦？" tone="alt">
          <div className="mx-auto max-w-3xl divide-y divide-line rounded-2xl border border-line bg-surface">
            <Faq q="手機掉了怎麼辦？">
              還有其他已登入的裝置：直接在那台裝置移除遺失的手機。有 CAFECA 卡：在新手機建立金鑰，用卡片感應確認即可立即加回。兩者都沒有：在新手機重新拍證件、錄臉部影像，平台備援金鑰會在 48 小時後把新手機加回，期間舊金鑰無法轉出。
            </Faq>
            <Faq q="有人偷了我的手機，能把我的身分搶走嗎？">
              手機的金鑰需要你的指紋或臉部辨識才能使用。即使被破解，對方最多只能在每日額度內轉帳，也無法移除你的實體卡或平台備援金鑰；你可以用其他裝置移除被偷的手機，或用卡片、平台備援把身分拿回來。
            </Faq>
            <Faq q="CAFECA 可以動用我的錢嗎？">
              不行。平台備援金鑰在合約層面就沒有轉帳權限，只能發起「換裝置」的恢復，而且必須公開等待 48 小時，你隨時能取消。平台贊助的 gas 費也只是付手續費，不經手你的資產。
            </Faq>
            <Faq q="如果 CAFECA 公司不在了呢？">
              你的身分合約在 Boltchain 區塊鏈上，由你的裝置金鑰與卡片控制，不依賴 CAFECA 的伺服器存在。平台消失只代表少了一條備援恢復的管道。
            </Faq>
            <Faq q="我的臉部影像與證件會被保存在區塊鏈上嗎？">
              不會。區塊鏈上只有「已通過 L2 實名」的等級證明與欄位的雜湊根（Merkle root），看不出任何個資。影像只交給 KYC 單位比對本人，依法規保存與銷毀。
            </Faq>
            <Faq q="實體卡掉了呢？">
              卡片需要你的指紋才能簽署，撿到的人無法使用。你可以申請掛失補發：新卡綁定的同時舊卡會被註銷。這是唯一不需要舊卡本身就能移除卡片的方式，因此需要重新付款並由發卡方確認本人。
            </Faq>
          </div>
        </Section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-3 px-4 py-8 text-xs text-ink-3 sm:flex-row sm:items-center sm:px-6">
          <div>© CAFECA · Boltchain 測試網原型（chainId 8018），畫面與流程可能調整。</div>
          <div className="flex gap-4">
            <Link href="/start" className="hover:text-brand">建立身分</Link>
            <Link href="/link" className="hover:text-brand">連結裝置</Link>
            <Link href="/recover" className="hover:text-brand">恢復身分</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ───────────────────────── 版面元件 ─────────────────────────

function Section({
  id,
  eyebrow,
  title,
  lead,
  tone,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead?: string;
  tone?: "alt";
  children: ReactNode;
}) {
  return (
    <section id={id} className={tone === "alt" ? "scroll-mt-16 border-y border-line bg-surface-2" : "scroll-mt-16"}>
      <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 md:py-20">
        <p className="text-sm font-semibold tracking-wide text-brand">{eyebrow}</p>
        <h2 className="mt-2 max-w-3xl text-2xl font-bold leading-snug sm:text-3xl">{title}</h2>
        {lead && <p className="mt-3 max-w-3xl text-base leading-relaxed text-ink-2">{lead}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Feature({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="grid size-11 place-items-center rounded-xl bg-brand-bg text-brand">{icon}</div>
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

function Row({ k, a, b }: { k: string; a: string; b: string }) {
  return (
    <tr>
      <th className="px-4 py-3 font-medium">{k}</th>
      <td className="px-4 py-3 text-ink-2">{a}</td>
      <td className="px-4 py-3">{b}</td>
    </tr>
  );
}

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

function UseCase({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <div className="text-gradient font-mono text-sm font-bold">{n}</div>
      <h3 className="mt-2 font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

function KeyCard({
  tag,
  title,
  who,
  when,
  can,
  cannot,
  highlight,
}: {
  tag: string;
  title: string;
  who: string;
  when: string;
  can: string[];
  cannot: string[];
  highlight?: boolean;
}) {
  return (
    <div className={highlight ? "rounded-2xl border-2 border-brand bg-surface p-5" : "rounded-2xl border border-line bg-surface p-5"}>
      <span className="inline-flex rounded-full bg-brand-bg px-2 py-0.5 text-xs font-medium text-brand">{tag}</span>
      <h3 className="mt-3 text-xl font-bold">{title}</h3>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div>
          <dt className="inline text-ink-3">誰保管：</dt>
          <dd className="inline">{who}</dd>
        </div>
        <div>
          <dt className="inline text-ink-3">何時擁有：</dt>
          <dd className="inline">{when}</dd>
        </div>
      </dl>
      <div className="mt-4 text-sm">
        <div className="font-medium text-ok">可以</div>
        <ul className="mt-1 space-y-1 text-ink-2">
          {can.map((c) => (
            <li key={c} className="flex gap-2">
              <span className="text-ok">✓</span>
              {c}
            </li>
          ))}
        </ul>
        <div className="mt-3 font-medium text-danger">不能</div>
        <ul className="mt-1 space-y-1 text-ink-2">
          {cannot.map((c) => (
            <li key={c} className="flex gap-2">
              <span className="text-danger">✕</span>
              {c}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Mitigation({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-4">
      <div className="font-medium">{title}</div>
      <p className="mt-1 text-sm leading-relaxed text-ink-2">{body}</p>
    </div>
  );
}

function Step({ n, title, body, time }: { n: number; title: string; body: string; time: string }) {
  return (
    <li className="relative rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between">
        <span className="brand-gradient grid size-9 place-items-center rounded-full font-bold text-white">{n}</span>
        <span className="text-xs text-ink-3">{time}</span>
      </div>
      <h3 className="mt-3 text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">{body}</p>
    </li>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group px-5 py-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
        {q}
        <span className="text-ink-3 transition group-open:rotate-45">＋</span>
      </summary>
      <p className="mt-3 text-sm leading-relaxed text-ink-2">{children}</p>
    </details>
  );
}
