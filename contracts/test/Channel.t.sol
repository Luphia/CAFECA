// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ChannelValidator} from "../src/modules/ChannelValidator.sol";
import {ChannelType, ChannelPolicy} from "../src/channels/ChannelTypes.sol";

contract ChannelTest is Base {
    uint256 internal constant AGENT_PK = 0xA6E47; // AI 代理金鑰（放在 TEE）
    uint256 internal constant ISSUER_OP_PK = 0x155E; // 發卡處理商金鑰（HSM）
    address internal merchant = makeAddr("api-merchant");
    address internal stranger = makeAddr("stranger");
    address internal settlement = makeAddr("visa-settlement");

    function setUp() public override {
        super.setUp();
        account = _deployAccount();
    }

    function _policy(address settle) internal view returns (ChannelPolicy memory) {
        return ChannelPolicy({
            token: address(twdc),
            perTxLimit: 500e6,
            dailyLimit: 1_000e6,
            confirmThreshold: 300e6,
            validUntil: uint48(block.timestamp + 30 days),
            settlement: settle
        });
    }

    /// @dev 主帳戶建立通道並撥款（同一筆 batch 不行：通道地址需先建立，這裡分兩筆）
    function _createChannel(ChannelType t, uint256 operatorPk, address settle, bytes32 salt, uint256 fund)
        internal
        returns (address channel)
    {
        bytes memory cd = _exec(
            address(cm),
            0,
            abi.encodeCall(cm.createChannel, (uint8(t), vm.addr(operatorPk), _policy(settle), salt))
        );
        PackedUserOperation memory op = _op(account, address(keyring), cd);
        _signDaily(op, PHONE); // 標準模式：DAILY 可建立通道
        _handle(op);
        channel = cm.channelAddress(account, salt);
        assertEq(cm.parentOf(channel), account);

        op = _op(account, address(keyring), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (channel, fund))));
        _signDaily(op, PHONE);
        _handle(op);
        vm.deal(channel, 1 ether); // 本測試不經 paymaster，通道自付 prefund
    }

    function _agentPay(address channel, address to, uint256 amt) internal view returns (PackedUserOperation memory op) {
        op = _op(channel, address(cv), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (to, amt))));
        _signOperator(op, AGENT_PK);
    }

    // ── AI 代理通道 ──

    function test_Agent_PaysWithinPolicy() public {
        address ch = _createChannel(ChannelType.AGENT, AGENT_PK, address(0), "ai-1", 2_000e6);
        _handle(_agentPay(ch, merchant, 200e6));
        assertEq(twdc.balanceOf(merchant), 200e6);
    }

    function test_Agent_AboveThresholdRejected() public {
        address ch = _createChannel(ChannelType.AGENT, AGENT_PK, address(0), "ai-1", 2_000e6);
        _handleExpectFail(_agentPay(ch, merchant, 301e6));
    }

    function test_Agent_DailyLimit() public {
        address ch = _createChannel(ChannelType.AGENT, AGENT_PK, address(0), "ai-1", 2_000e6);
        for (uint256 i = 0; i < 3; i++) {
            _handle(_agentPay(ch, merchant, 300e6));
        }
        _handleExpectFail(_agentPay(ch, merchant, 101e6)); // 900 + 101 > 1000
    }

    function test_Agent_WrongSignerRejected() public {
        address ch = _createChannel(ChannelType.AGENT, AGENT_PK, address(0), "ai-1", 2_000e6);
        PackedUserOperation memory op =
            _op(ch, address(cv), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (merchant, 10e6))));
        _signOperator(op, 0xBAD);
        _handleExpectFail(op);
    }

    function test_Agent_TargetAllowlist() public {
        address ch = _createChannel(ChannelType.AGENT, AGENT_PK, address(0), "ai-1", 2_000e6);
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(cv), 0, abi.encodeCall(cv.allowTarget, (ch, merchant))));
        _signDaily(op, PHONE);
        _handle(op);
        _handleExpectFail(_agentPay(ch, stranger, 10e6)); // 被 prompt injection 導向陌生地址
        _handle(_agentPay(ch, merchant, 10e6));
    }

    function test_Agent_IntentApprovedByCard() public {
        _bindCard(account);
        address ch;
        {
            bytes memory cd = _exec(
                address(cm), 0, abi.encodeCall(cm.createChannel, (uint8(ChannelType.AGENT), vm.addr(AGENT_PK), _policy(address(0)), bytes32("ai-2")))
            );
            PackedUserOperation memory c = _op(account, address(keyring), cd);
            _signDaily(c, PHONE);
            _handleExpectFail(c); // 主金鑰模式下建立通道需卡片
            c = _op(account, address(keyring), cd);
            _signCard(c);
            _handle(c);
            ch = cm.channelAddress(account, "ai-2");
            twdc.mint(ch, 5_000e6);
            vm.deal(ch, 1 ether);
        }

        // AI 發出 2,000 的超額請求
        PackedUserOperation memory op = _op(
            ch, address(cv), _exec(address(cv), 0, abi.encodeCall(cv.requestIntent, (merchant, 2_000e6, keccak256("GPU rental"))))
        );
        _signOperator(op, AGENT_PK);
        _handle(op);
        assertEq(cv.intentCountOf(ch), 1);

        // 主人用手機核准 → 拒絕；用卡片（螢幕顯示 2,000 → merchant）→ 執行
        bytes memory approve =
            _exec(address(cv), 0, abi.encodeCall(cv.approveIntent, (ch, 1, address(twdc), merchant, 2_000e6)));
        op = _op(account, address(keyring), approve);
        _signDaily(op, PHONE);
        _handleExpectFail(op);
        op = _op(account, address(keyring), approve);
        _signCard(op);
        _handle(op);
        assertEq(twdc.balanceOf(merchant), 2_000e6);
    }

    function test_Agent_RevokeSweepsFunds() public {
        address ch = _createChannel(ChannelType.AGENT, AGENT_PK, address(0), "ai-1", 2_000e6);
        uint256 before = twdc.balanceOf(account);
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(cv), 0, abi.encodeCall(cv.revoke, (ch))));
        _signDaily(op, PHONE);
        _handle(op);
        assertEq(twdc.balanceOf(account), before + 2_000e6);
        _handleExpectFail(_agentPay(ch, merchant, 10e6));
    }

    function test_Agent_RestrictPolicyCannotLoosen() public {
        address ch = _createChannel(ChannelType.AGENT, AGENT_PK, address(0), "ai-1", 2_000e6);
        ChannelPolicy memory p = _policy(address(0));
        p.dailyLimit = 5_000e6; // 偷偷放寬
        vm.prank(account);
        vm.expectRevert(ChannelValidator.NotStricter.selector);
        cv.restrictPolicy(ch, p);
    }

    // ── Visa 卡通道（階段二：authorize → capture） ──

    function _cardOp(address ch, bytes memory data) internal view returns (PackedUserOperation memory op) {
        op = _op(ch, address(cv), _exec(address(cv), 0, data));
        _signOperator(op, ISSUER_OP_PK);
    }

    function test_Card_AuthorizeCapture() public {
        address ch = _createChannel(ChannelType.CARD, ISSUER_OP_PK, settlement, "visa", 1_000e6);

        _handle(_cardOp(ch, abi.encodeCall(cv.authorize, (bytes32("auth-1"), 400e6, uint48(block.timestamp + 7 days)))));
        assertEq(cv.lockedOf(ch), 400e6);
        assertEq(cv.available(ch), 600e6);

        // 加油站：清算金額 ≤ 120%
        _handle(_cardOp(ch, abi.encodeCall(cv.capture, (bytes32("auth-1"), 450e6))));
        assertEq(twdc.balanceOf(settlement), 450e6);
        assertEq(cv.lockedOf(ch), 0);
    }

    function test_Card_LockedFundsCannotBeRevokedAway() public {
        address ch = _createChannel(ChannelType.CARD, ISSUER_OP_PK, settlement, "visa", 1_000e6);
        _handle(_cardOp(ch, abi.encodeCall(cv.authorize, (bytes32("auth-1"), 400e6, uint48(block.timestamp + 7 days)))));

        uint256 before = twdc.balanceOf(account);
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(cv), 0, abi.encodeCall(cv.revoke, (ch))));
        _signDaily(op, PHONE);
        _handle(op);
        assertEq(twdc.balanceOf(account), before + 600e6); // 只回收未鎖定部分
        assertEq(twdc.balanceOf(ch), 400e6);
    }

    function test_Card_DirectTransferRejected() public {
        address ch = _createChannel(ChannelType.CARD, ISSUER_OP_PK, settlement, "visa", 1_000e6);
        PackedUserOperation memory op =
            _op(ch, address(cv), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (settlement, 100e6))));
        _signOperator(op, ISSUER_OP_PK);
        _handleExpectFail(op); // 發卡方只能透過 capture 扣款
    }

    function test_Card_ReleaseAfterExpiryByAnyone() public {
        address ch = _createChannel(ChannelType.CARD, ISSUER_OP_PK, settlement, "visa", 1_000e6);
        _handle(_cardOp(ch, abi.encodeCall(cv.authorize, (bytes32("auth-1"), 400e6, uint48(block.timestamp + 7 days)))));
        vm.prank(stranger);
        vm.expectRevert(ChannelValidator.OnlyChannel.selector);
        cv.release(ch, "auth-1");

        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(stranger);
        cv.release(ch, "auth-1");
        assertEq(cv.lockedOf(ch), 0);
    }
}
