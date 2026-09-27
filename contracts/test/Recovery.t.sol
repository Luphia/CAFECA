// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KeyringValidator} from "../src/modules/KeyringValidator.sol";
import {RecoveryValidator} from "../src/modules/RecoveryValidator.sol";
import {TxSummaryLib} from "../src/lib/TxSummary.sol";

contract RecoveryTest is Base {
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        account = _deployAccount();
    }

    function _request(RecoveryValidator.Path path, uint256 newPk)
        internal
        view
        returns (RecoveryValidator.RecoveryRequest memory req)
    {
        (bytes32 qx, bytes32 qy) = _pub(newPk);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (, uint64 n) = recovery.state(account);
        uint256 nonce = recovery.recoveryNonce(account, qx, qy, RP, n, expiry);
        bytes memory proof = verifier.makeProof([uint256(IDC), uint256(JWK), nonce, uint256(expiry)]);
        req.path = path;
        req.qx = qx;
        req.qy = qy;
        req.rpIdHash = RP;
        req.oidc = RecoveryValidator.OidcProof(IDC, JWK, expiry, proof);
    }

    function _initiateOp(RecoveryValidator.RecoveryRequest memory req) internal view returns (PackedUserOperation memory) {
        return _op(account, address(recovery), _exec(address(recovery), 0, abi.encodeCall(recovery.initiateRecovery, (req))));
    }

    function _smallTransfer(uint256 pk) internal view returns (PackedUserOperation memory op) {
        op = _op(account, address(keyring), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (bob, 1e6))));
        _signDaily(op, pk);
    }

    // ── R3：僅 OIDC，7 天時間鎖 ──

    function test_R3_TimelockThenExecute() public {
        _handle(_initiateOp(_request(RecoveryValidator.Path.R3_OIDC_ONLY, NEW_PHONE)));
        assertTrue(recovery.isPending(account));

        // 期間轉出凍結
        _handleExpectFail(_smallTransfer(PHONE));

        // 7 天前不能執行
        vm.expectRevert(RecoveryValidator.NotReady.selector);
        recovery.executeRecovery(account);

        vm.warp(block.timestamp + 7 days);
        recovery.executeRecovery(account); // 任何人可觸發
        assertFalse(recovery.isPending(account));

        // 舊金鑰被清除，新手機可用
        assertEq(uint8(keyring.getKey(account, _keyId(PHONE)).keyClass), uint8(KeyringValidator.KeyClass.NONE));
        _handle(_smallTransfer(NEW_PHONE));
        assertEq(twdc.balanceOf(bob), 1e6);
    }

    function test_R3_OwnerCancelsAndCooldown() public {
        _handle(_initiateOp(_request(RecoveryValidator.Path.R3_OIDC_ONLY, ATTACKER)));

        // 原主人用手機取消（收緊操作，恢復期間仍允許）
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(recovery), 0, abi.encodeCall(recovery.cancelRecovery, ())));
        _signDaily(op, PHONE);
        _handle(op);
        assertFalse(recovery.isPending(account));

        // 解凍
        _handle(_smallTransfer(PHONE));

        // 冷卻期內不能再發起
        _handleExpectFail(_initiateOp(_request(RecoveryValidator.Path.R3_OIDC_ONLY, ATTACKER)));
        vm.warp(block.timestamp + 7 days + 1); // EntryPoint 要求 timestamp > validAfter
        _handle(_initiateOp(_request(RecoveryValidator.Path.R3_OIDC_ONLY, ATTACKER)));
        assertTrue(recovery.isPending(account));
    }

    function test_R3_DisabledInMasterMode() public {
        _bindCard(account);
        _handleExpectFail(_initiateOp(_request(RecoveryValidator.Path.R3_OIDC_ONLY, ATTACKER)));
    }

    function test_InvalidProofRejected() public {
        RecoveryValidator.RecoveryRequest memory req = _request(RecoveryValidator.Path.R3_OIDC_ONLY, ATTACKER);
        req.oidc.proof = hex"deadbeef";
        _handleExpectFail(_initiateOp(req));
    }

    function test_ExpiredJwtRejected() public {
        RecoveryValidator.RecoveryRequest memory req = _request(RecoveryValidator.Path.R3_OIDC_ONLY, ATTACKER);
        vm.warp(block.timestamp + 2 hours);
        _handleExpectFail(_initiateOp(req)); // validUntil = JWT expiry
    }

    function test_RetiredJwksKeyGracePeriod() public {
        vm.prank(system);
        jwks.retireKey(JWK);
        vm.warp(block.timestamp + 73 hours);
        _handleExpectFail(_initiateOp(_request(RecoveryValidator.Path.R3_OIDC_ONLY, NEW_PHONE)));
    }

    // ── R1：OIDC＋卡片，立即 ──

    function test_R1_CardImmediate() public {
        _bindCard(account);
        RecoveryValidator.RecoveryRequest memory req = _request(RecoveryValidator.Path.R1_CARD, NEW_PHONE);

        // 沒有卡片簽章 → 拒絕
        PackedUserOperation memory op = _initiateOp(req);
        _handleExpectFail(op);

        // 卡片螢幕顯示「新增裝置 keyId(NEW_PHONE)」，對 userOpHash 簽章
        op = _initiateOp(req);
        bytes32 ctxd = TxSummaryLib.single(recovery.recoverySummary(account, req.qx, req.qy));
        _signWith(op, CARD, _cardAuthData(ctxd));
        _handle(op);

        assertFalse(recovery.isPending(account)); // 立即生效
        assertEq(uint8(keyring.getKey(account, _keyId(NEW_PHONE)).keyClass), uint8(KeyringValidator.KeyClass.DAILY));
        assertTrue(keyring.isMasterMode(account)); // 卡片保留
        _handle(_smallTransfer(NEW_PHONE));
    }

    function test_R1_WrongDisplayRejected() public {
        _bindCard(account);
        RecoveryValidator.RecoveryRequest memory req = _request(RecoveryValidator.Path.R1_CARD, ATTACKER);
        PackedUserOperation memory op = _initiateOp(req);
        // 卡片被誘導顯示的是 NEW_PHONE，但實際要加的是 ATTACKER
        (bytes32 qx, bytes32 qy) = _pub(NEW_PHONE);
        bytes32 ctxd = TxSummaryLib.single(recovery.recoverySummary(account, qx, qy));
        _signWith(op, CARD, _cardAuthData(ctxd));
        _handleExpectFail(op);
    }

    // ── R2：OIDC＋發卡方重新 KYC，48h ──

    function test_R2_RekycAfter48h_WipesCard() public {
        _bindCard(account);
        RecoveryValidator.RecoveryRequest memory req = _request(RecoveryValidator.Path.R2_REKYC, NEW_PHONE);
        (, uint64 n) = recovery.state(account);
        req.kycSig = _ethSign(kycPk, recovery.rekycDigest(account, req.qx, req.qy, RP, n));
        _handle(_initiateOp(req));

        vm.warp(block.timestamp + 48 hours);
        recovery.executeRecovery(account);
        assertFalse(keyring.isMasterMode(account));
        assertEq(uint8(keyring.getKey(account, _keyId(CARD)).keyClass), uint8(KeyringValidator.KeyClass.NONE));
        assertEq(uint8(keyring.getKey(account, _keyId(NEW_PHONE)).keyClass), uint8(KeyringValidator.KeyClass.DAILY));
    }

    function test_R2_FakeKycRejected() public {
        RecoveryValidator.RecoveryRequest memory req = _request(RecoveryValidator.Path.R2_REKYC, ATTACKER);
        (, uint64 n) = recovery.state(account);
        req.kycSig = _ethSign(0xFA4E, recovery.rekycDigest(account, req.qx, req.qy, RP, n));
        _handleExpectFail(_initiateOp(req));
    }
}
