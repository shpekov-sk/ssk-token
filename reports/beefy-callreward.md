# `callReward()` overstates the harvest caller fee by ~4700x on Base

**Severity:** low (no funds at risk) — **incorrect public accounting that misleads third-party harvesters**

**Reporter:** independent, no affiliation. Reproduction is one `debug_traceCall`; no transaction was sent.

---

## Summary

On Base, `callReward()` on active Beefy strategies returns a value roughly **4700x larger** than the
amount `harvest()` actually transfers to the caller.

Measured on six vaults in a single pass, the ratio sits in a 4701–4703 band despite the underlying
reward magnitudes differing by ~40x. That consistency points at a fixed scaling factor — a fee-config
unit mismatch or a missing `DIVISOR` division — rather than per-vault reward variation.

Consequence: anyone who uses `callReward()` to decide whether harvesting is profitable — which is what
the function exists for — will call `harvest()` at a loss. On Base the real fee recovers about **12%
of the gas**.

## Measurements

Chain: Base (8453). Gas price at measurement: 0.006 gwei. ETH taken as $1882.
Fee actually received by the caller is a **WETH** transfer
(`0x4200000000000000000000000000000000000006`), not native ETH.

| vault | `callReward()` | actual to caller | gas | net | ratio |
|---|---|---|---|---|---|
| `aerodrome-cow-base-cbbtc-usdc-vault` | $22.6199 | $0.0048 | $0.0389 | **−$0.0341** | 4703x |
| `aero-cow-eurc-cbbtc-vault` | $14.1546 | $0.0030 | $0.0389 | **−$0.0359** | 4702x |
| `aero-cow-usdc-cbbtc-vault` | $10.8331 | $0.0023 | $0.0276 | **−$0.0253** | 4702x |
| `aero-cow-tbtc-usdc-vault` | $8.0746 | $0.0017 | $0.0391 | **−$0.0374** | 4702x |
| `aerodrome-cow-base-usdc-aero-vault` | $3.3519 | $0.0007 | $0.0365 | **−$0.0358** | 4703x |
| `aero-cow-weth-usdc-vault` | $2.5979 | $0.0006 | $0.0383 | **−$0.0377** | 4701x |

Raw values for the first row, so the ratio can be checked without unit conversion:

```
strategy      0x8B45D51e015Dac924EeAEa754e6f768943206F05
callReward()  11918429061680176        wei   (0.011918429061680176)
actual        2552038287192            wei   (0.000002552038287192, WETH)
gas estimate  3485462
```

This pair gives 4670x rather than the 4703x in the table above: the two reads were seconds apart, and
`callReward()` grows as rewards accrue. The table values come from per-vault reads taken together. The
drift between runs is a few tenths of a percent and does not affect the conclusion — the discrepancy
is three and a half orders of magnitude either way.

Across 234 active Base vaults, 212 report a positive `callReward()`. Every one of the six traced is
net negative after gas.

## Reproduction

No transaction required. Any archive-capable node with `debug_traceCall` works; public Base endpoints
mostly do not expose it, `base.drpc.org` does.

**1. Claimed reward** — `callReward()`:

```bash
curl -s https://base.drpc.org -H 'Content-Type: application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"eth_call",
  "params":[{"to":"0x8B45D51e015Dac924EeAEa754e6f768943206F05","data":"0x97fd323d"},"latest"]
}'
```

**2. Actual reward** — trace `harvest()` and look for a `transfer(caller, amount)` on WETH:

```bash
curl -s https://base.drpc.org -H 'Content-Type: application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"debug_traceCall",
  "params":[{"from":"0x0cf1430E31B264a262aFF5fBA4D577daB5660A2a",
             "to":"0x8B45D51e015Dac924EeAEa754e6f768943206F05",
             "data":"0x4641257d"},"latest",{"tracer":"callTracer"}]
}'
```

In the returned call tree there is exactly one `0xa9059cbb` (ERC-20 `transfer`) whose recipient is the
`from` address. Its amount is the real fee. `harvest()` does **not** revert for an arbitrary caller,
so this is reachable by anyone.

A script that does this over the whole Base vault list is at
[`scripts/keeper/harvest-scan.mjs`](../scripts/keeper/harvest-scan.mjs):

```bash
node scripts/keeper/harvest-scan.mjs 6
```

## Impact

- Third-party keepers are the intended audience of `callReward()`. Acting on it means spending gas to
  earn ~1/4700 of the expected amount. On Base that is a net loss on every call.
- The error is silent: nothing reverts, and the harvest itself succeeds and behaves correctly. Only
  the advertised incentive is wrong.
- Vault depositors are unaffected — compounding still works, and the protocol pays out less than it
  advertises, not more.

## What this report does not establish

- **Root cause.** I did not read the deployed strategy source, so I cannot point at the line. The
  constant ratio is evidence for a fixed factor, not proof of where it comes from. Worth checking
  the fee-config units (`fees.total` / `fees.call` and `DIVISOR`) in the fee-manager path used by
  these CLM/"cow" strategies, and whether `callReward()` is inherited from a base contract that
  predates the current fee mechanics.
- **Intended units.** If `callReward()` is deliberately denominated in something other than the
  native-equivalent caller fee, then this is a documentation issue rather than an arithmetic one.
  Please say so and I will withdraw the arithmetic framing — but in that case the function is still
  unusable for its apparent purpose, since callers compare it against gas.
- **Other chains.** Measured on Base only. The tooling is chain-agnostic if you want the same numbers
  elsewhere.

## Suggested fix

Either correct the scaling so `callReward()` matches what `harvest()` transfers, or document the unit
explicitly and expose a separate native-denominated estimate that keepers can compare against gas.
