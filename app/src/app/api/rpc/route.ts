import { env } from "@/server/env";

/** 瀏覽器用的唯讀 RPC 代理（測試網 RPC 只在本機網路可達，也避免 CORS） */
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getLogs",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_gasPrice",
  "eth_estimateGas",
  "net_version",
]);

type RpcReq = { method: string; id?: number | string };

export async function POST(req: Request) {
  const body = (await req.json()) as RpcReq | RpcReq[];
  const list = Array.isArray(body) ? body : [body];
  const bad = list.find((r) => !ALLOWED.has(r.method));
  if (bad) {
    return Response.json({ jsonrpc: "2.0", id: bad.id ?? null, error: { code: -32601, message: `method ${bad.method} not allowed` } });
  }
  const res = await fetch(env.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
}
