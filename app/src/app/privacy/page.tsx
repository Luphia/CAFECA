import { connection } from "next/server";
import { TermsDoc } from "@/components/terms-doc";
import { termsDocs } from "@/server/terms";

/** 隱私權告知（目前版本，依 TERMS_VERSION） */
export default async function PrivacyPage() {
  await connection();
  const d = await termsDocs();
  return <TermsDoc md={d.privacy} version={d.version} hash={d.hash} />;
}
