// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccount} from "account-abstraction/interfaces/IAccount.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {
    IValidator,
    IModule,
    IERC7579Execution,
    IERC7579ModuleConfig,
    Execution,
    MODULE_TYPE_VALIDATOR,
    MODULE_TYPE_EXECUTOR,
    CALLTYPE_SINGLE,
    CALLTYPE_BATCH,
    VALIDATION_FAILED,
    ERC1271_INVALID
} from "../interfaces/IERC7579.sol";
import {ExecLib} from "../lib/ExecLib.sol";

/// @title CafecaAccount
/// @notice 最小化 ERC-4337 + ERC-7579 參考帳戶，供主身分帳戶與支出通道子帳戶共用。
/// @dev 正式上線請替換為經稽核的 Nexus 或 Kernel；各模組依 ERC-7579 介面撰寫，可直接移植。
///      validator 由 UserOp nonce 的高 160 bits 指定（nonce key 前 20 bytes）。
contract CafecaAccount is IAccount, IERC7579Execution, IERC7579ModuleConfig {
    address public immutable entryPoint;

    bool private _initialized;
    mapping(address => bool) private _validators;
    mapping(address => bool) private _executors;

    event ModuleInstalled(uint256 moduleTypeId, address module);
    event ModuleUninstalled(uint256 moduleTypeId, address module);

    error NotAuthorized();
    error AlreadyInitialized();
    error UnsupportedModuleType(uint256 moduleTypeId);
    error UnsupportedCallType(bytes1 callType);

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
        _initialized = true; // 鎖住實作合約本身
    }

    modifier onlyEntryPoint() {
        if (msg.sender != entryPoint) revert NotAuthorized();
        _;
    }

    modifier onlyEntryPointOrSelf() {
        if (msg.sender != entryPoint && msg.sender != address(this)) revert NotAuthorized();
        _;
    }

    /// @notice 由工廠在 clone 後於同一筆交易內呼叫
    function initialize(
        address[] calldata validators,
        bytes[] calldata validatorData,
        address[] calldata executors,
        bytes[] calldata executorData
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        for (uint256 i = 0; i < validators.length; i++) {
            _install(MODULE_TYPE_VALIDATOR, validators[i], validatorData[i]);
        }
        for (uint256 i = 0; i < executors.length; i++) {
            _install(MODULE_TYPE_EXECUTOR, executors[i], executorData[i]);
        }
    }

    // ───────────────────────── ERC-4337 ─────────────────────────

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        address validator = address(uint160(userOp.nonce >> 96));
        if (!_validators[validator]) {
            validationData = VALIDATION_FAILED;
        } else {
            validationData = IValidator(validator).validateUserOp(userOp, userOpHash);
        }
        if (missingAccountFunds > 0) {
            (bool ok,) = payable(msg.sender).call{value: missingAccountFunds}("");
            (ok);
        }
    }

    // ───────────────────────── ERC-7579 執行 ─────────────────────────

    function execute(bytes32 mode, bytes calldata executionCalldata) external payable onlyEntryPointOrSelf {
        _execute(mode, executionCalldata);
    }

    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory)
    {
        if (!_executors[msg.sender]) revert NotAuthorized();
        return _execute(mode, executionCalldata);
    }

    function _execute(bytes32 mode, bytes calldata ec) internal returns (bytes[] memory results) {
        bytes1 callType = mode[0];
        if (callType == CALLTYPE_SINGLE) {
            (address target, uint256 value, bytes calldata data) = ExecLib.decodeSingle(ec);
            results = new bytes[](1);
            results[0] = _call(target, value, data);
        } else if (callType == CALLTYPE_BATCH) {
            Execution[] memory execs = abi.decode(ec, (Execution[]));
            results = new bytes[](execs.length);
            for (uint256 i = 0; i < execs.length; i++) {
                results[i] = _call(execs[i].target, execs[i].value, execs[i].callData);
            }
        } else {
            revert UnsupportedCallType(callType);
        }
    }

    function _call(address target, uint256 value, bytes memory data) internal returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    // ───────────────────────── 模組管理 ─────────────────────────

    function installModule(uint256 moduleTypeId, address module, bytes calldata initData)
        external
        payable
        onlyEntryPointOrSelf
    {
        _install(moduleTypeId, module, initData);
    }

    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData)
        external
        payable
        onlyEntryPointOrSelf
    {
        if (moduleTypeId == MODULE_TYPE_VALIDATOR) {
            _validators[module] = false;
        } else if (moduleTypeId == MODULE_TYPE_EXECUTOR) {
            _executors[module] = false;
        } else {
            revert UnsupportedModuleType(moduleTypeId);
        }
        IModule(module).onUninstall(deInitData);
        emit ModuleUninstalled(moduleTypeId, module);
    }

    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata)
        external
        view
        returns (bool)
    {
        if (moduleTypeId == MODULE_TYPE_VALIDATOR) return _validators[module];
        if (moduleTypeId == MODULE_TYPE_EXECUTOR) return _executors[module];
        return false;
    }

    function _install(uint256 moduleTypeId, address module, bytes calldata initData) internal {
        if (moduleTypeId == MODULE_TYPE_VALIDATOR) {
            _validators[module] = true;
        } else if (moduleTypeId == MODULE_TYPE_EXECUTOR) {
            _executors[module] = true;
        } else {
            revert UnsupportedModuleType(moduleTypeId);
        }
        IModule(module).onInstall(initData);
        emit ModuleInstalled(moduleTypeId, module);
    }

    // ───────────────────────── ERC-1271 ─────────────────────────

    /// @dev signature = validator(20 bytes) ‖ validator 專屬資料
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length < 20) return ERC1271_INVALID;
        address validator = address(bytes20(signature[0:20]));
        if (!_validators[validator]) return ERC1271_INVALID;
        return IValidator(validator).isValidSignatureWithSender(msg.sender, hash, signature[20:]);
    }

    function accountId() external pure returns (string memory) {
        return "cafeca.identity-account.0.1.0";
    }

    receive() external payable {}
}
