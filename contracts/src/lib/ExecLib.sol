// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Execution, CALLTYPE_SINGLE, CALLTYPE_BATCH} from "../interfaces/IERC7579.sol";

/// @notice ERC-7579 execution calldata 編解碼
/// single: abi.encodePacked(target(20), value(32), callData)
/// batch : abi.encode(Execution[])
library ExecLib {
    error UnsupportedCallType(bytes1 callType);

    function modeSingle() internal pure returns (bytes32) {
        return bytes32(CALLTYPE_SINGLE);
    }

    function modeBatch() internal pure returns (bytes32) {
        return bytes32(CALLTYPE_BATCH);
    }

    function encodeSingle(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(target, value, data);
    }

    function encodeBatch(Execution[] memory execs) internal pure returns (bytes memory) {
        return abi.encode(execs);
    }

    /// @dev 將任一模式的 execution calldata 解成 Execution[]（memory 版本，供 validator 分析用）
    function decode(bytes32 mode, bytes memory ec) internal pure returns (Execution[] memory execs) {
        bytes1 callType = mode[0];
        if (callType == CALLTYPE_SINGLE) {
            execs = new Execution[](1);
            execs[0] = decodeSingleMem(ec);
        } else if (callType == CALLTYPE_BATCH) {
            execs = abi.decode(ec, (Execution[]));
        } else {
            revert UnsupportedCallType(callType);
        }
    }

    function decodeSingleMem(bytes memory ec) internal pure returns (Execution memory e) {
        require(ec.length >= 52, "ExecLib: short");
        address target;
        uint256 value;
        assembly {
            target := shr(96, mload(add(ec, 32)))
            value := mload(add(ec, 52))
        }
        bytes memory data = new bytes(ec.length - 52);
        for (uint256 i = 0; i < data.length; i++) {
            data[i] = ec[52 + i];
        }
        e = Execution(target, value, data);
    }

    function decodeSingle(bytes calldata ec)
        internal
        pure
        returns (address target, uint256 value, bytes calldata data)
    {
        target = address(bytes20(ec[0:20]));
        value = uint256(bytes32(ec[20:52]));
        data = ec[52:];
    }

    /// @dev 讀取 calldata 的 4-byte selector（長度不足回傳 0）
    function selector(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(data, 32))
        }
    }

    /// @dev 去掉 selector 的參數區段
    function args(bytes memory data) internal pure returns (bytes memory out) {
        require(data.length >= 4, "ExecLib: no selector");
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[4 + i];
        }
    }
}
