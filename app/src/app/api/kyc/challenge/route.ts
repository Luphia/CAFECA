import { newLivenessChallenge } from "@/server/kyc";
import { handle } from "@/server/session";

/** 取得一次性的臉部影像指示（不需登入：新裝置恢復身分時也會用到） */
export const POST = handle(async () => Response.json(await newLivenessChallenge()));
