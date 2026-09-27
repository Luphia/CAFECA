// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasePaymaster} from "account-abstraction/core/BasePaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {UserOperationLib} from "account-abstraction/core/UserOperationLib.sol";
import {_packValidationData} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IAttestationView {
    function attestations(address account)
        external
        view
        returns (uint8 level, uint48 expiry, bytes32 claimsRoot, address signer);
}

interface IChannelParent {
    function parentOf(address channel) external view returns (address);
}

/// @title CafecaPaymaster
/// @notice 平台全額贊助 gas（規格 §8）。鏈下政策服務簽署 paymasterData，鏈上再以
///         「每個身分每日 UserOp 數與 gas 費上限」作為硬上限；支出通道計入其主帳戶額度。
/// @dev paymasterAndData = paymaster(20) ‖ verificationGas(16) ‖ postOpGas(16)
///                         ‖ validUntil(6) ‖ validAfter(6) ‖ day(6) ‖ signature(65)
///      day 由政策服務提供並簽署，鏈上以 validAfter/validUntil 限定在當日，避免驗證階段讀 TIMESTAMP。
///      Paymaster 需在 EntryPoint 質押，才能使用自身儲存。
contract CafecaPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    struct Usage {
        uint128 weiUsed;
        uint32 ops;
        uint48 day;
    }

    struct Tier {
        uint128 dailyWeiCap;
        uint32 dailyOpsCap;
    }

    uint256 private constant DATA_OFFSET = 52; // PAYMASTER_DATA_OFFSET
    uint256 private constant SIG_OFFSET = DATA_OFFSET + 18;

    address public policySigner;
    IAttestationView public immutable attestation;
    IChannelParent public immutable channels;
    mapping(uint8 level => Tier) public tiers;
    mapping(address identity => Usage) public usage;

    event PolicySignerSet(address signer);
    event TierSet(uint8 level, uint128 dailyWeiCap, uint32 dailyOpsCap);
    event Sponsored(address indexed identity, address indexed sender, uint256 actualGasCost);

    constructor(IEntryPoint ep, address signer_, address attestation_, address channels_) BasePaymaster(ep) {
        policySigner = signer_;
        attestation = IAttestationView(attestation_);
        channels = IChannelParent(channels_);
    }

    function setPolicySigner(address s) external onlyOwner {
        policySigner = s;
        emit PolicySignerSet(s);
    }

    function setTier(uint8 level, uint128 dailyWeiCap, uint32 dailyOpsCap) external onlyOwner {
        tiers[level] = Tier(dailyWeiCap, dailyOpsCap);
        emit TierSet(level, dailyWeiCap, dailyOpsCap);
    }

    function getHash(PackedUserOperation calldata op, uint48 validUntil, uint48 validAfter, uint48 day)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                op.sender,
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                bytes32(op.paymasterAndData[20:52]), // paymaster gas limits
                op.preVerificationGas,
                op.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter,
                day
            )
        );
    }

    function parsePaymasterData(bytes calldata pnd)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, uint48 day, bytes calldata sig)
    {
        validUntil = uint48(bytes6(pnd[DATA_OFFSET:DATA_OFFSET + 6]));
        validAfter = uint48(bytes6(pnd[DATA_OFFSET + 6:DATA_OFFSET + 12]));
        day = uint48(bytes6(pnd[DATA_OFFSET + 12:DATA_OFFSET + 18]));
        sig = pnd[SIG_OFFSET:];
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256 maxCost)
        internal
        override
        returns (bytes memory context, uint256 validationData)
    {
        (uint48 validUntil, uint48 validAfter, uint48 day, bytes calldata sig) = parsePaymasterData(op.paymasterAndData);

        // 限定在簽署的那一天
        uint48 dayStart = day * 1 days;
        uint48 dayEnd = dayStart + 1 days;
        if (validAfter < dayStart) validAfter = dayStart;
        if (validUntil == 0 || validUntil > dayEnd) validUntil = dayEnd;

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(op, validUntil, validAfter, day));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || signer != policySigner) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }

        address identity = channels.parentOf(op.sender);
        if (identity == address(0)) identity = op.sender;
        (uint8 level, uint48 attExpiry,,) = attestation.attestations(identity);
        if (level > 0 && attExpiry < validUntil) validUntil = attExpiry; // 等級過期後回到 L0 額度需重簽
        Tier memory t = tiers[level];

        Usage memory u = usage[identity];
        if (u.day != day) u = Usage(0, 0, day);
        if (u.ops + 1 > t.dailyOpsCap || uint256(u.weiUsed) + maxCost > t.dailyWeiCap) {
            return ("", _packValidationData(true, validUntil, validAfter));
        }
        u.ops += 1;
        u.weiUsed += uint128(maxCost);
        usage[identity] = u;

        context = abi.encode(identity, op.sender, maxCost, day);
        validationData = _packValidationData(false, validUntil, validAfter);
    }

    function _postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256) internal override {
        (address identity, address sender, uint256 maxCost, uint48 day) =
            abi.decode(context, (address, address, uint256, uint48));
        Usage storage u = usage[identity];
        if (u.day == day && maxCost > actualGasCost) {
            uint256 refund = maxCost - actualGasCost;
            u.weiUsed = u.weiUsed > refund ? u.weiUsed - uint128(refund) : 0;
        }
        emit Sponsored(identity, sender, actualGasCost);
    }
}
