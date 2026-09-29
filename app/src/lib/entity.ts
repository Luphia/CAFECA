import { concat, encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { CHAIN_ID, DEPLOYMENT } from "./config";
import { entityAccountFactoryAbi, memberValidatorAbi } from "./contracts/abis";
import { publicClient, submitOp, type LocalWallet } from "./client";
import { encode1271, execCall } from "./userop";
import { signWithPasskey } from "./webauthn";

/**
 * 法人帳戶（規格 §16.4）的錢包端：成員以自己的 Passkey 代法人簽署。
 * 成員簽的是 entityHash(entity, hash)，與 MemberValidator.entityHash 相同。
 */

export const ROLE = { NONE: 0, OPERATOR: 1, ADMIN: 2 } as const;
export const ROLE_LABEL: Record<number, string> = { 0: "—", 1: "經辦", 2: "管理者" };

const TYPEHASH = keccak256(toHex("CAFECA_ENTITY_V1"));

export function entityHash(entity: Address, hash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      [TYPEHASH, BigInt(CHAIN_ID), DEPLOYMENT.memberValidator!, entity, hash],
    ),
  );
}

function memberSig(member: Address, sig1271: Hex): Hex {
  return encodeAbiParameters([{ type: "tuple", components: [{ name: "member", type: "address" }, { name: "signature", type: "bytes" }] }], [{ member, signature: sig1271 }]);
}

/** 以成員身分代法人簽一個雜湊，回傳 MemberValidator 的簽章資料（不含 validator 前綴） */
export async function signAsMember(w: LocalWallet, entity: Address, hash: Hex): Promise<Hex> {
  const { keyId, sig } = await signWithPasskey(entityHash(entity, hash), w.passkeys);
  return memberSig(w.address, encode1271(DEPLOYMENT.keyring, keyId, sig));
}

/** 法人的 ERC-1271 簽章（例如 Sign in with CAFECA「以公司身分」）：MemberValidator(20) ‖ MemberSig */
export async function entity1271(w: LocalWallet, entity: Address, hash: Hex): Promise<Hex> {
  return concat([DEPLOYMENT.memberValidator!, await signAsMember(w, entity, hash)]);
}

/** 以法人帳戶送出 UserOp（由 MemberValidator 驗證成員簽章與權限） */
export function runEntityOp(w: LocalWallet, entity: Address, callData: Hex) {
  return submitOp({ sender: entity, validator: DEPLOYMENT.memberValidator!, callData, signer: (hash) => signAsMember(w, entity, hash) });
}

export function predictEntity(admin: Address, salt: Hex): Promise<Address> {
  return publicClient.readContract({ address: DEPLOYMENT.entityFactory!, abi: entityAccountFactoryAbi, functionName: "getAddress", args: [admin, salt] });
}

export function createEntityCall(salt: Hex): Hex {
  return execCall(DEPLOYMENT.entityFactory!, encodeFunctionData({ abi: entityAccountFactoryAbi, functionName: "createEntity", args: [salt] }));
}

export function setMemberCall(member: Address, role: number): Hex {
  return execCall(DEPLOYMENT.memberValidator!, encodeFunctionData({ abi: memberValidatorAbi, functionName: "setMember", args: [member, role] }));
}

export async function entityLimits(entity: Address) {
  const [lim, sp] = await Promise.all([
    publicClient.readContract({ address: DEPLOYMENT.memberValidator!, abi: memberValidatorAbi, functionName: "limits", args: [DEPLOYMENT.twdc, entity] }),
    publicClient.readContract({ address: DEPLOYMENT.memberValidator!, abi: memberValidatorAbi, functionName: "spent", args: [DEPLOYMENT.twdc, entity] }),
  ]);
  const inWindow = Date.now() / 1000 < Number(sp[1]) + 86400;
  return { perTx: lim[0], daily: lim[1], spent: inWindow ? sp[0] : 0n };
}
