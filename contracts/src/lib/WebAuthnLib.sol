// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// @notice WebAuthn（ES256）斷言驗證，以及 CAFECA 卡片的 CTXD「所見即所簽」擴充解析。
/// P-256 驗證透過 OZ P256：優先呼叫 EIP-7951 precompile (0x100)，不存在時退回 Solidity 實作。
library WebAuthnLib {
    struct Sig {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex; // clientDataJSON 中 `"challenge":"` 的起始位置
        uint256 typeIndex; // clientDataJSON 中 `"type":"webauthn.get"` 的起始位置
        bytes32 r;
        bytes32 s;
    }

    bytes1 internal constant FLAG_UP = 0x01; // user present
    bytes1 internal constant FLAG_UV = 0x04; // user verified（指紋、PIN）
    bytes1 internal constant FLAG_BE = 0x08; // backup eligible（可同步）
    bytes1 internal constant FLAG_BS = 0x10; // backup state（已同步）
    bytes1 internal constant FLAG_AT = 0x40; // attested credential data
    bytes1 internal constant FLAG_ED = 0x80; // extension data

    /// @dev 固定格式擴充：CBOR map(1) { "ctxd": bstr(32) }
    /// A1 | 64 63 74 78 64 ("ctxd") | 58 20 (bstr len 32)
    bytes8 internal constant CTXD_PREFIX = 0xA164637478645820;
    uint256 internal constant CTXD_AUTHDATA_LENGTH = 37 + 8 + 32;

    /// @dev secp256r1 n / 2，用於拒絕 high-s（簽章可延展性）
    uint256 internal constant P256_N_DIV_2 = 0x7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8;

    bytes internal constant TYPE_GET = '"type":"webauthn.get"';

    function verify(bytes memory challenge, Sig memory sig, bytes32 rpIdHash, bytes32 qx, bytes32 qy)
        internal
        view
        returns (bool)
    {
        bytes memory ad = sig.authenticatorData;
        if (ad.length < 37) return false;

        bytes32 adRpIdHash;
        assembly {
            adRpIdHash := mload(add(ad, 32))
        }
        if (adRpIdHash != rpIdHash) return false;

        bytes1 f = ad[32];
        if ((f & FLAG_UP) == 0 || (f & FLAG_UV) == 0) return false;
        if ((f & FLAG_AT) != 0) return false; // 斷言不應帶 attested credential data

        bytes memory cd = bytes(sig.clientDataJSON);
        if (!_contains(cd, sig.typeIndex, TYPE_GET)) return false;
        bytes memory expected = abi.encodePacked('"challenge":"', Base64.encodeURL(challenge), '"');
        if (!_contains(cd, sig.challengeIndex, expected)) return false;

        if (uint256(sig.s) > P256_N_DIV_2) return false;

        bytes32 h = sha256(abi.encodePacked(ad, sha256(cd)));
        return P256.verify(h, sig.r, sig.s, qx, qy);
    }

    function flags(bytes memory authenticatorData) internal pure returns (bytes1) {
        return authenticatorData.length > 32 ? authenticatorData[32] : bytes1(0);
    }

    /// @notice 取出卡片寫入的 ctxd（= sha256(abi.encode(TxSummary[]))）
    function extractCtxd(bytes memory ad) internal pure returns (bool present, bytes32 ctxd) {
        if (ad.length != CTXD_AUTHDATA_LENGTH) return (false, bytes32(0));
        if ((ad[32] & FLAG_ED) == 0) return (false, bytes32(0));
        bytes32 word;
        assembly {
            word := mload(add(ad, 69)) // 32 (length word) + 37
            ctxd := mload(add(ad, 77)) // 32 + 45
        }
        if (bytes8(word) != CTXD_PREFIX) return (false, bytes32(0));
        present = true;
    }

    function _contains(bytes memory haystack, uint256 index, bytes memory needle) private pure returns (bool) {
        if (index + needle.length > haystack.length) return false;
        for (uint256 i = 0; i < needle.length; i++) {
            if (haystack[index + i] != needle[i]) return false;
        }
        return true;
    }
}
