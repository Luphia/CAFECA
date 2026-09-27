import "server-only";
import { encodeAbiParameters, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID } from "@/lib/config";
import { signerOf } from "./chain";
import { env } from "./env";

/** 票券發行方（測試網以商家金鑰代表）：對「票券 id＋持有人」簽章，驗票端離線即可驗證 */
function digest(id: string, holder: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "string" }, { type: "address" }], ["CAFECA_TICKET", BigInt(CHAIN_ID), id, holder]));
}

export function ticketIssuer(): Address {
  return privateKeyToAccount(env.merchantKey()).address;
}

export async function signTicket(id: string, holder: Address): Promise<Hex> {
  return signerOf(env.merchantKey()).signMessage({ message: { raw: digest(id, holder) } });
}

export async function verifyTicket(id: string, holder: Address, sig: Hex): Promise<boolean> {
  try {
    const signer = await recoverMessageAddress({ message: { raw: digest(id, holder) }, signature: sig });
    return signer.toLowerCase() === ticketIssuer().toLowerCase();
  } catch {
    return false;
  }
}
