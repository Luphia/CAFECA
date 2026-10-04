import type { ReactNode } from "react";

/** 條款的簡易 markdown 顯示（# 標題、## 小標、> 引言、- 清單、段落） */
export function TermsDoc({ md, version, hash }: { md: string; version: string; hash: string }) {
  const out: ReactNode[] = [];
  const blocks = md.trim().split(/\n\s*\n/);
  blocks.forEach((b, i) => {
    const t = b.trim();
    if (t.startsWith("# ")) out.push(<h1 key={i} className="text-2xl font-bold">{t.slice(2)}</h1>);
    else if (t.startsWith("## ")) out.push(<h2 key={i} className="pt-2 text-lg font-semibold">{t.slice(3)}</h2>);
    else if (t.startsWith("> ")) out.push(<p key={i} className="rounded-xl border border-line bg-surface-2 p-3 text-sm text-ink-2">{t.replace(/^> ?/gm, "")}</p>);
    else if (t.startsWith("- ")) out.push(<ul key={i} className="list-disc space-y-1 pl-5">{t.split("\n").map((l, j) => <li key={j}>{l.replace(/^- /, "")}</li>)}</ul>);
    else out.push(<p key={i}>{t}</p>);
  });
  return (
    <div className="mx-auto max-w-2xl space-y-3 px-5 py-10 leading-relaxed">
      {out}
      <p className="pt-4 text-xs text-ink-3">版本 {version} · 內容雜湊 <span className="font-mono">{hash.slice(0, 16)}…</span></p>
    </div>
  );
}
