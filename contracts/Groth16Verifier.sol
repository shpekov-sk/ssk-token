// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Groth16Verifier
 * @notice Проверка Groth16-доказательства на BN254 через прекомпайлы EVM.
 *
 * Проверяется одно равенство:
 *
 *   e(A, B) == e(alpha, beta) * e(IC, gamma) * e(C, delta)
 *
 * переписанное как произведение, равное единице, — именно в таком виде его
 * умеет считать прекомпайл 0x08 одним вызовом:
 *
 *   e(-A, B) * e(alpha, beta) * e(IC, gamma) * e(C, delta) == 1
 *
 * Стоимость проверки не зависит от размера схемы: всегда три точки в
 * доказательстве и четыре спаривания. Это и есть смысл SNARK — проверяющий
 * не повторяет вычисление, а проверяет алгебраическое тождество.
 *
 * Прекомпайлы: 0x06 сложение в G1, 0x07 умножение в G1, 0x08 спаривание.
 */
contract Groth16Verifier {
    /// @dev Модуль базового поля BN254. Нужен для отрицания точки: -P = (x, p - y).
    uint256 internal constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @dev Порядок скалярного поля. Публичные входы обязаны быть меньше него.
    uint256 internal constant R = 21888242871839275222246405745257275088548364400416034343698204186575808495617;

    error InvalidPublicInput(uint256 value);
    error PrecompileFailed(address precompile);

    // Ключ проверки. G2-точки хранятся в порядке EIP-197: мнимая часть первой.
    uint256[2] public alphaG1;
    uint256[4] public betaG2;
    uint256[4] public gammaG2;
    uint256[4] public deltaG2;
    /// @dev По точке на публичный вход: ic[0] отвечает за константу 1.
    uint256[2][2] public ic;

    constructor(
        uint256[2] memory alphaG1_,
        uint256[4] memory betaG2_,
        uint256[4] memory gammaG2_,
        uint256[4] memory deltaG2_,
        uint256[2][2] memory ic_
    ) {
        alphaG1 = alphaG1_;
        betaG2 = betaG2_;
        gammaG2 = gammaG2_;
        deltaG2 = deltaG2_;
        ic = ic_;
    }

    /**
     * @param a точка A доказательства
     * @param b точка B доказательства, в G2
     * @param c точка C доказательства
     * @param publicInputs публичные входы схемы; publicInputs[0] обязан быть 1
     */
    function verify(
        uint256[2] calldata a,
        uint256[4] calldata b,
        uint256[2] calldata c,
        uint256[2] calldata publicInputs
    ) public view returns (bool) {
        // Вход вне поля позволил бы обойти проверку переполнением.
        for (uint256 i = 0; i < publicInputs.length; i++) {
            if (publicInputs[i] >= R) revert InvalidPublicInput(publicInputs[i]);
        }

        // IC = Σ publicInputs[i] * ic[i] — вклад публичной части в утверждение.
        uint256[2] memory acc = scalarMul(ic[0], publicInputs[0]);
        for (uint256 i = 1; i < publicInputs.length; i++) {
            acc = pointAdd(acc, scalarMul(ic[i], publicInputs[i]));
        }

        // Четыре пары подряд: (-A, B), (alpha, beta), (IC, gamma), (C, delta).
        uint256[24] memory input;

        input[0] = a[0];
        input[1] = negateY(a[1]);
        input[2] = b[0];
        input[3] = b[1];
        input[4] = b[2];
        input[5] = b[3];

        input[6] = alphaG1[0];
        input[7] = alphaG1[1];
        input[8] = betaG2[0];
        input[9] = betaG2[1];
        input[10] = betaG2[2];
        input[11] = betaG2[3];

        input[12] = acc[0];
        input[13] = acc[1];
        input[14] = gammaG2[0];
        input[15] = gammaG2[1];
        input[16] = gammaG2[2];
        input[17] = gammaG2[3];

        input[18] = c[0];
        input[19] = c[1];
        input[20] = deltaG2[0];
        input[21] = deltaG2[1];
        input[22] = deltaG2[2];
        input[23] = deltaG2[3];

        uint256[1] memory result;
        bool ok;
        assembly {
            ok := staticcall(gas(), 0x08, input, 768, result, 32)
        }
        if (!ok) revert PrecompileFailed(address(0x08));

        return result[0] == 1;
    }

    /// @dev -P = (x, p - y). Ноль остаётся нулём: точка на бесконечности это (0, 0).
    function negateY(uint256 y) internal pure returns (uint256) {
        return y == 0 ? 0 : P - (y % P);
    }

    function pointAdd(uint256[2] memory left, uint256[2] memory right) internal view returns (uint256[2] memory out) {
        uint256[4] memory input;
        input[0] = left[0];
        input[1] = left[1];
        input[2] = right[0];
        input[3] = right[1];

        bool ok;
        assembly {
            ok := staticcall(gas(), 0x06, input, 128, out, 64)
        }
        if (!ok) revert PrecompileFailed(address(0x06));
    }

    function scalarMul(uint256[2] memory point, uint256 scalar) internal view returns (uint256[2] memory out) {
        uint256[3] memory input;
        input[0] = point[0];
        input[1] = point[1];
        input[2] = scalar;

        bool ok;
        assembly {
            ok := staticcall(gas(), 0x07, input, 96, out, 64)
        }
        if (!ok) revert PrecompileFailed(address(0x07));
    }
}
