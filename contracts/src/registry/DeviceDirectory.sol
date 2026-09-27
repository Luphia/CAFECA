// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DeviceDirectory
/// @notice 聊天用裝置金鑰目錄（X25519／Ed25519 或 MLS KeyPackage 的 credential）。
///         msg.sender 為身分帳戶；帳戶本身已經由 KeyringValidator 驗證過簽章。
contract DeviceDirectory {
    struct Device {
        bytes credential;
        uint48 registeredAt;
        bool active;
    }

    mapping(bytes32 deviceId => mapping(address account => Device)) private _devices;
    mapping(address account => bytes32[]) private _deviceIds;

    event DeviceRegistered(address indexed account, bytes32 indexed deviceId, bytes credential);
    event DeviceRevoked(address indexed account, bytes32 indexed deviceId);

    function registerDevice(bytes32 deviceId, bytes calldata credential) external {
        Device storage d = _devices[deviceId][msg.sender];
        if (d.registeredAt == 0) _deviceIds[msg.sender].push(deviceId);
        d.credential = credential;
        d.registeredAt = uint48(block.timestamp);
        d.active = true;
        emit DeviceRegistered(msg.sender, deviceId, credential);
    }

    function revokeDevice(bytes32 deviceId) external {
        _devices[deviceId][msg.sender].active = false;
        emit DeviceRevoked(msg.sender, deviceId);
    }

    function deviceOf(address account, bytes32 deviceId) external view returns (Device memory) {
        return _devices[deviceId][account];
    }

    function deviceIdsOf(address account) external view returns (bytes32[] memory) {
        return _deviceIds[account];
    }
}
