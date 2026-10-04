// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {CafecaMultisig} from "../src/governance/CafecaMultisig.sol";
import {IdentityRegistry} from "../src/registry/IdentityRegistry.sol";
import {AuditAnchor} from "../src/audit/AuditAnchor.sol";

contract MultisigTest is Test {
    CafecaMultisig ms;
    uint256[3] pk = [uint256(0xA1), uint256(0xB2), uint256(0xC3)];
    address[3] who;

    function setUp() public {
        address[] memory o = new address[](3);
        for (uint256 i; i < 3; i++) {
            who[i] = vm.addr(pk[i]);
            o[i] = who[i];
        }
        ms = new CafecaMultisig(o, 2);
    }

    function _sigs(address to, uint256 value, bytes memory data, uint256[] memory keys) internal view returns (bytes[] memory out) {
        bytes32 d = MessageHashUtils.toEthSignedMessageHash(ms.txHash(to, value, data, ms.nonce()));
        // 依位址排序
        for (uint256 i; i < keys.length; i++)
            for (uint256 j = i + 1; j < keys.length; j++)
                if (vm.addr(keys[j]) < vm.addr(keys[i])) (keys[i], keys[j]) = (keys[j], keys[i]);
        out = new bytes[](keys.length);
        for (uint256 i; i < keys.length; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], d);
            out[i] = abi.encodePacked(r, s, v);
        }
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory k) {
        k = new uint256[](2);
        k[0] = a;
        k[1] = b;
    }

    function test_takeOverIdentityRegistryGovernance() public {
        IdentityRegistry reg = new IdentityRegistry(address(this));
        reg.transferGovernance(address(ms));
        bytes memory accept = abi.encodeCall(IdentityRegistry.acceptGovernance, ());
        ms.execute(address(reg), 0, accept, _sigs(address(reg), 0, accept, _two(pk[0], pk[2])));
        assertEq(reg.governance(), address(ms));
        // 部署者不能再換簽章者
        vm.expectRevert(IdentityRegistry.OnlyGovernance.selector);
        reg.setSigner(address(0x1234), IdentityRegistry.SignerClass.PRODUCTION);
        // 多簽可以
        bytes memory set = abi.encodeCall(IdentityRegistry.setSigner, (address(0x1234), IdentityRegistry.SignerClass.PRODUCTION));
        ms.execute(address(reg), 0, set, _sigs(address(reg), 0, set, _two(pk[1], pk[2])));
        assertEq(uint8(reg.signerClass(address(0x1234))), 2);
    }

    function test_oneSignatureNotEnough() public {
        uint256[] memory k = new uint256[](1);
        k[0] = pk[0];
        bytes memory d = abi.encodeCall(CafecaMultisig.changeThreshold, (1));
        bytes[] memory s = _sigs(address(ms), 0, d, k);
        vm.expectRevert(CafecaMultisig.NotEnoughSignatures.selector);
        ms.execute(address(ms), 0, d, s);
    }

    function test_duplicateSignerRejected() public {
        bytes memory d = abi.encodeCall(CafecaMultisig.changeThreshold, (1));
        bytes[] memory s = _sigs(address(ms), 0, d, _two(pk[0], pk[0]));
        vm.expectRevert(CafecaMultisig.SignersNotSorted.selector);
        ms.execute(address(ms), 0, d, s);
    }

    function test_nonOwnerRejected() public {
        bytes memory d = abi.encodeCall(CafecaMultisig.changeThreshold, (1));
        bytes[] memory s = _sigs(address(ms), 0, d, _two(pk[0], 0xDEAD));
        vm.expectRevert();
        ms.execute(address(ms), 0, d, s);
    }

    function test_replayRejected() public {
        AuditAnchor a = new AuditAnchor(address(ms));
        bytes memory d = abi.encodeCall(AuditAnchor.setAnchorer, (address(0xBEEF), true));
        bytes[] memory s = _sigs(address(a), 0, d, _two(pk[0], pk[1]));
        ms.execute(address(a), 0, d, s);
        assertTrue(a.isAnchorer(address(0xBEEF)));
        vm.expectRevert();
        ms.execute(address(a), 0, d, s);
    }

    function test_ownerManagementOnlySelf() public {
        vm.expectRevert(CafecaMultisig.OnlySelf.selector);
        ms.addOwner(address(0x99), 2);
        bytes memory d = abi.encodeCall(CafecaMultisig.removeOwner, (who[2], 2));
        ms.execute(address(ms), 0, d, _sigs(address(ms), 0, d, _two(pk[0], pk[1])));
        assertFalse(ms.isOwner(who[2]));
        assertEq(ms.owners().length, 2);
        bytes memory bad = abi.encodeCall(CafecaMultisig.changeThreshold, (3));
        bytes[] memory s = _sigs(address(ms), 0, bad, _two(pk[0], pk[1]));
        vm.expectRevert();
        ms.execute(address(ms), 0, bad, s);
    }

    function test_constructorValidation() public {
        address[] memory o = new address[](2);
        o[0] = address(1);
        o[1] = address(1);
        vm.expectRevert(CafecaMultisig.BadOwner.selector);
        new CafecaMultisig(o, 1);
        o[1] = address(2);
        vm.expectRevert(CafecaMultisig.BadThreshold.selector);
        new CafecaMultisig(o, 3);
    }
}
