// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title CafecaMultisig
/// @notice M-of-N 多簽（規格 §16.6 P3-A2）：治理權（登記／移除 KYC 簽章者、稽核上鏈合約的管理權）交給它之後，
///         部署者單一金鑰就不能再換簽章者。簽章在各自的裝置離線產生（personal_sign），任何人都可以代送。
/// @dev 簽署內容 = personal_sign(keccak256(abi.encode("CAFECA_MULTISIG_V1", chainId, this, to, value, keccak256(data), nonce)))，
///      簽章依簽署者位址遞增排列（避免重複計算）。成員與門檻只能由多簽自己修改。
contract CafecaMultisig {
    bytes32 public constant DOMAIN = keccak256("CAFECA_MULTISIG_V1");

    address[] internal _owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;
    uint256 public nonce;

    event Executed(uint256 indexed nonce, address indexed to, uint256 value, bytes data, bool success);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);

    error BadThreshold();
    error BadOwner();
    error NotEnoughSignatures();
    error SignerNotOwner(address signer);
    error SignersNotSorted();
    error OnlySelf();
    error CallFailed(bytes reason);

    constructor(address[] memory owners_, uint256 threshold_) {
        for (uint256 i; i < owners_.length; i++) _addOwner(owners_[i]);
        _setThreshold(threshold_);
    }

    receive() external payable {}

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function txHash(address to, uint256 value, bytes calldata data, uint256 nonce_) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), to, value, keccak256(data), nonce_));
    }

    /// @param sigs 至少 threshold 個成員的簽章，依簽署者位址遞增排列
    function execute(address to, uint256 value, bytes calldata data, bytes[] calldata sigs) external returns (bytes memory) {
        if (sigs.length < threshold) revert NotEnoughSignatures();
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(txHash(to, value, data, nonce));
        address last;
        for (uint256 i; i < sigs.length; i++) {
            address s = ECDSA.recover(digest, sigs[i]);
            if (!isOwner[s]) revert SignerNotOwner(s);
            if (s <= last) revert SignersNotSorted();
            last = s;
        }
        uint256 n = nonce++;
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        emit Executed(n, to, value, data, ok);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    function addOwner(address o, uint256 newThreshold) external onlySelf {
        _addOwner(o);
        _setThreshold(newThreshold);
    }

    function removeOwner(address o, uint256 newThreshold) external onlySelf {
        if (!isOwner[o]) revert BadOwner();
        isOwner[o] = false;
        for (uint256 i; i < _owners.length; i++) {
            if (_owners[i] == o) {
                _owners[i] = _owners[_owners.length - 1];
                _owners.pop();
                break;
            }
        }
        emit OwnerRemoved(o);
        _setThreshold(newThreshold);
    }

    function changeThreshold(uint256 t) external onlySelf {
        _setThreshold(t);
    }

    function _addOwner(address o) internal {
        if (o == address(0) || o == address(this) || isOwner[o]) revert BadOwner();
        isOwner[o] = true;
        _owners.push(o);
        emit OwnerAdded(o);
    }

    function _setThreshold(uint256 t) internal {
        if (t == 0 || t > _owners.length) revert BadThreshold();
        threshold = t;
        emit ThresholdChanged(t);
    }
}
