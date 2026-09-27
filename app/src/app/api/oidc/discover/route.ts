import { accountOf, verifyIdToken } from "@/server/oidc";
import { handle } from "@/server/session";
import { read } from "@/server/store";

/** 由 id_token 找出身分帳戶地址（不需 nonce；用於登入既有帳戶與恢復第一步） */
export const POST = handle(async (req: Request) => {
  const { idToken } = (await req.json()) as { idToken: string };
  const t = await verifyIdToken(idToken);
  const acct = await accountOf(t.idCommitment);
  const store = await read();
  return Response.json({
    provider: t.provider,
    email: t.payload.email ?? null,
    idCommitment: t.idCommitment,
    address: acct.address,
    deployed: acct.deployed,
    handle: store.profiles[acct.address]?.handle ?? null,
  });
});
