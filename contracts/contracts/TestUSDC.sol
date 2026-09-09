// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice Demo liquidity token for ComputeCred on Creditcoin CC3. Unrestricted minting lets any
///         participant act as a liquidity provider during the demo. NOT production collateral.
contract TestUSDC is ERC20 {
    uint8 private constant _DECIMALS = 6;

    constructor(uint256 initialSupply) ERC20("Test USDC", "tUSDC") {
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}