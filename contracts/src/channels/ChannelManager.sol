// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CafecaAccount} from "../account/CafecaAccount.sol";
import {ChannelPolicy, IChannelManager} from "./ChannelTypes.sol";

/// @title ChannelManager
/// @notice 為身分帳戶建立支出通道子帳戶（CafecaAccount clone），並安裝 ChannelValidator。
///         呼叫者即為 parent；任何人都能建立屬於自己的通道。
contract ChannelManager is IChannelManager {
    address public immutable accountImpl;
    address public immutable channelValidator;

    mapping(address channel => address parent) public parentOf;

    event ChannelCreated(address indexed parent, address indexed channel, uint8 channelType, address operator);

    constructor(address accountImpl_, address channelValidator_) {
        accountImpl = accountImpl_;
        channelValidator = channelValidator_;
    }

    function channelAddress(address parent, bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(accountImpl, keccak256(abi.encode(parent, salt)));
    }

    function createChannel(uint8 channelType, address operator, ChannelPolicy calldata policy, bytes32 salt)
        external
        returns (address channel)
    {
        channel = Clones.cloneDeterministic(accountImpl, keccak256(abi.encode(msg.sender, salt)));

        address[] memory mods = new address[](1);
        mods[0] = channelValidator;
        bytes[] memory vdata = new bytes[](1);
        vdata[0] = abi.encode(msg.sender, operator, channelType, policy);
        bytes[] memory edata = new bytes[](1);
        edata[0] = "";

        CafecaAccount(payable(channel)).initialize(mods, vdata, mods, edata);
        parentOf[channel] = msg.sender;
        emit ChannelCreated(msg.sender, channel, channelType, operator);
    }
}
