// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IdentityRegistry} from "../src/registry/IdentityRegistry.sol";

contract IdentityRegistryTest is Test {
    IdentityRegistry reg;
    address gov = makeAddr("gov");
    uint256 protoPk = 0xA11;
    uint256 prodPk = 0xB22;
    uint256 evilPk = 0xE71;
    address user = makeAddr("user");
    bytes32 constant ROOT = keccak256("claims");
    bytes2 constant TW = "TW";

    event Attested(address indexed account, uint8 subjectType, uint8 level, uint48 expiry, bytes32 claimsRoot, bytes2 jurisdiction, address signer, uint64 nonce);
    event Revoked(address indexed account, uint8 reason, address by, uint64 nonce);
    event Suspended(address indexed account, uint8 reason, address by, uint64 nonce);

    function setUp() public {
        vm.warp(1_800_000_000);
        reg = new IdentityRegistry(gov);
        vm.startPrank(gov);
        reg.setSigner(vm.addr(protoPk), IdentityRegistry.SignerClass.PROTOTYPE);
        reg.setSigner(vm.addr(prodPk), IdentityRegistry.SignerClass.PRODUCTION);
        vm.stopPrank();
    }

    function _attestSig(uint256 pk, address a, uint8 st, uint8 lvl, uint48 exp, uint64 n) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, reg.attestDigest(a, st, lvl, exp, ROOT, TW, n));
        return abi.encodePacked(r, s, v);
    }

    function _statusSig(uint256 pk, address a, IdentityRegistry.Status st, uint8 reason, uint64 n) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, reg.statusDigest(a, st, reason, n));
        return abi.encodePacked(r, s, v);
    }

    function _attest(uint256 pk, uint8 st, uint8 lvl) internal returns (bytes memory sig, uint64 n, uint48 exp) {
        n = reg.nonceOf(user) + 1;
        exp = uint48(block.timestamp + 365 days);
        sig = _attestSig(pk, user, st, lvl, exp, n);
        reg.attest(user, st, lvl, exp, ROOT, TW, n, sig);
    }

    function test_attestAndRead() public {
        vm.expectEmit(true, false, false, true);
        emit Attested(user, 0, 2, uint48(block.timestamp + 365 days), ROOT, TW, vm.addr(prodPk), 1);
        _attest(prodPk, 0, 2);
        assertEq(reg.levelOf(user), 2);
        assertEq(reg.productionLevelOf(user), 2);
        (uint8 st,, uint8 eff, IdentityRegistry.Status status,,, bytes2 j, uint64 n,, IdentityRegistry.SignerClass cls,) = reg.statusOf(user);
        assertEq(st, 0);
        assertEq(eff, 2);
        assertEq(uint8(status), uint8(IdentityRegistry.Status.ACTIVE));
        assertEq(j, TW);
        assertEq(n, 1);
        assertEq(uint8(cls), uint8(IdentityRegistry.SignerClass.PRODUCTION));
    }

    function test_prototypeNotProduction() public {
        _attest(protoPk, 0, 2);
        assertEq(reg.levelOf(user), 2);
        assertEq(reg.productionLevelOf(user), 0);
    }

    /// v1 的漏洞：撤銷後重送舊的 L2 簽章就能恢復。v2 必須拒絕
    function test_replayAfterRevokeRejected() public {
        (bytes memory oldSig, uint64 n, uint48 exp) = _attest(prodPk, 0, 2);
        reg.revoke(user, reg.REASON_EVIDENCE_INVALID(), 2, _statusSig(prodPk, user, IdentityRegistry.Status.REVOKED, 2, 2));
        assertEq(reg.levelOf(user), 0);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.BadNonce.selector, uint64(3)));
        reg.attest(user, 0, 2, exp, ROOT, TW, n, oldSig);
        assertEq(reg.levelOf(user), 0);
    }

    function test_revokeEventAndGovernancePath() public {
        _attest(prodPk, 1, 2);
        vm.expectEmit(true, false, false, true);
        emit Revoked(user, 3, gov, 2);
        vm.prank(gov);
        reg.revoke(user, 3, 2, "");
        assertEq(reg.levelOf(user), 0);
        // 非治理不能不帶簽章撤銷
        _attest(prodPk, 1, 2);
        vm.expectRevert(IdentityRegistry.OnlyGovernance.selector);
        reg.revoke(user, 3, 4, "");
    }

    function test_suspendThenReattest() public {
        _attest(protoPk, 0, 2);
        vm.expectEmit(true, false, false, true);
        emit Suspended(user, 5, vm.addr(protoPk), 2);
        reg.suspend(user, 5, 2, _statusSig(protoPk, user, IdentityRegistry.Status.SUSPENDED, 5, 2));
        assertEq(reg.levelOf(user), 0);
        _attest(protoPk, 0, 2); // 重新驗證通過
        assertEq(reg.levelOf(user), 2);
        (,,,,,,, uint64 n,,,) = reg.statusOf(user);
        assertEq(n, 3);
    }

    function test_statusSigCannotBeReplayedOrRetargeted() public {
        _attest(prodPk, 0, 2);
        bytes memory sig = _statusSig(prodPk, user, IdentityRegistry.Status.SUSPENDED, 5, 2);
        // 暫停簽章不能拿去撤銷
        vm.expectRevert(IdentityRegistry.InvalidSigner.selector);
        reg.revoke(user, 5, 2, sig);
        reg.suspend(user, 5, 2, sig);
        _attest(prodPk, 0, 2);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.BadNonce.selector, uint64(4)));
        reg.suspend(user, 5, 2, sig);
    }

    function test_retiringSignerDropsLevel() public {
        _attest(protoPk, 0, 2);
        vm.prank(gov);
        reg.setSigner(vm.addr(protoPk), IdentityRegistry.SignerClass.NONE);
        assertEq(reg.levelOf(user), 0);
        (uint8 lvl,,,) = reg.attestations(user);
        assertEq(lvl, 0);
    }

    function test_expiryDropsLevel() public {
        _attest(prodPk, 0, 2);
        vm.warp(block.timestamp + 366 days);
        assertEq(reg.levelOf(user), 0);
    }

    function test_unknownSignerRejected() public {
        uint48 exp = uint48(block.timestamp + 1 days);
        bytes memory sig = _attestSig(evilPk, user, 0, 2, exp, 1);
        vm.expectRevert(IdentityRegistry.InvalidSigner.selector);
        reg.attest(user, 0, 2, exp, ROOT, TW, 1, sig);
    }

    function test_revokeSelf() public {
        _attest(prodPk, 0, 2);
        vm.prank(user);
        reg.revokeSelf(1);
        assertEq(reg.levelOf(user), 0);
        assertEq(reg.nonceOf(user), 2);
    }

    function test_governanceTransfer() public {
        address next = makeAddr("multisig");
        vm.prank(gov);
        reg.transferGovernance(next);
        vm.prank(next);
        reg.acceptGovernance();
        assertEq(reg.governance(), next);
        vm.prank(gov);
        vm.expectRevert(IdentityRegistry.OnlyGovernance.selector);
        reg.setSigner(gov, IdentityRegistry.SignerClass.PRODUCTION);
    }
}
