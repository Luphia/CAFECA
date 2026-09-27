// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KeyringValidator} from "../src/modules/KeyringValidator.sol";
import {RecoveryValidator} from "../src/modules/RecoveryValidator.sol";

/// @notice 恢復：有卡片 → 卡片直接新增裝置；裝置全失 → 平台備援金鑰（KYC 後託管）＋時間鎖
contract RecoveryTest is Base {
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        account = _deployAccount();
        _kyc(account);
    }

    function _initiateOp(uint256 newPk, bool escalated, uint256 signerPk) internal view returns (PackedUserOperation memory op) {
        (bytes32 qx, bytes32 qy) = _pub(newPk);
        op = _op(
            account,
            address(recovery),
            _exec(address(recovery), 0, abi.encodeCall(recovery.initiateRecovery, (qx, qy, RP, escalated)))
        );
        _signOperator(op, signerPk);
    }

    function _cancelOp(uint256 pk, bool card) internal view returns (PackedUserOperation memory op) {
        op = _op(account, address(keyring), _exec(address(recovery), 0, abi.encodeCall(recovery.cancelRecovery, ())));
        if (card) _signCard(op);
        else _signDaily(op, pk);
    }

    function _smallTransfer(uint256 pk) internal view returns (PackedUserOperation memory op) {
        op = _op(account, address(keyring), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (bob, 1e6))));
        _signDaily(op, pk);
    }

    // ── 有卡片：卡片直接新增新手機，不經平台 ──

    function test_CardAddsNewDeviceImmediately() public {
        _bindCard(account);
        (bytes32 qx, bytes32 qy) = _pub(NEW_PHONE);
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(keyring), 0, abi.encodeCall(keyring.addDailyKey, (qx, qy, RP))));
        _signCard(op);
        _handle(op);
        _handle(_smallTransfer(NEW_PHONE));
        assertEq(twdc.balanceOf(bob), 1e6);
    }

    // ── 平台備援金鑰的安裝 ──

    function test_Guardian_RequiresPlatformAuthority() public {
        // 盜用手機的人想裝自己的「不可移除」金鑰：沒有平台根金鑰簽章 → 執行失敗
        address g = vm.addr(ATTACKER);
        bytes memory sig = _ethSign(ATTACKER, recovery.guardianDigest(account, g, 0));
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(recovery), 0, abi.encodeCall(recovery.setGuardian, (g, sig))));
        _signDaily(op, PHONE);
        _handle(op);
        assertEq(recovery.guardianOf(account), address(0));

        _setGuardian(account);
        assertEq(recovery.guardianOf(account), vm.addr(guardianPk));
    }

    function test_Guardian_CannotBeReplacedOrRemovedByDevice() public {
        _setGuardian(account);
        // 再安裝一次（即使有根金鑰簽章）→ GuardianAlreadySet
        address g2 = vm.addr(ATTACKER);
        (,,, uint64 n) = recovery.state(account);
        bytes memory sig = _ethSign(rootPk, recovery.guardianDigest(account, g2, n));
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(recovery), 0, abi.encodeCall(recovery.setGuardian, (g2, sig))));
        _signDaily(op, PHONE);
        _handle(op);
        assertEq(recovery.guardianOf(account), vm.addr(guardianPk));

        // 裝置金鑰不能直接呼叫 rotateGuardian / 移除模組
        op = _op(
            account,
            address(keyring),
            _exec(address(recovery), 0, abi.encodeCall(recovery.rotateGuardian, (account, address(0), sig)))
        );
        _signDaily(op, PHONE);
        _handleExpectFail(op);
    }

    function test_Guardian_CanOnlyRecover_NotTransfer() public {
        _setGuardian(account);
        PackedUserOperation memory op =
            _op(account, address(recovery), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (bob, 1e6))));
        _signOperator(op, guardianPk);
        _handleExpectFail(op);
        // 也不能拿來登入（ERC-1271）
        assertEq(recovery.isValidSignatureWithSender(address(0), bytes32(0), ""), bytes4(0xffffffff));
    }

    // ── 裝置全失：備援金鑰恢復 ──

    function test_Guardian_Recovery48h_WipesDevices_KeepsNothingElse() public {
        _setGuardian(account);
        _handle(_initiateOp(NEW_PHONE, false, guardianPk));
        assertTrue(recovery.isPending(account));
        _handleExpectFail(_smallTransfer(PHONE)); // 期間轉出凍結

        vm.expectRevert(RecoveryValidator.NotReady.selector);
        recovery.executeRecovery(account);

        vm.warp(block.timestamp + 48 hours);
        recovery.executeRecovery(account);
        assertEq(uint8(keyring.getKey(account, _keyId(PHONE)).keyClass), uint8(KeyringValidator.KeyClass.NONE));
        _handle(_smallTransfer(NEW_PHONE));
        assertEq(recovery.guardianOf(account), vm.addr(guardianPk)); // 備援金鑰仍在
    }

    function test_Guardian_WithCard_7Days_CardKept() public {
        _bindCard(account);
        _setGuardian(account);
        _handle(_initiateOp(NEW_PHONE, false, guardianPk));
        (, , uint48 readyAt,,,) = recovery.pending(account);
        assertEq(readyAt, uint48(block.timestamp + 7 days));
        vm.warp(block.timestamp + 7 days);
        recovery.executeRecovery(account);
        assertTrue(keyring.isMasterMode(account)); // 卡片不可被備援金鑰移除
        assertEq(keyring.keysOf(account).length, 2);
    }

    function test_Guardian_WrongSignerRejected() public {
        _setGuardian(account);
        _handleExpectFail(_initiateOp(ATTACKER, false, 0xFA4E));
        _handleExpectFail(_initiateOp(ATTACKER, false, rootPk)); // 根金鑰也不能直接發起，只能輪替
    }

    function test_NoGuardian_NoRecovery() public {
        _handleExpectFail(_initiateOp(NEW_PHONE, false, guardianPk));
    }

    // ── 備援金鑰被盜的情境 ──

    function test_StolenGuardian_OwnerCancelsAndCooldown() public {
        _setGuardian(account);
        _handle(_initiateOp(ATTACKER, false, guardianPk)); // 攻擊者拿到備援金鑰
        _handle(_cancelOp(PHONE, false)); // 本人任何裝置都能取消
        assertFalse(recovery.isPending(account));
        _handle(_smallTransfer(PHONE)); // 解凍

        _handleExpectFail(_initiateOp(ATTACKER, false, guardianPk)); // 冷卻期
        vm.warp(block.timestamp + 7 days + 1);
        _handle(_initiateOp(ATTACKER, false, guardianPk));
        assertTrue(recovery.isPending(account));
    }

    function test_StolenGuardian_RootRotatesAndClearsPending() public {
        _setGuardian(account);
        _handle(_initiateOp(ATTACKER, false, guardianPk));
        // 平台發現外洩：以離線根金鑰輪替，任何人可代送
        address fresh = vm.addr(0x6A4D2);
        (,,, uint64 n) = recovery.state(account);
        recovery.rotateGuardian(account, fresh, _ethSign(rootPk, recovery.guardianDigest(account, fresh, n)));
        assertFalse(recovery.isPending(account));
        assertEq(recovery.guardianOf(account), fresh);
        vm.warp(block.timestamp + 7 days + 1);
        _handleExpectFail(_initiateOp(ATTACKER, false, guardianPk)); // 舊金鑰失效
    }

    function test_RotateRequiresRoot_AndNonceNotReplayable() public {
        _setGuardian(account);
        (,,, uint64 n) = recovery.state(account);
        bytes memory fake = _ethSign(guardianPk, recovery.guardianDigest(account, address(0), n));
        vm.expectRevert(RecoveryValidator.InvalidAuthority.selector);
        recovery.rotateGuardian(account, address(0), fake);

        bytes memory sig = _ethSign(rootPk, recovery.guardianDigest(account, address(0), n));
        recovery.rotateGuardian(account, address(0), sig); // 撤銷（使用者申請停用）
        assertEq(recovery.guardianOf(account), address(0));
    }

    // ── 裝置被盜、盜用者阻擋恢復：爭議升級 ──

    function test_Dispute_EscalatedOnlyCardCanCancel() public {
        _bindCard(account);
        _setGuardian(account);
        _handle(_initiateOp(NEW_PHONE, false, guardianPk));
        _handle(_cancelOp(PHONE, false)); // 盜用手機者取消 → 記錄爭議

        // 未經爭議不能直接升級（在上面這次取消之前）已由 disputedAt 控制；現在平台複核後升級
        _handle(_initiateOp(NEW_PHONE, true, guardianPk));
        assertTrue(recovery.isEscalated(account));
        _handleExpectFail(_cancelOp(PHONE, false)); // 裝置金鑰無法再取消

        // 卡片可以（本人仍持卡的情況）
        _handle(_cancelOp(0, true));
        assertFalse(recovery.isPending(account));
    }

    function test_Dispute_EscalatedWithoutDisputeRejected() public {
        _setGuardian(account);
        _handleExpectFail(_initiateOp(NEW_PHONE, true, guardianPk));
    }

    function test_Dispute_EscalatedExecutesAfter7Days() public {
        _setGuardian(account);
        _handle(_initiateOp(NEW_PHONE, false, guardianPk));
        _handle(_cancelOp(PHONE, false));
        _handle(_initiateOp(NEW_PHONE, true, guardianPk));
        vm.warp(block.timestamp + 7 days);
        recovery.executeRecovery(account);
        _handle(_smallTransfer(NEW_PHONE));
        _handleExpectFail(_smallTransfer(PHONE)); // 盜用者的裝置金鑰已清除
    }
}
