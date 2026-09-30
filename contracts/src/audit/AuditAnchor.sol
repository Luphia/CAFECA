// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AuditAnchor
/// @notice 把 CAFECA 稽核紀錄（hash-chained）的最新 hash 定期寫上鏈（規格 §16.6 P3-A6）。
///         事後任何人都能用鏈上的 (count, head) 核對：稽核紀錄第 count 筆的 hash 必須等於 head，
///         否則代表那一天之前的紀錄被改寫過。合約只接受登記過的 anchorer，count 必須遞增。
contract AuditAnchor {
    address public owner;
    mapping(address => bool) public isAnchorer;
    uint64 public lastCount;
    bytes32 public lastHead;

    event Anchored(bytes32 indexed head, uint64 count, uint64 at, address indexed by);
    event AnchorerSet(address indexed anchorer, bool allowed);
    event OwnerChanged(address indexed owner);

    error OnlyOwner();
    error OnlyAnchorer();
    error CountNotIncreasing(uint64 last);

    constructor(address owner_) {
        owner = owner_;
        isAnchorer[owner_] = true;
        emit OwnerChanged(owner_);
        emit AnchorerSet(owner_, true);
    }

    function setAnchorer(address a, bool allowed) external {
        if (msg.sender != owner) revert OnlyOwner();
        isAnchorer[a] = allowed;
        emit AnchorerSet(a, allowed);
    }

    function transferOwner(address to) external {
        if (msg.sender != owner) revert OnlyOwner();
        owner = to;
        emit OwnerChanged(to);
    }

    /// @param head  稽核紀錄第 count 筆的 hash
    /// @param count 到目前為止的紀錄筆數（必須大於上次）
    function anchor(bytes32 head, uint64 count) external {
        if (!isAnchorer[msg.sender]) revert OnlyAnchorer();
        if (count <= lastCount) revert CountNotIncreasing(lastCount);
        lastCount = count;
        lastHead = head;
        emit Anchored(head, count, uint64(block.timestamp), msg.sender);
    }
}
