// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KeyringValidator} from "../src/modules/KeyringValidator.sol";
import {IdentityAccountFactory} from "../src/factory/IdentityAccountFactory.sol";
import {IERC7579ModuleConfig, MODULE_TYPE_EXECUTOR} from "../src/interfaces/IERC7579.sol";
import {OpKind, TxSummary, TxSummaryLib} from "../src/lib/TxSummary.sol";

contract KeyringTest is Base {
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        account = _deployAccount();
    }

    function _transferOp(uint256 amount) internal view returns (PackedUserOperation memory) {
        return _op(account, address(keyring), _exec(address(twdc), 0, abi.encodeCall(IERC20.transfer, (bob, amount))));
    }

    // ── §4.4 開戶：initCode 部署＋第一把 passkey 同一筆完成 ──

    function test_CreateAccountViaInitCode() public {
        bytes32 idc2 = bytes32(uint256(keccak256("apple|sub-999|salt")) >> 8);
        address predicted = factory.getAddress(idc2);
        vm.deal(predicted, 1 ether);

        IdentityAccountFactory.BindParams memory b = _bindFor(idc2, NEW_PHONE, EPHEMERAL);

        PackedUserOperation memory op =
            _op(predicted, address(keyring), _exec(address(dd), 0, abi.encodeCall(dd.registerDevice, (bytes32("iphone"), hex"01"))));
        op.initCode = abi.encodePacked(address(factory), abi.encodeCall(factory.createAccount, (idc2, b)));
        _signDaily(op, NEW_PHONE);
        _handle(op);

        assertGt(predicted.code.length, 0);
        assertEq(uint8(keyring.getKey(predicted, _keyId(NEW_PHONE)).keyClass), uint8(KeyringValidator.KeyClass.DAILY));
        assertTrue(recovery.isIdentityOf(idc2, predicted));
    }

    function test_InterceptedLoginCannotBindOtherKey() public {
        bytes32 idc2 = bytes32(uint256(keccak256("google|sub-777|salt")) >> 8);
        IdentityAccountFactory.BindParams memory b = _bindFor(idc2, PHONE, EPHEMERAL);
        // 攻擊者攔截 JWT／證明，換上自己的公鑰，但沒有 ephemeral 私鑰
        (b.qx, b.qy) = _pub(ATTACKER);
        vm.expectRevert(IdentityAccountFactory.InvalidEphemeralSignature.selector);
        factory.createAccount(idc2, b);
    }

    function test_InterceptedLoginWithOwnEphemeralRejected() public {
        bytes32 idc2 = bytes32(uint256(keccak256("google|sub-777|salt")) >> 8);
        IdentityAccountFactory.BindParams memory good = _bindFor(idc2, PHONE, EPHEMERAL);
        // 攻擊者用自己的 ephemeral 重簽，但 JWT nonce 綁的是受害者的 ephemeral
        IdentityAccountFactory.BindParams memory b = _bindFor(idc2, ATTACKER, 0xBAD2);
        b.proof = good.proof;
        b.expiry = good.expiry;
        vm.expectRevert(IdentityAccountFactory.InvalidProof.selector);
        factory.createAccount(idc2, b);
    }

    // ── §4.3 標準模式（尚未綁卡）──

    function test_Standard_DailySmallTransfer() public {
        PackedUserOperation memory op = _transferOp(1_000e6);
        _signDaily(op, PHONE);
        _handle(op);
        assertEq(twdc.balanceOf(bob), 1_000e6);
    }

    function test_Standard_OverPerTxRejected() public {
        PackedUserOperation memory op = _transferOp(PER_TX + 1);
        _signDaily(op, PHONE);
        _handleExpectFail(op);
    }

    function test_Standard_DailyWindow() public {
        for (uint256 i = 0; i < 3; i++) {
            PackedUserOperation memory op = _transferOp(PER_TX);
            _signDaily(op, PHONE);
            _handle(op);
        }
        PackedUserOperation memory op4 = _transferOp(1e6);
        _signDaily(op4, PHONE);
        _handleExpectFail(op4); // 當日累計超過 30,000

        vm.warp(block.timestamp + 1 days);
        PackedUserOperation memory op5 = _transferOp(1e6);
        _signDaily(op5, PHONE);
        _handle(op5);
    }

    function test_Standard_AddDailyKeyNeedsSchedule() public {
        (bytes32 qx, bytes32 qy) = _pub(NEW_PHONE);
        // 立即新增被拒
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(keyring), 0, abi.encodeCall(keyring.addDailyKey, (qx, qy, RP))));
        _signDaily(op, PHONE);
        _handleExpectFail(op);

        // 排程 → 24h 後執行
        bytes memory payload = abi.encode(qx, qy, RP);
        uint8 action = uint8(KeyringValidator.Action.ADD_DAILY);
        op = _op(account, address(keyring), _exec(address(keyring), 0, abi.encodeCall(keyring.schedule, (action, payload))));
        _signDaily(op, PHONE);
        _handle(op);

        bytes memory execData = abi.encodeCall(keyring.executeScheduled, (action, payload));
        op = _op(account, address(keyring), _exec(address(keyring), 0, execData));
        _signDaily(op, PHONE);
        _handle(op); // 執行期 NotReady：UserOp 執行失敗，金鑰不會被加入
        assertEq(uint8(keyring.getKey(account, _keyId(NEW_PHONE)).keyClass), uint8(KeyringValidator.KeyClass.NONE));

        vm.warp(block.timestamp + 24 hours);
        op = _op(account, address(keyring), _exec(address(keyring), 0, execData));
        _signDaily(op, PHONE);
        _handle(op);
        assertEq(uint8(keyring.getKey(account, _keyId(NEW_PHONE)).keyClass), uint8(KeyringValidator.KeyClass.DAILY));
    }

    // ── §4.5 綁卡 → 主金鑰模式 ──

    function test_BindCard_EntersMasterMode() public {
        _bindCard(account);
        assertTrue(keyring.isMasterMode(account));
        assertEq(uint8(keyring.getKey(account, _keyId(CARD)).keyClass), uint8(KeyringValidator.KeyClass.MASTER));
    }

    function test_BindCard_RejectsFakeIssuer() public {
        (bytes32 qx, bytes32 qy) = _pub(CARD);
        bytes32 serial = keccak256("fake");
        bytes memory sig = _ethSign(0xFA4E, keyring.cardAttestationDigest(account, qx, qy, RP, serial));
        bytes memory data = abi.encodeCall(KeyringValidator.addMasterKey, (qx, qy, RP, serial, sig));
        PackedUserOperation memory op = _op(account, address(keyring), _exec(address(keyring), 0, data));
        _signDaily(op, PHONE);
        _handle(op); // 執行期 revert（InvalidCardAttestation），帳戶狀態不變
        assertFalse(keyring.isMasterMode(account));
    }

    // ── §4.3＋§9.2 主金鑰模式：大額需卡片＋螢幕確認 ──

    function test_Master_LargeTransferNeedsCard() public {
        _bindCard(account);

        PackedUserOperation memory op = _transferOp(50_000e6);
        _signDaily(op, PHONE);
        _handleExpectFail(op); // 手機不能做大額

        op = _transferOp(50_000e6);
        _signWith(op, CARD, _dailyAuthData()); // 卡片但沒有 ctxd（盲簽）
        _handleExpectFail(op);

        op = _transferOp(50_000e6);
        _signCard(op);
        _handle(op);
        assertEq(twdc.balanceOf(bob), 50_000e6);
    }

    function test_Master_TamperedDisplayRejected() public {
        _bindCard(account);
        PackedUserOperation memory op = _transferOp(50_000e6);
        // 被動過的 App 讓卡片顯示「轉 500 給 bob」，實際 calldata 是 50,000
        TxSummary memory shown =
            TxSummary(uint8(OpKind.TRANSFER), block.chainid, address(twdc), 500e6, bob, bytes32(0));
        _signWith(op, CARD, _cardAuthData(TxSummaryLib.single(shown)));
        _handleExpectFail(op);
    }

    function test_Master_CtxdMatchesIndependentSummary() public {
        _bindCard(account);
        PackedUserOperation memory op = _transferOp(50_000e6);
        TxSummary memory expected =
            TxSummary(uint8(OpKind.TRANSFER), block.chainid, address(twdc), 50_000e6, bob, bytes32(0));
        _signWith(op, CARD, _cardAuthData(TxSummaryLib.single(expected)));
        _handle(op);
        assertEq(twdc.balanceOf(bob), 50_000e6);
    }

    function test_Master_SyncedKeyCannotActAsMaster() public {
        _bindCard(account);
        PackedUserOperation memory op = _transferOp(50_000e6);
        (,,, bytes32 ctxd) = keyring.previewAssessment(account, op.callData);
        // BE 旗標 = 1（可同步）的簽章不被當作卡片
        bytes memory ad = abi.encodePacked(RP, bytes1(0x8D), uint32(1), bytes8(0xA164637478645820), ctxd);
        _signWith(op, CARD, ad);
        _handleExpectFail(op);
    }

    function test_Master_DailyCanStillDoSmallTransfer() public {
        _bindCard(account);
        PackedUserOperation memory op = _transferOp(100e6);
        _signDaily(op, PHONE);
        _handle(op);
        assertEq(twdc.balanceOf(bob), 100e6);
    }

    function test_Master_CardAddsKeyImmediately_PhoneCannot() public {
        _bindCard(account);
        (bytes32 qx, bytes32 qy) = _pub(NEW_PHONE);
        bytes memory cd = _exec(address(keyring), 0, abi.encodeCall(keyring.addDailyKey, (qx, qy, RP)));

        PackedUserOperation memory op = _op(account, address(keyring), cd);
        _signDaily(op, PHONE);
        _handleExpectFail(op);

        op = _op(account, address(keyring), cd);
        _signCard(op);
        _handle(op);
        assertEq(uint8(keyring.getKey(account, _keyId(NEW_PHONE)).keyClass), uint8(KeyringValidator.KeyClass.DAILY));
    }

    function test_Master_CardRemovesStolenPhone() public {
        _bindCard(account);
        bytes memory cd = _exec(address(keyring), 0, abi.encodeCall(keyring.removeKey, (_keyId(PHONE))));
        PackedUserOperation memory op = _op(account, address(keyring), cd);
        _signCard(op);
        _handle(op);
        assertEq(uint8(keyring.getKey(account, _keyId(PHONE)).keyClass), uint8(KeyringValidator.KeyClass.NONE));
    }

    function test_Master_PhoneRemovingCardNeeds72h() public {
        _bindCard(account);
        bytes memory payload = abi.encode(_keyId(CARD));
        uint8 action = uint8(KeyringValidator.Action.REMOVE_KEY);
        PackedUserOperation memory op =
            _op(account, address(keyring), _exec(address(keyring), 0, abi.encodeCall(keyring.schedule, (action, payload))));
        _signDaily(op, PHONE);
        _handle(op);
        bytes32 h = keccak256(abi.encode(action, payload));
        assertEq(keyring.scheduledAt(h, account), uint48(block.timestamp + 72 hours));

        // 卡片在期間取消
        op = _op(account, address(keyring), _exec(address(keyring), 0, abi.encodeCall(keyring.cancel, (h))));
        _signDaily(op, CARD); // 取消屬收緊，任何金鑰皆可，不需 ctxd
        _handle(op);
        assertEq(keyring.scheduledAt(h, account), 0);
    }

    function test_Master_LimitLowerByPhone_RaiseNeedsCard() public {
        _bindCard(account);
        bytes memory lower =
            _exec(address(keyring), 0, abi.encodeCall(keyring.setLimits, (address(twdc), uint128(1_000e6), uint128(5_000e6))));
        PackedUserOperation memory op = _op(account, address(keyring), lower);
        _signDaily(op, PHONE);
        _handle(op);

        bytes memory raise =
            _exec(address(keyring), 0, abi.encodeCall(keyring.setLimits, (address(twdc), uint128(50_000e6), uint128(100_000e6))));
        op = _op(account, address(keyring), raise);
        _signDaily(op, PHONE);
        _handleExpectFail(op);

        op = _op(account, address(keyring), raise);
        _signCard(op);
        _handle(op);
        (uint128 perTx,) = keyring.limits(address(twdc), account);
        assertEq(perTx, 50_000e6);
    }

    function test_Master_UnlimitedApproveNeedsCard() public {
        _bindCard(account);
        bytes memory cd = _exec(address(twdc), 0, abi.encodeCall(IERC20.approve, (bob, type(uint256).max)));
        PackedUserOperation memory op = _op(account, address(keyring), cd);
        _signDaily(op, PHONE);
        _handleExpectFail(op);
    }

    function test_ModuleInstallNeedsScheduleAndCard() public {
        _bindCard(account);
        address evil = makeAddr("evilExecutor");
        bytes memory installCd = abi.encodeCall(IERC7579ModuleConfig.installModule, (MODULE_TYPE_EXECUTOR, evil, ""));

        // 未排程：即使卡片簽也被拒
        PackedUserOperation memory op = _op(account, address(keyring), installCd);
        _signWith(op, CARD, _cardAuthData(bytes32(0)));
        _handleExpectFail(op);

        // 卡片排程（螢幕確認）→ 72h 前仍被拒 → 72h 後卡片簽署安裝
        uint8 action = uint8(KeyringValidator.Action.MODULE);
        op = _op(account, address(keyring), _exec(address(keyring), 0, abi.encodeCall(keyring.schedule, (action, installCd))));
        _signDaily(op, PHONE);
        _handleExpectFail(op); // 主金鑰模式下排程模組變更需卡片
        op = _op(account, address(keyring), _exec(address(keyring), 0, abi.encodeCall(keyring.schedule, (action, installCd))));
        _signCard(op);
        _handle(op);

        vm.warp(block.timestamp + 71 hours);
        op = _op(account, address(keyring), installCd);
        _signWith(op, CARD, _cardAuthData(bytes32(0)));
        _handleExpectFail(op);

        vm.warp(block.timestamp + 1 hours);
        vm.etch(evil, hex"00"); // 讓 onInstall 呼叫成功（STOP）
        op = _op(account, address(keyring), installCd);
        _signCard(op);
        _handle(op);
        assertTrue(IERC7579ModuleConfig(account).isModuleInstalled(MODULE_TYPE_EXECUTOR, evil, ""));
    }

    function test_RandomKeyRejected() public {
        PackedUserOperation memory op = _transferOp(1e6);
        _signDaily(op, ATTACKER);
        _handleExpectFail(op);
    }
}
