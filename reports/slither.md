**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [incorrect-equality](#incorrect-equality) (3 results) (Medium)
 - [timestamp](#timestamp) (4 results) (Low)
## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-0
[Ledger.escapeActive()](src/ledger/Ledger.sol#L229-L233) uses a dangerous strict equality:
	- [at == 0](src/ledger/Ledger.sol#L231)

src/ledger/Ledger.sol#L229-L233


 - [ ] ID-1
[Ledger.escapeIn()](src/ledger/Ledger.sol#L235-L240) uses a dangerous strict equality:
	- [at == 0](src/ledger/Ledger.sol#L237)

src/ledger/Ledger.sol#L235-L240


 - [ ] ID-2
[Ledger.withdrawCash(uint256,Ledger.BalanceProof)](src/ledger/Ledger.sol#L263-L288) uses a dangerous strict equality:
	- [pay == 0](src/ledger/Ledger.sol#L284)

src/ledger/Ledger.sol#L263-L288


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-3
[Ledger.escapeIn()](src/ledger/Ledger.sol#L235-L240) uses timestamp for comparisons
	Dangerous comparisons:
	- [at == 0](src/ledger/Ledger.sol#L237)
	- [block.timestamp >= t](src/ledger/Ledger.sol#L239)

src/ledger/Ledger.sol#L235-L240


 - [ ] ID-4
[Ledger.claimCredits(uint256,Ledger.BalanceProof,Ledger.CreditProof)](src/ledger/Ledger.sol#L319-L337) uses timestamp for comparisons
	Dangerous comparisons:
	- [! withdrawalsEnabled && ! escape](src/ledger/Ledger.sol#L321)
	- [root != _commitments[p.proofEpoch].registryRoot](src/ledger/Ledger.sol#L331)

src/ledger/Ledger.sol#L319-L337


 - [ ] ID-5
[Ledger.withdrawCash(uint256,Ledger.BalanceProof)](src/ledger/Ledger.sol#L263-L288) uses timestamp for comparisons
	Dangerous comparisons:
	- [! withdrawalsEnabled && ! escape](src/ledger/Ledger.sol#L265)

src/ledger/Ledger.sol#L263-L288


 - [ ] ID-6
[Ledger.escapeActive()](src/ledger/Ledger.sol#L229-L233) uses timestamp for comparisons
	Dangerous comparisons:
	- [at == 0](src/ledger/Ledger.sol#L231)
	- [block.timestamp > uint256(at) + ESCAPE_AFTER](src/ledger/Ledger.sol#L232)

src/ledger/Ledger.sol#L229-L233


