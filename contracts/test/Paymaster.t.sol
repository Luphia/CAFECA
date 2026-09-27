// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {CafecaPaymaster} from "../src/paymaster/CafecaPaymaster.sol";

contract PaymasterTest is Base {
    CafecaPaymaster internal pm;
    uint256 internal constant POLICY_PK = 0x9A7;
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        pm = new CafecaPaymaster(ep, vm.addr(POLICY_PK), address(att), address(cm));
        pm.setTier(0, 1 ether, 3); // L0：每日 3 筆（測試用）
        vm.deal(address(this), 100 ether);
        pm.deposit{value: 10 ether}();
        pm.addStake{value: 1 ether}(1 days);

        account = factory.getAddress(IDC);
        factory.createAccount(IDC, _bindParams(account, PHONE));
        twdc.mint(account, 1_000e6);
        // 注意：帳戶沒有任何 ETH／BOLT
    }

    function _sponsoredTransfer() internal view returns (PackedUserOperation memory op) {
        op = _op(account, address(keyring), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (bob, 1e6))));
        uint48 day = uint48(block.timestamp / 1 days);
        uint48 validAfter = day * 1 days;
        uint48 validUntil = validAfter + 1 days;
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(300_000), uint128(100_000), validUntil, validAfter, day);
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getHash(op, validUntil, validAfter, day));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, _ethSign(POLICY_PK, h));
        _signDaily(op, PHONE);
    }

    function test_SponsoredWithoutAnyGasToken() public {
        assertEq(account.balance, 0);
        _handle(_sponsoredTransfer());
        assertEq(twdc.balanceOf(bob), 1e6);
        (, uint32 ops,) = pm.usage(account);
        assertEq(ops, 1);
    }

    function test_DailyOpsCap() public {
        for (uint256 i = 0; i < 3; i++) {
            _handle(_sponsoredTransfer());
        }
        _handleExpectFail(_sponsoredTransfer());

        vm.warp(block.timestamp + 1 days);
        _handle(_sponsoredTransfer()); // 隔日重置
    }

    function test_ForgedPolicySignatureRejected() public {
        PackedUserOperation memory op = _sponsoredTransfer();
        // 竄改 callData 後簽章失效
        op.callData = _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (bob, 2e6)));
        _signDaily(op, PHONE);
        _handleExpectFail(op);
    }
}
