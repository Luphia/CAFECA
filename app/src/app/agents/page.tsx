import { redirect } from "next/navigation";

/** AI 子錢包已整合到錢包頁 */
export default function AgentsPage() {
  redirect("/wallet?view=agents");
}
