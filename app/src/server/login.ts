import "server-only";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { CHAIN_ID } from "@/lib/config";

export function loginHash(address: Address, nonce: Hex, exp: number) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }],
      ["CAFECA_LOGIN", BigInt(CHAIN_ID), address, nonce, BigInt(exp)],
    ),
  );
}
