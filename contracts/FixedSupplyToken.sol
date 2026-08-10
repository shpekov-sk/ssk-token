// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title FixedSupplyToken
 * @notice Обычный ERC-20 с фиксированной эмиссией. Ничего лишнего.
 *
 * Весь supply чеканится один раз в конструкторе. Владельца у контракта нет,
 * функции mint нет — допечатать нельзя ни при каких условиях. Кода, который
 * может тронуть чужой баланс, здесь тоже нет: ни pause, ни blacklist, ни
 * комиссий на перевод.
 *
 * Название, символ, decimals и объём задаются при деплое — контракт под них
 * не пересобирается.
 */
contract FixedSupplyToken is ERC20, ERC20Burnable, ERC20Permit {
    uint8 private immutable _decimals;

    /**
     * @param name_ полное название, как его покажет кошелёк
     * @param symbol_ тикер
     * @param decimals_ знаков после запятой (18 — стандарт для ERC-20)
     * @param initialSupply вся эмиссия, в минимальных единицах
     * @param initialHolder адрес, который получает весь supply
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 initialSupply,
        address initialHolder
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        require(initialHolder != address(0), "holder is zero address");
        require(initialSupply > 0, "supply is zero");

        _decimals = decimals_;
        _mint(initialHolder, initialSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
