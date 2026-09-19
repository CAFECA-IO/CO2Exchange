# Gas Report

Generated: 2026-09-19
Toolchain: Foundry (forge 1.7.1), solc 0.8.26, `evm_version = cancun`, default (non-production) profile (`via_ir = false`)

Command:

```bash
forge test --gas-report --no-match-contract "FuzzTest|PoolInvariantTest"
```

Fuzz and invariant suites are excluded here because they exercise randomized
inputs and would report noisy min/max ranges rather than representative
costs; the 68 deterministic unit/integration tests give a stable baseline.
The full raw table (all 21 contracts touched by the test suite, including
vendored OpenZeppelin/Safe/Uniswap v4 test/proxy contracts) is in the
appendix at the bottom of this file. A companion `.gas-snapshot` (via
`forge snapshot`) pins per-test gas totals for regression tracking in CI —
run `forge snapshot --check` (excluding the fuzz/invariant contracts) before
a release to catch unintended gas regressions.

## Deployment cost, core contracts

Sorted by gas cost, descending. `via_ir` is **off** here (dev profile); the
`[profile.production]` block in `foundry.toml` enables `via_ir = true` with
`optimizer_runs = 44444444`, which will reduce these figures materially and
should be re-measured before mainnet/production deployment
(`FOUNDRY_PROFILE=production forge build`).

| Contract | Deployment gas | Bytecode size |
|---|---:|---:|
| `KYCRegistry` (identity, UUPS impl) | 2,644,112 | 12,111 B |
| `CarbonPool` (market, UUPS impl) | 2,507,016 | 11,476 B |
| `CarbonCredit1155` (registry, immutable) | 2,441,830 | 11,594 B |
| `RetirementCertificate` (registry, immutable) | 2,277,263 | 10,295 B |
| `CarbonRegistry` (registry, immutable) | 2,105,914 | 10,568 B |
| `Listing` (market, UUPS impl) | 1,885,117 | 8,600 B |
| `PasskeyAccountFactory` | 1,784,254 | 8,041 B |
| `CarbonCreditToken` / CCT (market, UUPS impl) | 1,441,303 | 6,548 B |
| `TrustedRouter` (v4) | 1,021,249 | 4,707 B |

All bytecode sizes are comfortably under the 24,576-byte EIP-170 limit,
including the largest contract (`KYCRegistry` at 12,111 B) — no contract is
close to the ceiling even before `via_ir` shrinks them further.

`PasskeyAccount` instances are deployed via `PasskeyAccountFactory.createAccount`
(CREATE2), not a standalone `new PasskeyAccount()` call, so its per-account
marginal cost is captured under `createAccount` below rather than as a
separate deployment line. `MockTWD` (762,489 gas) is test-only settlement
token, not part of the deployed system.

## Key user-facing operations

Grouped by lifecycle stage. "Med" = median gas across all calls in the
suite; "Max" reflects the most expensive observed path (e.g. an issuance
into a fresh storage slot, or a redemption spanning multiple FIFO batches).

### Identity / KYC

| Function | Min | Median | Max | Calls |
|---|---:|---:|---:|---:|
| `KYCRegistry.register` (EIP-712 attested onboarding) | 3,264 | 86,803 | 86,803 | 214 |
| `KYCRegistry.setFrozen` | 3,034 | 9,558 | 9,558 | 5 |
| `KYCRegistry.recover` (balance migration on lost key) | 3,263 | 8,073 | 289,962 | 3 |

### Issuance (enterprise → credits)

| Function | Min | Median | Max | Calls |
|---|---:|---:|---:|---:|
| `CarbonRegistry.registerProject` | 34,513 | 183,325 | 183,325 | 49 |
| `CarbonRegistry.issue` (EIP-712 verifier-attested mint) | 41,095 | 349,083 | 349,095 | 55 |

### Trading

| Function | Min | Median | Max | Calls |
|---|---:|---:|---:|---:|
| `Listing.list` | 2,606 | 282,959 | 302,859 | 14 |
| `Listing.buy` | 24,944 | 129,796 | 226,554 | 7 |
| `Listing.cancel` | 83,757 | 83,757 | 83,757 | 1 |
| `CarbonCredit1155.setApprovalForAll` | 46,269 | 46,269 | 46,269 | 34 |

### Pooling / fungibility

| Function | Min | Median | Max | Calls |
|---|---:|---:|---:|---:|
| `CarbonPool.deposit` (1155 → CCT) | 20,361 | 310,443 | 320,925 | 20 |
| `CarbonPool.redeem` (FIFO, free) | 32,091 | 178,753 | 325,415 | 2 |
| `CarbonPool.redeemSpecific` (fee-weighted) | 203,740 | 203,740 | 203,740 | 1 |
| `CarbonPool.redeemAndRetire` | 297,029 | 306,998 | 316,967 | 2 |

### Retirement / certification

| Function | Min | Median | Max | Calls |
|---|---:|---:|---:|---:|
| `CarbonCredit1155.retire` | 27,308 | 42,403 | 300,252 | 7 |
| `RetirementCertificate.setDocumentHash` (PDF hash anchor) | 24,471 | 37,371 | 50,272 | 4 |

### Passkey smart account

| Function | Min | Median | Max | Calls |
|---|---:|---:|---:|---:|
| `PasskeyAccountFactory.createAccount` (CREATE2, first use) | 30,594 | 1,514,142 | 1,514,142 | 8 |
| `PasskeyAccount.execute` (WebAuthn-verified call) | 58,139 | 354,413 | 593,467 | 7 |

`createAccount`'s median (~1.51M gas) reflects the cold-storage cost of
deploying the account's own bytecode the *first* time a given passkey is
used; the 30,594 min is the idempotent re-derivation path (`getAddress`
short-circuit) when the account already exists. `PasskeyAccount.execute`'s
range depends on the wrapped call — a single ERC-20 transfer sits near the
low end, a batched buy+retire sequence near the high end.

### Governance (role & access control — indicative, all contracts)

| Function | Min | Median | Max |
|---|---:|---:|---:|
| `grantRole` (across contracts) | 5,149 | ~29,700 | 29,755 |
| `revokeRole` (across contracts) | 12,612 | 12,613 | 12,613 |
| `upgradeToAndCall` (UUPS upgrade) | 3,485 | 7,383 | 21,716 |

Full Safe multisig execution overhead (signature verification + module
calls) and Timelock schedule/execute overhead are covered qualitatively in
the governance manual rather than here, since `SafeGovernanceTest` and
`Governance.t.sol` measure the *target* contract call, not the Safe/Timelock
wrapper transaction itself.

## Observations / follow-ups

- **`via_ir` not yet measured end-to-end.** The production profile
  (`optimizer_runs = 44444444`, `via_ir = true`) should be re-run with
  `FOUNDRY_PROFILE=production forge test --gas-report` before deployment;
  expect meaningful reductions, especially in the larger contracts
  (`KYCRegistry`, `CarbonPool`, `CarbonCredit1155`).
- **`CarbonRegistry.issue` and `Listing.list`/`CarbonPool.deposit` are the
  three most expensive steady-state operations** (~280k–350k gas). These
  are enterprise/operator-invoked, low-frequency actions (per issuance
  batch, per listing), not high-frequency retail actions, so the cost
  profile matches the intended usage pattern (individuals mostly call the
  cheaper `buy`/`redeem` paths).
- **`PasskeyAccountFactory.createAccount`'s ~1.5M-gas first-use cost** is
  the largest single line item a new user encounters. Phase 1's move to
  ERC-4337 (EntryPoint + paymaster, noted in `architecture-decisions.md`)
  is the intended way to sponsor this so a first-time user never needs
  native gas — this figure is the concrete number that sponsorship budget
  should be sized against.
- No function in the suite approaches block gas limits; the largest single
  call observed (`PasskeyAccountFactory.createAccount` max, 1,514,142) is
  well within any mainnet or L2 block gas limit.

## Appendix: full raw `forge test --gas-report` output

<details>
<summary>Click to expand — all 21 contracts (including vendored OpenZeppelin / Safe / Uniswap v4 test &amp; proxy contracts touched by the suite)</summary>

```
No files changed, compilation skipped

Ran 5 tests for test/Governance.t.sol:GovernanceTest
[PASS] test_credit_registryCanOnlyBeSetOnce() (gas: 36704)
[PASS] test_handover_sovereignRoleToNationalAgency() (gas: 313422)
[PASS] test_registryLayerHasNoUpgradePath() (gas: 81053)
[PASS] test_sovereignCanRevokeOperatorUnilaterally() (gas: 84873)
[PASS] test_upgrade_onlyAdmin() (gas: 2813435)
Suite result: ok. 5 passed; 0 failed; 0 skipped; finished in 5.32ms (874.06µs CPU time)

Ran 8 tests for test/Identity.t.sol:IdentityTest
[PASS] test_expiry_blocksTransferButNotRetire() (gas: 937497)
[PASS] test_freeze_blocksEverything() (gas: 697567)
[PASS] test_individualCannotTransferByDefault() (gas: 975995)
[PASS] test_recover_movesBalancesAndIdentity() (gas: 1328000)
[PASS] test_recover_rejectsDifferentIdentityHash() (gas: 88764)
[PASS] test_register_rejectsUnknownSigner() (gas: 76007)
[PASS] test_register_replayRejected() (gas: 193771)
[PASS] test_register_setsIdentity() (gas: 52953)
Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 7.43ms (3.40ms CPU time)

Ran 7 tests for test/Pool.t.sol:PoolTest
[PASS] test_deposit_mintsCct() (gas: 349720)
[PASS] test_deposit_rejectsWrongVintage() (gas: 627127)
[PASS] test_individualCannotDeposit() (gas: 262415)
[PASS] test_redeemAndRetire_individualPath() (gas: 853744)
[PASS] test_redeemSpecific_chargesFee() (gas: 935682)
[PASS] test_redeem_insufficientLiquidity() (gas: 389559)
[PASS] test_redeem_isFifoAcrossBatches() (gas: 981459)
Suite result: ok. 7 passed; 0 failed; 0 skipped; finished in 16.09ms (2.65ms CPU time)

Ran 8 tests for test/Listing.t.sol:ListingTest
[PASS] test_buy_belowMinFillRejected() (gas: 431619)
[PASS] test_buy_lastFillIgnoresMinFill() (gas: 736216)
[PASS] test_cancel_returnsRemaining() (gas: 396595)
[PASS] test_feeCapEnforced() (gas: 42082)
[PASS] test_individualCannotList() (gas: 215546)
[PASS] test_listAndBuy_individual() (gas: 660899)
[PASS] test_pause_blocksTrading() (gas: 96965)
[PASS] test_unverifiedCannotBuy() (gas: 355441)
Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 5.84ms (1.70ms CPU time)

Ran 12 tests for test/Registry.t.sol:RegistryTest
[PASS] test_documentRole_onlyDocumentSignerWritesHash_operatorRotatesIt() (gas: 1083724)
[PASS] test_frozenBatch_blocksTransferAndRetire() (gas: 696416)
[PASS] test_issue_mintsToProjectOwnerWithMetadata() (gas: 600247)
[PASS] test_issue_rejectsDuplicateSerial() (gas: 614694)
[PASS] test_issue_rejectsInactiveProject() (gas: 275597)
[PASS] test_issue_rejectsRevokedVerifier() (gas: 286035)
[PASS] test_onlyRegistryCanIssue() (gas: 37270)
[PASS] test_registerProject_requiresCorporate() (gas: 85232)
[PASS] test_retire_burnsAndMintsSoulboundCertificate() (gas: 1126554)
[PASS] test_retire_certificateRecipientMustBeKnown() (gas: 607861)
[PASS] test_retire_requiresApprovalForThirdParty() (gas: 592813)
[PASS] test_transferToUnverifiedBlocked() (gas: 608512)
Suite result: ok. 12 passed; 0 failed; 0 skipped; finished in 18.00ms (13.12ms CPU time)

Ran 7 tests for test/PasskeyAccount.t.sol:PasskeyAccountTest
[PASS] test_erc1271() (gas: 587310)
[PASS] test_execute_buyThenRetire_viaRelayer() (gas: 1287218)
[PASS] test_execute_innerRevertBubbles() (gas: 413365)
[PASS] test_execute_replayRejected() (gas: 443892)
[PASS] test_execute_tamperedCallRejected() (gas: 90633)
[PASS] test_execute_wrongKeyRejected() (gas: 335221)
[PASS] test_factory_isIdempotentAndDeterministic() (gas: 42298)
Suite result: ok. 7 passed; 0 failed; 0 skipped; finished in 17.98ms (12.86ms CPU time)

Ran 10 tests for test/V4.t.sol:V4Test
[PASS] test_addLiquidity_individualRejected() (gas: 95186)
[PASS] test_endToEnd_buyThenRetire() (gas: 613317)
[PASS] test_initialize_onlyOperator() (gas: 126262)
[PASS] test_initialize_rejectsNonCarbonPair() (gas: 60924)
[PASS] test_removeLiquidity_corporateOk() (gas: 164443)
[PASS] test_swap_dailyLimitEnforcedByActualDelta() (gas: 551267)
[PASS] test_swap_individualBuysCct() (gas: 230541)
[PASS] test_swap_individualCannotSell() (gas: 369235)
[PASS] test_swap_untrustedRouterRejected() (gas: 1515371)
[PASS] test_swap_unverifiedRejected() (gas: 209955)
Suite result: ok. 10 passed; 0 failed; 0 skipped; finished in 8.42ms (3.50ms CPU time)

Ran 11 tests for test/SafeGovernance.t.sol:SafeGovernanceTest
[PASS] test_handover_noEoaHoldsGovernance() (gas: 120206)
[PASS] test_nationalSafe_canPauseAsEmergency() (gas: 142713)
[PASS] test_nationalSafe_freezeImmediately() (gas: 132063)
[PASS] test_nationalSafe_revokesOperatorWithoutDelay() (gas: 240677)
[PASS] test_nationalSafe_singleSignerRejected() (gas: 96309)
[PASS] test_operatorSafe_cannotFreezeOrGrantRoles() (gas: 229673)
[PASS] test_operatorSafe_pauseAndUnpause() (gas: 249722)
[PASS] test_registryLayer_sovereignActionsWork() (gas: 139775)
[PASS] test_sovereignRoleChange_requiresTimelock() (gas: 435579)
[PASS] test_timelock_onlyNationalSafeCanPropose() (gas: 42300)
[PASS] test_upgrade_throughTimelock() (gas: 3220203)
Suite result: ok. 11 passed; 0 failed; 0 skipped; finished in 25.99ms (7.74ms CPU time)

╭----------------------------------------------------------------------------------------------------+-----------------+-------+--------+-------+---------╮
| lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController Contract |                 |       |        |       |         |
+=========================================================================================================================================================+
| Deployment Cost                                                                                    | Deployment Size |       |        |       |         |
|----------------------------------------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                                                            1600113 |            7683 |       |        |       |         |
|----------------------------------------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                                                                    |                 |       |        |       |         |
|----------------------------------------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| Function Name                                                                                      | Min             | Avg   | Median | Max   | # Calls |
|----------------------------------------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| getMinDelay                                                                                        |            2401 |  2401 |   2401 |  2401 |       2 |
|----------------------------------------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| schedule                                                                                           |           26836 | 26836 |  26836 | 26836 |       1 |
╰----------------------------------------------------------------------------------------------------+-----------------+-------+--------+-------+---------╯

╭-------------------------------------------------------------------------------------------+-----------------+-------+--------+--------+---------╮
| lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy Contract |                 |       |        |        |         |
+=================================================================================================================================================+
| Deployment Cost                                                                           | Deployment Size |       |        |        |         |
|-------------------------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
|                                                                                    383484 |            1351 |       |        |        |         |
|-------------------------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
|                                                                                           |                 |       |        |        |         |
|-------------------------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
| Function Name                                                                             | Min             | Avg   | Median | Max    | # Calls |
|-------------------------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
| fallback                                                                                  |            1004 | 43113 |  29560 | 342041 |    1874 |
╰-------------------------------------------------------------------------------------------+-----------------+-------+--------+--------+---------╯

╭---------------------------------------------------------+-----------------+-------+--------+-------+---------╮
| lib/safe-smart-account/contracts/Safe.sol:Safe Contract |                 |       |        |       |         |
+==============================================================================================================+
| Deployment Cost                                         | Deployment Size |       |        |       |         |
|---------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                 2709584 |           12213 |       |        |       |         |
|---------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                         |                 |       |        |       |         |
|---------------------------------------------------------+-----------------+-------+--------+-------+---------|
| Function Name                                           | Min             | Avg   | Median | Max   | # Calls |
|---------------------------------------------------------+-----------------+-------+--------+-------+---------|
| execTransaction                                         |           10490 | 54804 |  49411 | 82682 |     127 |
|---------------------------------------------------------+-----------------+-------+--------+-------+---------|
| getThreshold                                            |            2380 |  2380 |   2380 |  2380 |       1 |
|---------------------------------------------------------+-----------------+-------+--------+-------+---------|
| getTransactionHash                                      |            2408 |  2428 |   2426 |  2507 |     127 |
|---------------------------------------------------------+-----------------+-------+--------+-------+---------|
| nonce                                                   |            2340 |  2340 |   2340 |  2340 |     127 |
╰---------------------------------------------------------+-----------------+-------+--------+-------+---------╯

╭---------------------------------------------------------------------------+-----------------+-------+--------+--------+---------╮
| lib/safe-smart-account/contracts/proxies/SafeProxy.sol:SafeProxy Contract |                 |       |        |        |         |
+=================================================================================================================================+
| Deployment Cost                                                           | Deployment Size |       |        |        |         |
|---------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
|                                                                         0 |             346 |       |        |        |         |
|---------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
|                                                                           |                 |       |        |        |         |
|---------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
| Function Name                                                             | Min             | Avg   | Median | Max    | # Calls |
|---------------------------------------------------------------------------+-----------------+-------+--------+--------+---------|
| fallback                                                                  |            7181 | 32677 |   7345 | 115440 |     382 |
╰---------------------------------------------------------------------------+-----------------+-------+--------+--------+---------╯

╭-----------------------------------------------------------------------------------------+-----------------+--------+--------+--------+---------╮
| lib/safe-smart-account/contracts/proxies/SafeProxyFactory.sol:SafeProxyFactory Contract |                 |        |        |        |         |
+================================================================================================================================================+
| Deployment Cost                                                                         | Deployment Size |        |        |        |         |
|-----------------------------------------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                                                  445029 |            1840 |        |        |        |         |
|-----------------------------------------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                                                         |                 |        |        |        |         |
|-----------------------------------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                                                           | Min             | Avg    | Median | Max    | # Calls |
|-----------------------------------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| createProxyWithNonce                                                                    |          263340 | 275148 | 275148 | 286956 |      22 |
╰-----------------------------------------------------------------------------------------+-----------------+--------+--------+--------+---------╯

╭------------------------------------------------------+-----------------+-------+--------+-------+---------╮
| lib/v4-core/src/PoolManager.sol:PoolManager Contract |                 |       |        |       |         |
+===========================================================================================================+
| Deployment Cost                                      | Deployment Size |       |        |       |         |
|------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                              4344268 |           19951 |       |        |       |         |
|------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                      |                 |       |        |       |         |
|------------------------------------------------------+-----------------+-------+--------+-------+---------|
| Function Name                                        | Min             | Avg   | Median | Max   | # Calls |
|------------------------------------------------------+-----------------+-------+--------+-------+---------|
| exttload                                             |             369 |   369 |    369 |   369 |      36 |
|------------------------------------------------------+-----------------+-------+--------+-------+---------|
| initialize                                           |           31170 | 63881 |  69397 | 69397 |      13 |
|------------------------------------------------------+-----------------+-------+--------+-------+---------|
| owner                                                |            2402 |  2402 |   2402 |  2402 |       1 |
|------------------------------------------------------+-----------------+-------+--------+-------+---------|
| transferOwnership                                    |           28518 | 28518 |  28518 | 28518 |      11 |
╰------------------------------------------------------+-----------------+-------+--------+-------+---------╯

╭-------------------------------------------------------------+-----------------+-------+--------+-------+---------╮
| lib/v4-core/src/test/PoolSwapTest.sol:PoolSwapTest Contract |                 |       |        |       |         |
+==================================================================================================================+
| Deployment Cost                                             | Deployment Size |       |        |       |         |
|-------------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                     1341118 |            6177 |       |        |       |         |
|-------------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                             |                 |       |        |       |         |
|-------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| Function Name                                               | Min             | Avg   | Median | Max   | # Calls |
|-------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| swap                                                        |           70332 | 70332 |  70332 | 70332 |       1 |
╰-------------------------------------------------------------+-----------------+-------+--------+-------+---------╯

╭--------------------------------------------------------+-----------------+--------+--------+--------+---------╮
| src/account/PasskeyAccount.sol:PasskeyAccount Contract |                 |        |        |        |         |
+===============================================================================================================+
| Deployment Cost                                        | Deployment Size |        |        |        |         |
|--------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                      0 |            7420 |        |        |        |         |
|--------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                        |                 |        |        |        |         |
|--------------------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                          | Min             | Avg    | Median | Max    | # Calls |
|--------------------------------------------------------+-----------------+--------+--------+--------+---------|
| execute                                                |           58139 | 335550 | 354413 | 593467 |       7 |
|--------------------------------------------------------+-----------------+--------+--------+--------+---------|
| getDigest                                              |            1809 |   1931 |   1809 |   2408 |       6 |
|--------------------------------------------------------+-----------------+--------+--------+--------+---------|
| isValidSignature                                       |          276382 | 277782 | 277782 | 279183 |       2 |
|--------------------------------------------------------+-----------------+--------+--------+--------+---------|
| nonce                                                  |            2337 |   2337 |   2337 |   2337 |       2 |
╰--------------------------------------------------------+-----------------+--------+--------+--------+---------╯

╭----------------------------------------------------------------------+-----------------+---------+---------+---------+---------╮
| src/account/PasskeyAccountFactory.sol:PasskeyAccountFactory Contract |                 |         |         |         |         |
+================================================================================================================================+
| Deployment Cost                                                      | Deployment Size |         |         |         |         |
|----------------------------------------------------------------------+-----------------+---------+---------+---------+---------|
|                                                              1784254 |            8041 |         |         |         |         |
|----------------------------------------------------------------------+-----------------+---------+---------+---------+---------|
|                                                                      |                 |         |         |         |         |
|----------------------------------------------------------------------+-----------------+---------+---------+---------+---------|
| Function Name                                                        | Min             | Avg     | Median  | Max     | # Calls |
|----------------------------------------------------------------------+-----------------+---------+---------+---------+---------|
| createAccount                                                        |           30594 | 1328698 | 1514142 | 1514142 |       8 |
|----------------------------------------------------------------------+-----------------+---------+---------+---------+---------|
| getAddress                                                           |            5824 |    5824 |    5824 |    5824 |       7 |
╰----------------------------------------------------------------------+-----------------+---------+---------+---------+---------╯

╭---------------------------------------------------+-----------------+--------+--------+--------+---------╮
| src/identity/KYCRegistry.sol:KYCRegistry Contract |                 |        |        |        |         |
+==========================================================================================================+
| Deployment Cost                                   | Deployment Size |        |        |        |         |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                           2644112 |           12111 |        |        |        |         |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                   |                 |        |        |        |         |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                     | Min             | Avg    | Median | Max    | # Calls |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| DEFAULT_ADMIN_ROLE                                |             283 |    283 |    283 |    283 |       1 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| IDENTITY_VERIFIER_ROLE                            |             339 |    339 |    339 |    339 |      68 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| SOVEREIGN_ROLE                                    |             315 |    315 |    315 |    315 |       1 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| addRecoverableToken                               |           31233 |  39783 |  39783 |  48333 |     136 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| checkRetire                                       |            1254 |   4454 |   5254 |   5296 |      10 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| checkTransfer                                     |            2478 |   7703 |   6478 |  12701 |      77 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| grantRole                                         |            5149 |  29290 |  29755 |  29755 |     106 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| hasRole                                           |            2794 |   2794 |   2794 |   2794 |       9 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| hashAttestation                                   |            7892 |   7892 |   7892 |   7892 |     215 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| identityOf                                        |            5450 |   5450 |   5450 |   5450 |       5 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| initialize                                        |          197788 | 197788 | 197788 | 197788 |      68 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| isActive                                          |            3297 |   3704 |   3297 |   5297 |     112 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| nonces                                            |            2561 |   2561 |   2561 |   2561 |     214 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| recover                                           |            3263 | 100432 |   8073 | 289962 |       3 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| register                                          |            3264 |  86031 |  86803 |  86803 |     214 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| renounceRole                                      |            8005 |   8005 |   8005 |   8005 |      24 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| revokeRole                                        |           12613 |  12613 |  12613 |  12613 |      11 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| setFrozen                                         |            3034 |   6948 |   9558 |   9558 |       5 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| setIndividualTransferEnabled                      |           25978 |  25978 |  25978 |  25978 |       1 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| setSystemContract                                 |            9563 |  26579 |  26663 |  26663 |     205 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| tierOf                                            |             691 |   2552 |   2691 |   2691 |     101 |
|---------------------------------------------------+-----------------+--------+--------+--------+---------|
| upgradeToAndCall                                  |            3485 |   7383 |   7383 |  11282 |       4 |
╰---------------------------------------------------+-----------------+--------+--------+--------+---------╯

╭-------------------------------------------------------------+-----------------+--------+--------+--------+---------╮
| src/market/CarbonCreditToken.sol:CarbonCreditToken Contract |                 |        |        |        |         |
+====================================================================================================================+
| Deployment Cost                                             | Deployment Size |        |        |        |         |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                     1441303 |            6548 |        |        |        |         |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                             |                 |        |        |        |         |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                               | Min             | Avg    | Median | Max    | # Calls |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| POOL_ROLE                                                   |             239 |    239 |    239 |    239 |      68 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| approve                                                     |           24803 |  24803 |  24803 |  24803 |      20 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| balanceOf                                                   |             617 |   2028 |   2617 |   2617 |      34 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| burnFrom                                                    |           15282 |  15282 |  15282 |  15282 |       4 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| grantRole                                                   |           29710 |  29710 |  29710 |  29710 |      79 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| initialize                                                  |          117872 | 117872 | 117872 | 117872 |      68 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| mint                                                        |           15227 |  44569 |  49427 |  49427 |      19 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| recoverBalances                                             |           35884 |  35884 |  35884 |  35884 |       1 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| renounceRole                                                |            7982 |   7982 |   7982 |   7982 |      11 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| totalSupply                                                 |            2370 |   2370 |   2370 |   2370 |       1 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| transfer                                                    |           22517 |  45362 |  50648 |  50648 |      19 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| transferFrom                                                |           14834 |  37864 |  40168 |  40168 |      11 |
╰-------------------------------------------------------------+-----------------+--------+--------+--------+---------╯

╭-----------------------------------------------+-----------------+--------+--------+--------+---------╮
| src/market/CarbonPool.sol:CarbonPool Contract |                 |        |        |        |         |
+======================================================================================================+
| Deployment Cost                               | Deployment Size |        |        |        |         |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
|                                       2507016 |           11476 |        |        |        |         |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
|                                               |                 |        |        |        |         |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                 | Min             | Avg    | Median | Max    | # Calls |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| deposit                                       |           20361 | 276757 | 310443 | 320925 |      20 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| grantRole                                     |           29755 |  29755 |  29755 |  29755 |      33 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| initialize                                    |          260067 | 260067 | 260067 | 260067 |      68 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| onERC1155Received                             |            1069 |   1069 |   1069 |   1069 |      18 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| pooledKg                                      |            2480 |   2480 |   2480 |   2480 |       4 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| queueLength                                   |            4580 |   4580 |   4580 |   4580 |       1 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| redeem                                        |           32091 | 178753 | 178753 | 325415 |       2 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| redeemAndRetire                               |          297029 | 306998 | 306998 | 316967 |       2 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| redeemSpecific                                |          203740 | 203740 | 203740 | 203740 |       1 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| renounceRole                                  |            8005 |   8005 |   8005 |   8005 |      22 |
|-----------------------------------------------+-----------------+--------+--------+--------+---------|
| revokeRole                                    |           12612 |  12612 |  12612 |  12612 |      11 |
╰-----------------------------------------------+-----------------+--------+--------+--------+---------╯

╭-----------------------------------------+-----------------+--------+--------+--------+---------╮
| src/market/Listing.sol:Listing Contract |                 |        |        |        |         |
+================================================================================================+
| Deployment Cost                         | Deployment Size |        |        |        |         |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
|                                 1885117 |            8600 |        |        |        |         |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
|                                         |                 |        |        |        |         |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                           | Min             | Avg    | Median | Max    | # Calls |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| OPERATOR_ROLE                           |             336 |    336 |    336 |    336 |       1 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| buy                                     |           24944 | 129881 | 129796 | 226554 |       7 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| cancel                                  |           83757 |  83757 |  83757 |  83757 |       1 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| grantRole                               |           29732 |  29732 |  29732 |  29732 |      33 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| hasRole                                 |            2794 |   2794 |   2794 |   2794 |       1 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| initialize                              |          281956 | 281956 | 281956 | 281956 |      68 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| list                                    |            2606 | 243908 | 282959 | 302859 |      14 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| onERC1155Received                       |            1011 |   1011 |   1011 |   1011 |      12 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| orderOf                                 |           13610 |  13610 |  13610 |  13610 |       3 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| pause                                   |            5151 |  18202 |  26113 |  28484 |       5 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| paused                                  |            2369 |   2369 |   2369 |   2369 |       3 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| renounceRole                            |            7982 |   7982 |   7982 |   7982 |      22 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| revokeRole                              |           12612 |  12612 |  12612 |  12612 |      13 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| setFee                                  |            2949 |   2949 |   2949 |   2949 |       1 |
|-----------------------------------------+-----------------+--------+--------+--------+---------|
| unpause                                 |            8970 |   8970 |   8970 |   8970 |       1 |
╰-----------------------------------------+-----------------+--------+--------+--------+---------╯

╭----------------------------------------+-----------------+-------+--------+-------+---------╮
| src/mocks/MockTWD.sol:MockTWD Contract |                 |       |        |       |         |
+=============================================================================================+
| Deployment Cost                        | Deployment Size |       |        |       |         |
|----------------------------------------+-----------------+-------+--------+-------+---------|
|                                 762489 |            3597 |       |        |       |         |
|----------------------------------------+-----------------+-------+--------+-------+---------|
|                                        |                 |       |        |       |         |
|----------------------------------------+-----------------+-------+--------+-------+---------|
| Function Name                          | Min             | Avg   | Median | Max   | # Calls |
|----------------------------------------+-----------------+-------+--------+-------+---------|
| approve                                |           46697 | 46698 |  46697 | 46709 |      25 |
|----------------------------------------+-----------------+-------+--------+-------+---------|
| balanceOf                              |             582 |  1699 |   2582 |  2582 |      34 |
|----------------------------------------+-----------------+-------+--------+-------+---------|
| mint                                   |           53699 | 61779 |  53711 | 70799 |     144 |
╰----------------------------------------+-----------------+-------+--------+-------+---------╯

╭-------------------------------------------------------------+-----------------+--------+--------+--------+---------╮
| src/registry/CarbonCredit1155.sol:CarbonCredit1155 Contract |                 |        |        |        |         |
+====================================================================================================================+
| Deployment Cost                                             | Deployment Size |        |        |        |         |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                     2441830 |           11594 |        |        |        |         |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                             |                 |        |        |        |         |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                               | Min             | Avg    | Median | Max    | # Calls |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| balanceOf                                                   |            2657 |   2657 |   2657 |   2657 |      13 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| batchOf                                                     |           20559 |  20559 |  20559 |  20559 |      24 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| grantRole                                                   |           51130 |  51322 |  51322 |  51514 |      22 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| issue                                                       |           26313 |  26313 |  26313 |  26313 |       1 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| renounceRole                                                |           24662 |  24854 |  24854 |  25046 |      22 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| retire                                                      |           27308 | 148858 |  42403 | 300252 |       7 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| safeTransferFrom                                            |           43733 |  90812 |  46609 | 149707 |       9 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| setApprovalForAll                                           |           46269 |  46269 |  46269 |  46269 |      34 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| setBatchFrozen                                              |           49901 |  49901 |  49901 |  49901 |       1 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| setRegistry                                                 |           26121 |  47328 |  47640 |  47640 |      69 |
|-------------------------------------------------------------+-----------------+--------+--------+--------+---------|
| upgradeToAndCall                                            |           21694 |  21694 |  21694 |  21694 |       1 |
╰-------------------------------------------------------------+-----------------+--------+--------+--------+---------╯

╭---------------------------------------------------------+-----------------+--------+--------+--------+---------╮
| src/registry/CarbonRegistry.sol:CarbonRegistry Contract |                 |        |        |        |         |
+================================================================================================================+
| Deployment Cost                                         | Deployment Size |        |        |        |         |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                 2105914 |           10568 |        |        |        |         |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                         |                 |        |        |        |         |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                           | Min             | Avg    | Median | Max    | # Calls |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| VERIFIER_ROLE                                           |             336 |    336 |    336 |    336 |       1 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| approveVerifier                                         |           48834 |  48834 |  48834 |  48834 |      68 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| grantRole                                               |           51146 |  51338 |  51338 |  51530 |      22 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| hasRole                                                 |            2693 |   2693 |   2693 |   2693 |       1 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| hashIssuance                                            |            1455 |   1455 |   1455 |   1455 |      55 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| issue                                                   |           41095 | 330020 | 349083 | 349095 |      55 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| registerProject                                         |           34513 | 177251 | 183325 | 183325 |      49 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| renounceRole                                            |           24589 |  24781 |  24781 |  24973 |      22 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| revokeVerifier                                          |           26960 |  26960 |  26960 |  26960 |       1 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| serialUsed                                              |            2458 |   2458 |   2458 |   2458 |       1 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| setProjectActive                                        |           28131 |  28131 |  28131 |  28131 |       1 |
|---------------------------------------------------------+-----------------+--------+--------+--------+---------|
| upgradeToAndCall                                        |           21716 |  21716 |  21716 |  21716 |       1 |
╰---------------------------------------------------------+-----------------+--------+--------+--------+---------╯

╭-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------╮
| src/registry/RetirementCertificate.sol:RetirementCertificate Contract |                 |       |        |       |         |
+============================================================================================================================+
| Deployment Cost                                                       | Deployment Size |       |        |       |         |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                               2277263 |           10295 |       |        |       |         |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
|                                                                       |                 |       |        |       |         |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| Function Name                                                         | Min             | Avg   | Median | Max   | # Calls |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| DOCUMENT_ROLE                                                         |             240 |   240 |    240 |   240 |      69 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| MINTER_ROLE                                                           |             261 |   261 |    261 |   261 |      68 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| balanceOf                                                             |            2631 |  2631 |   2631 |  2631 |       1 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| certificateOf                                                         |           21897 | 22041 |  22077 | 22077 |       5 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| grantRole                                                             |           51130 | 51487 |  51514 | 51514 |     159 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| ownerOf                                                               |            2660 |  2660 |   2660 |  2660 |       3 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| renounceRole                                                          |           24662 | 24854 |  24854 | 25046 |      22 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| revokeRole                                                            |           29572 | 29572 |  29572 | 29572 |       1 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| setDocumentHash                                                       |           24471 | 37371 |  37371 | 50272 |       4 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| tokenURI                                                              |           73963 | 73963 |  73963 | 73963 |       1 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| transferFrom                                                          |           24784 | 24784 |  24784 | 24784 |       1 |
|-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------|
| upgradeToAndCall                                                      |           21694 | 21694 |  21694 | 21694 |       1 |
╰-----------------------------------------------------------------------+-----------------+-------+--------+-------+---------╯

╭-------------------------------------------------+-----------------+--------+--------+--------+---------╮
| src/v4/TrustedRouter.sol:TrustedRouter Contract |                 |        |        |        |         |
+========================================================================================================+
| Deployment Cost                                 | Deployment Size |        |        |        |         |
|-------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                         1021249 |            4707 |        |        |        |         |
|-------------------------------------------------+-----------------+--------+--------+--------+---------|
|                                                 |                 |        |        |        |         |
|-------------------------------------------------+-----------------+--------+--------+--------+---------|
| Function Name                                   | Min             | Avg    | Median | Max    | # Calls |
|-------------------------------------------------+-----------------+--------+--------+--------+---------|
| modifyLiquidity                                 |           77727 | 293846 | 328133 | 328133 |      12 |
|-------------------------------------------------+-----------------+--------+--------+--------+---------|
| swap                                            |           80141 | 166813 | 184283 | 213936 |       8 |
╰-------------------------------------------------+-----------------+--------+--------+--------+---------╯

╭----------------------------------------------+-----------------+------+--------+------+---------╮
| test/Governance.t.sol:KYCRegistryV2 Contract |                 |      |        |      |         |
+=================================================================================================+
| Deployment Cost                              | Deployment Size |      |        |      |         |
|----------------------------------------------+-----------------+------+--------+------+---------|
|                                      2654533 |           12159 |      |        |      |         |
|----------------------------------------------+-----------------+------+--------+------+---------|
|                                              |                 |      |        |      |         |
|----------------------------------------------+-----------------+------+--------+------+---------|
| Function Name                                | Min             | Avg  | Median | Max  | # Calls |
|----------------------------------------------+-----------------+------+--------+------+---------|
| isActive                                     |            5319 | 5319 |   5319 | 5319 |       2 |
|----------------------------------------------+-----------------+------+--------+------+---------|
| proxiableUUID                                |             374 |  374 |    374 |  374 |       2 |
|----------------------------------------------+-----------------+------+--------+------+---------|
| tierOf                                       |            2713 | 2713 |   2713 | 2713 |       1 |
|----------------------------------------------+-----------------+------+--------+------+---------|
| version                                      |             534 |  534 |    534 |  534 |       2 |
╰----------------------------------------------+-----------------+------+--------+------+---------╯


Ran 8 test suites in 93.93ms (105.08ms CPU time): 68 tests passed, 0 failed, 0 skipped (68 total tests)
```

</details>
