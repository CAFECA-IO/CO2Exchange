'forge clean' running (wd: /home/claude/CO2Exchange)
'forge config --json' running
'forge build --build-info --deny never --skip ./test/** ./script/** --force' running (wd: /home/claude/CO2Exchange)
**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [arbitrary-send-erc20](#arbitrary-send-erc20) (1 results) (High)
 - [arbitrary-send-eth](#arbitrary-send-eth) (1 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (4 results) (Medium)
 - [reentrancy-no-eth](#reentrancy-no-eth) (2 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (2 results) (Medium)
 - [unused-return](#unused-return) (4 results) (Medium)
 - [missing-zero-check](#missing-zero-check) (1 results) (Low)
 - [calls-loop](#calls-loop) (4 results) (Low)
 - [reentrancy-events](#reentrancy-events) (3 results) (Low)
 - [timestamp](#timestamp) (7 results) (Low)
 - [low-level-calls](#low-level-calls) (1 results) (Informational)
 - [too-many-digits](#too-many-digits) (2 results) (Informational)
 - [unindexed-event-address](#unindexed-event-address) (2 results) (Informational)
## arbitrary-send-erc20
Impact: High
Confidence: High
 - [ ] ID-0
[TrustedRouter._settle(Currency,address)](.src/v4/TrustedRouter.sol#L101-L110) uses arbitrary from in transferFrom: [IERC20(Currency.unwrap(currency)).safeTransferFrom(user,address(poolManager),uint256(- delta))](.src/v4/TrustedRouter.sol#L105)

.src/v4/TrustedRouter.sol#L101-L110


## arbitrary-send-eth
Impact: High
Confidence: Medium
 - [ ] ID-1
[PasskeyAccount.execute(PasskeyAccount.Call[],bytes)](.src/account/PasskeyAccount.sol#L48-L58) sends eth to arbitrary user
	Dangerous calls:
	- [(ok,ret) = calls[i].target.call{value: calls[i].value}(calls[i].data)](.src/account/PasskeyAccount.sol#L54)

.src/account/PasskeyAccount.sol#L48-L58


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-2
[CarbonRegistry._yearOf(uint64)](.src/registry/CarbonRegistry.sol#L185-L196) performs a multiplication on the result of a division:
	- [doe = z - era * 146097](.src/registry/CarbonRegistry.sol#L188)
	- [era = z - 146096 / 146097](.src/registry/CarbonRegistry.sol#L187)

.src/registry/CarbonRegistry.sol#L185-L196


 - [ ] ID-3
[CarbonRegistry._yearOf(uint64)](.src/registry/CarbonRegistry.sol#L185-L196) performs a multiplication on the result of a division:
	- [y = yoe + era * 400](.src/registry/CarbonRegistry.sol#L190)
	- [era = z - 146096 / 146097](.src/registry/CarbonRegistry.sol#L187)

.src/registry/CarbonRegistry.sol#L185-L196


 - [ ] ID-4
[Listing.buy(uint256,uint256)](.src/market/Listing.sol#L159-L178) performs a multiplication on the result of a division:
	- [cost = amountKg * o.pricePerTonne / KG_PER_TONNE](.src/market/Listing.sol#L167)
	- [fee = cost * feeBps / 10_000](.src/market/Listing.sol#L168)

.src/market/Listing.sol#L159-L178


 - [ ] ID-5
[CarbonRegistry._yearOf(uint64)](.src/registry/CarbonRegistry.sol#L185-L196) performs a multiplication on the result of a division:
	- [yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365](.src/registry/CarbonRegistry.sol#L189)
	- [doy = doe - (365 * yoe + yoe / 4 - yoe / 100)](.src/registry/CarbonRegistry.sol#L191)

.src/registry/CarbonRegistry.sol#L185-L196


## reentrancy-no-eth
Impact: Medium
Confidence: Medium
 - [ ] ID-6
Reentrancy in [TrustedRouter.modifyLiquidity(PoolKey,IPoolManager.ModifyLiquidityParams,uint256)](.src/v4/TrustedRouter.sol#L68-L81):
	External calls:
	- [delta = abi.decode(poolManager.unlock(abi.encode(CallbackData(Action.ModifyLiquidity,msg.sender,key,empty,params))),(BalanceDelta))](.src/v4/TrustedRouter.sol#L76-L79)
	State variables written after the call(s):
	- [_currentUser = address(0)](.src/v4/TrustedRouter.sol#L80)
	[TrustedRouter._currentUser](.src/v4/TrustedRouter.sol#L23) can be used in cross function reentrancies:
	- [TrustedRouter.modifyLiquidity(PoolKey,IPoolManager.ModifyLiquidityParams,uint256)](.src/v4/TrustedRouter.sol#L68-L81)
	- [TrustedRouter.swap(PoolKey,IPoolManager.SwapParams,uint256,uint256)](.src/v4/TrustedRouter.sol#L49-L66)
	- [TrustedRouter.unlockCallback(bytes)](.src/v4/TrustedRouter.sol#L83-L99)

.src/v4/TrustedRouter.sol#L68-L81


 - [ ] ID-7
Reentrancy in [TrustedRouter.swap(PoolKey,IPoolManager.SwapParams,uint256,uint256)](.src/v4/TrustedRouter.sol#L49-L66):
	External calls:
	- [delta = abi.decode(poolManager.unlock(abi.encode(CallbackData(Action.Swap,msg.sender,key,params,empty))),(BalanceDelta))](.src/v4/TrustedRouter.sol#L57-L59)
	State variables written after the call(s):
	- [_currentUser = address(0)](.src/v4/TrustedRouter.sol#L60)
	[TrustedRouter._currentUser](.src/v4/TrustedRouter.sol#L23) can be used in cross function reentrancies:
	- [TrustedRouter.modifyLiquidity(PoolKey,IPoolManager.ModifyLiquidityParams,uint256)](.src/v4/TrustedRouter.sol#L68-L81)
	- [TrustedRouter.swap(PoolKey,IPoolManager.SwapParams,uint256,uint256)](.src/v4/TrustedRouter.sol#L49-L66)
	- [TrustedRouter.unlockCallback(bytes)](.src/v4/TrustedRouter.sol#L83-L99)

.src/v4/TrustedRouter.sol#L49-L66


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-8
[TrustedRouter.modifyLiquidity(PoolKey,IPoolManager.ModifyLiquidityParams,uint256).empty](.src/v4/TrustedRouter.sol#L75) is a local variable never initialized

.src/v4/TrustedRouter.sol#L75


 - [ ] ID-9
[TrustedRouter.swap(PoolKey,IPoolManager.SwapParams,uint256,uint256).empty](.src/v4/TrustedRouter.sol#L56) is a local variable never initialized

.src/v4/TrustedRouter.sol#L56


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-10
[CarbonCredit1155._update(address,address,uint256[],uint256[])](.src/registry/CarbonCredit1155.sol#L186-L198) ignores return value by [_held[from].remove(ids[i_scope_0])](.src/registry/CarbonCredit1155.sol#L195)

.src/registry/CarbonCredit1155.sol#L186-L198


 - [ ] ID-11
[CarbonCredit1155._update(address,address,uint256[],uint256[])](.src/registry/CarbonCredit1155.sol#L186-L198) ignores return value by [_held[to].add(ids[i_scope_0])](.src/registry/CarbonCredit1155.sol#L196)

.src/registry/CarbonCredit1155.sol#L186-L198


 - [ ] ID-12
[TrustedRouter._settle(Currency,address)](.src/v4/TrustedRouter.sol#L101-L110) ignores return value by [poolManager.settle()](.src/v4/TrustedRouter.sol#L106)

.src/v4/TrustedRouter.sol#L101-L110


 - [ ] ID-13
[TrustedRouter.unlockCallback(bytes)](.src/v4/TrustedRouter.sol#L83-L99) ignores return value by [(delta,None) = poolManager.modifyLiquidity(d.key,d.liquidityParams,hookData)](.src/v4/TrustedRouter.sol#L93)

.src/v4/TrustedRouter.sol#L83-L99


## missing-zero-check
Impact: Low
Confidence: Medium
 - [ ] ID-14
[CarbonKYCHook.setTrustedRouter(address).router](.src/v4/CarbonKYCHook.sol#L90) lacks a zero-check on :
		- [trustedRouter = router](.src/v4/CarbonKYCHook.sol#L91)

.src/v4/CarbonKYCHook.sol#L90


## calls-loop
Impact: Low
Confidence: Medium
 - [ ] ID-15
[CarbonPool.redeem(uint256)](.src/market/CarbonPool.sol#L139-L153) has external calls inside a loop: [credit.safeTransferFrom(address(this),msg.sender,ids[i],amounts[i],)](.src/market/CarbonPool.sol#L150)

.src/market/CarbonPool.sol#L139-L153


 - [ ] ID-16
[KYCRegistry.recover(address,KYCRegistry.IdentityAttestation,bytes)](.src/identity/KYCRegistry.sol#L138-L162) has external calls inside a loop: [IRecoverable(recoverableTokens[i]).recoverBalances(oldAccount,a.account)](.src/identity/KYCRegistry.sol#L159)

.src/identity/KYCRegistry.sol#L138-L162


 - [ ] ID-17
[CarbonPool.redeemAndRetire(uint256,bytes32,string,RetirementCertificate.Purpose,string)](.src/market/CarbonPool.sol#L171-L198) has external calls inside a loop: [certIds[i] = credit.retire(CarbonCredit1155.RetireRequest({holder:address(this),batchId:ids[i],amountKg:amounts[i],certificateTo:msg.sender,beneficiaryHash:beneficiaryHash,beneficiary:beneficiary,purpose:purpose,memo:memo}))](.src/market/CarbonPool.sol#L184-L195)

.src/market/CarbonPool.sol#L171-L198


 - [ ] ID-18
[PasskeyAccount.execute(PasskeyAccount.Call[],bytes)](.src/account/PasskeyAccount.sol#L48-L58) has external calls inside a loop: [(ok,ret) = calls[i].target.call{value: calls[i].value}(calls[i].data)](.src/account/PasskeyAccount.sol#L54)

.src/account/PasskeyAccount.sol#L48-L58


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-19
Reentrancy in [KYCRegistry.recover(address,KYCRegistry.IdentityAttestation,bytes)](.src/identity/KYCRegistry.sol#L138-L162):
	External calls:
	- [IRecoverable(recoverableTokens[i]).recoverBalances(oldAccount,a.account)](.src/identity/KYCRegistry.sol#L159)
	Event emitted after the call(s):
	- [Recovered(oldAccount,a.account,a.identityHash)](.src/identity/KYCRegistry.sol#L161)

.src/identity/KYCRegistry.sol#L138-L162


 - [ ] ID-20
Reentrancy in [CarbonRegistry.issue(CarbonRegistry.IssuanceAttestation,bytes)](.src/registry/CarbonRegistry.sol#L128-L160):
	External calls:
	- [batchId = credit.issue(p.owner,CarbonCredit1155.Batch({projectId:a.projectId,monitoringStart:a.monitoringStart,monitoringEnd:a.monitoringEnd,vintageYear:_yearOf(a.monitoringEnd),serialHash:a.serialHash,reportHash:a.reportHash,verifier:verifier,issuedAt:0,issuedKg:a.amountKg,retiredKg:0,frozen:false}))](.src/registry/CarbonRegistry.sol#L143-L158)
	Event emitted after the call(s):
	- [CreditsIssued(a.projectId,batchId,verifier,a.amountKg,a.serialHash,a.reportHash)](.src/registry/CarbonRegistry.sol#L159)

.src/registry/CarbonRegistry.sol#L128-L160


 - [ ] ID-21
Reentrancy in [PasskeyAccount.execute(PasskeyAccount.Call[],bytes)](.src/account/PasskeyAccount.sol#L48-L58):
	External calls:
	- [(ok,ret) = calls[i].target.call{value: calls[i].value}(calls[i].data)](.src/account/PasskeyAccount.sol#L54)
	Event emitted after the call(s):
	- [Executed(n,calls.length)](.src/account/PasskeyAccount.sol#L57)

.src/account/PasskeyAccount.sol#L48-L58


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-22
[CarbonRegistry.issue(CarbonRegistry.IssuanceAttestation,bytes)](.src/registry/CarbonRegistry.sol#L128-L160) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > a.deadline](.src/registry/CarbonRegistry.sol#L132)

.src/registry/CarbonRegistry.sol#L128-L160


 - [ ] ID-23
[TrustedRouter.modifyLiquidity(PoolKey,IPoolManager.ModifyLiquidityParams,uint256)](.src/v4/TrustedRouter.sol#L68-L81) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > deadline](.src/v4/TrustedRouter.sol#L72)

.src/v4/TrustedRouter.sol#L68-L81


 - [ ] ID-24
[TrustedRouter.swap(PoolKey,IPoolManager.SwapParams,uint256,uint256)](.src/v4/TrustedRouter.sol#L49-L66) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > deadline](.src/v4/TrustedRouter.sol#L53)

.src/v4/TrustedRouter.sol#L49-L66


 - [ ] ID-25
[KYCRegistry.recover(address,KYCRegistry.IdentityAttestation,bytes)](.src/identity/KYCRegistry.sol#L138-L162) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > a.deadline](.src/identity/KYCRegistry.sol#L145)

.src/identity/KYCRegistry.sol#L138-L162


 - [ ] ID-26
[KYCRegistry.register(KYCRegistry.IdentityAttestation,bytes)](.src/identity/KYCRegistry.sol#L86-L103) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp > a.deadline](.src/identity/KYCRegistry.sol#L88)

.src/identity/KYCRegistry.sol#L86-L103


 - [ ] ID-27
[KYCRegistry._active(IKYCRegistry.Identity)](.src/identity/KYCRegistry.sol#L223-L227) uses timestamp for comparisons
	Dangerous comparisons:
	- [id.expiry > block.timestamp](.src/identity/KYCRegistry.sol#L226)

.src/identity/KYCRegistry.sol#L223-L227


 - [ ] ID-28
[KYCRegistry.isActive(address)](.src/identity/KYCRegistry.sol#L178-L183) uses timestamp for comparisons
	Dangerous comparisons:
	- [id.expiry > block.timestamp](.src/identity/KYCRegistry.sol#L182)

.src/identity/KYCRegistry.sol#L178-L183


## low-level-calls
Impact: Informational
Confidence: High
 - [ ] ID-29
Low level call in [PasskeyAccount.execute(PasskeyAccount.Call[],bytes)](.src/account/PasskeyAccount.sol#L48-L58):
	- [(ok,ret) = calls[i].target.call{value: calls[i].value}(calls[i].data)](.src/account/PasskeyAccount.sol#L54)

.src/account/PasskeyAccount.sol#L48-L58


## too-many-digits
Impact: Informational
Confidence: Medium
 - [ ] ID-30
[WebAuthn.slitherConstructorConstantVariables()](.src/account/WebAuthn.sol#L11-L63) uses literals with too many digits:
	- [P256_N_DIV_2 = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8](.src/account/WebAuthn.sol#L23)

.src/account/WebAuthn.sol#L11-L63


 - [ ] ID-31
[PasskeyAccountFactory.getAddress(bytes32,bytes32)](.src/account/PasskeyAccountFactory.sol#L18-L22) uses literals with too many digits:
	- [Create2.computeAddress(_salt(qx,qy),keccak256(bytes)(abi.encodePacked(type()(PasskeyAccount).creationCode,abi.encode(qx,qy))))](.src/account/PasskeyAccountFactory.sol#L19-L21)

.src/account/PasskeyAccountFactory.sol#L18-L22


## unindexed-event-address
Impact: Informational
Confidence: High
 - [ ] ID-32
Event [Listing.FeeUpdated(uint256,address)](.src/market/Listing.sol#L66) has address parameters but no indexed parameters

.src/market/Listing.sol#L66


 - [ ] ID-33
Event [CarbonPool.FeeUpdated(uint256,address)](.src/market/CarbonPool.sol#L50) has address parameters but no indexed parameters

.src/market/CarbonPool.sol#L50


