// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuditAnchor} from "../src/audit/AuditAnchor.sol";

contract AuditAnchorTest is Test {
    AuditAnchor a;
    address owner = address(0xA11CE);
    address bot = address(0xB0B);

    function setUp() public {
        a = new AuditAnchor(owner);
    }

    function test_anchorByOwner() public {
        vm.prank(owner);
        a.anchor(bytes32(uint256(1)), 10);
        assertEq(a.lastCount(), 10);
        assertEq(a.lastHead(), bytes32(uint256(1)));
    }

    function test_countMustIncrease() public {
        vm.startPrank(owner);
        a.anchor(bytes32(uint256(1)), 10);
        vm.expectRevert(abi.encodeWithSelector(AuditAnchor.CountNotIncreasing.selector, uint64(10)));
        a.anchor(bytes32(uint256(2)), 10);
        a.anchor(bytes32(uint256(3)), 11);
        vm.stopPrank();
    }

    function test_onlyAnchorer() public {
        vm.prank(bot);
        vm.expectRevert(AuditAnchor.OnlyAnchorer.selector);
        a.anchor(bytes32(uint256(1)), 1);
        vm.prank(owner);
        a.setAnchorer(bot, true);
        vm.prank(bot);
        a.anchor(bytes32(uint256(1)), 1);
        vm.prank(owner);
        a.setAnchorer(bot, false);
        vm.prank(bot);
        vm.expectRevert(AuditAnchor.OnlyAnchorer.selector);
        a.anchor(bytes32(uint256(2)), 2);
    }

    function test_onlyOwnerAdmin() public {
        vm.prank(bot);
        vm.expectRevert(AuditAnchor.OnlyOwner.selector);
        a.setAnchorer(bot, true);
        vm.prank(bot);
        vm.expectRevert(AuditAnchor.OnlyOwner.selector);
        a.transferOwner(bot);
        vm.prank(owner);
        a.transferOwner(bot);
        assertEq(a.owner(), bot);
    }
}
