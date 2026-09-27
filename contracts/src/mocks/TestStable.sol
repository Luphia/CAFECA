// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestStable（測試網 TWDC）
/// @notice 測試用穩定幣，任何人每天可領取一次。
contract TestStable is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 50_000e6;
    mapping(address => uint256) public lastClaim;

    error TooSoon();

    constructor() ERC20("CAFECA TWD Test Coin", "TWDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet(address to) external {
        if (block.timestamp < lastClaim[to] + 1 days) revert TooSoon();
        lastClaim[to] = block.timestamp;
        _mint(to, FAUCET_AMOUNT);
    }
}
