import {
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  concat,
  type Address,
  type Hex,
} from "viem";
import { cafecaAccountAbi } from "./contracts/abis";

/** EntryPoint v0.8 PackedUserOperation（JSON 傳輸時所有數字以 hex 字串表示） */
export type UserOp = {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: Hex;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type Execution = { target: Address; value: bigint; data: Hex };

export const MODE_SINGLE = ("0x" + "00".repeat(32)) as Hex;
export const MODE_BATCH = ("0x01" + "00".repeat(31)) as Hex;

export function execCall(target: Address, data: Hex = "0x", value = 0n): Hex {
  return encodeFunctionData({
    abi: cafecaAccountAbi,
    functionName: "execute",
    args: [MODE_SINGLE, encodePacked(["address", "uint256", "bytes"], [target, value, data])],
  });
}

export function execBatch(execs: Execution[]): Hex {
  const ec = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    [execs.map((e) => ({ target: e.target, value: e.value, callData: e.data }))],
  );
  return encodeFunctionData({ abi: cafecaAccountAbi, functionName: "execute", args: [MODE_BATCH, ec] });
}

/** nonce key：validator 地址放在 nonce 的最高 160 bits */
export function nonceKey(validator: Address): bigint {
  return BigInt(validator) << 32n;
}

export type WebAuthnSig = {
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: Hex;
  s: Hex;
};

const SIG_TUPLE = {
  type: "tuple",
  components: [
    { name: "keyId", type: "bytes32" },
    {
      name: "sig",
      type: "tuple",
      components: [
        { name: "authenticatorData", type: "bytes" },
        { name: "clientDataJSON", type: "string" },
        { name: "challengeIndex", type: "uint256" },
        { name: "typeIndex", type: "uint256" },
        { name: "r", type: "bytes32" },
        { name: "s", type: "bytes32" },
      ],
    },
  ],
} as const;

/** KeyringValidator.SignatureData */
export function encodeKeyringSignature(keyId: Hex, sig: WebAuthnSig): Hex {
  return encodeAbiParameters([SIG_TUPLE], [{ keyId, sig }]);
}

/** ERC-1271：validator(20 bytes) ‖ SignatureData */
export function encode1271(validator: Address, keyId: Hex, sig: WebAuthnSig): Hex {
  return concat([validator, encodeKeyringSignature(keyId, sig)]);
}

export type TxSummary = {
  kind: number;
  chainId: bigint;
  token: Address;
  amount: bigint;
  counterparty: Address;
  extra: Hex;
};

export const TX_SUMMARY_ARRAY = [
  {
    type: "tuple[]",
    components: [
      { name: "kind", type: "uint8" },
      { name: "chainId", type: "uint256" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "counterparty", type: "address" },
      { name: "extra", type: "bytes32" },
    ],
  },
] as const;

export function encodeSummaries(s: readonly TxSummary[]): Hex {
  return encodeAbiParameters(TX_SUMMARY_ARRAY, [s as TxSummary[]]);
}

export function toJsonSafe<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? "0x" + x.toString(16) : x)));
}
