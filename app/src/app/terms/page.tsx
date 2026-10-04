import { connection } from "next/server";
import { TermsDoc } from "@/components/terms-doc";
import { termsDocs } from "@/server/terms";

/** 服務條款（目前版本，依 TERMS_VERSION） */
export default async function TermsPage() {
  await connection();
  const d = await termsDocs();
  return <TermsDoc md={d.terms} version={d.version} hash={d.hash} />;
}
