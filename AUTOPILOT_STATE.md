# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 10 — pump runout/service-factor clamping, backlog #3 resolved)
Gate policy: `npm run build` + `npx tsc --noEmit` must be clean; suites:
`npm test` (sim), `npm run test:ui` (= static ui-tests + ui-interaction-tests),
`npm run test:eng`.

## ⭐ MISSION DIRECTIVE (user, 2026-08-26)
`MISSION_REDESIGN.md` (repo root) is the authoritative roadmap: full
architectural redesign into a wastewater-engineering tycoon / process-design
simulator. Work it TOP-DOWN:
1. ✅ Legacy backlog #1 cleared in iter 1.
2. Section A bug fixes: A1 terrain decals ✅, A2 tool invariant ✅, A3 permit
   single-source verification ✅, A4 CI gating ✅, A5 UI interaction tests ✅
   (landed iter 2), A6 PFD branching ✅, A7 junk cleanup ✅.
3. Then §AK PHASE 1 vertical slice: AUDIT each of the 17 items against the
   actual code, finish/strengthen what is partial, one coherent slice per
   iteration, tests per §AM.
4. After Phase 1 stabilizes: migrate MBR/RO/A2O/DAF/sludge/disinfection.
Never regress §AL. Respect §AI performance limits. User grants freedom on
front-end and back-end improvements beyond the mission after Phase 1.

## Iteration log
- iter 10 (2026-08-26): Pump runout/service-factor clamping in findPumpDutyPoint
  (backlog #3). The analytic curve/system intersection could return fantasy flows
  on easy systems (e.g. 934 m³/h from a 400 m³/h BEP pump). Now capped at the
  published curve end: PumpModel.runoutFlowM3h (optional, default 1.25 × rated),
  speed-scaled under affinity laws (s·runout for VFD); clamped point reports
  reason 'clamped_at_runout' + atRunout flag, head = pump-curve value at the cap
  (surplus absorbed by throttling). DesignValidator emits pump_at_runout warning
  (rendered live in UnitDesigner via existing validateUnitDesign path). Removed
  dead k/void-k cruft in the solver. 7 new PUMP eng tests (199→206).
  Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui 96/96 ✅ eng 206/206 ✅.
- iter 9 (2026-08-26): Fix SLR unit mismatch in clarifier physics causing economy collapse (backlog #1).
  Root cause: evaluateClarifierLoad() compared SLR in kg/m²·d against Metcalf&Eddy 6 kg/m²·h threshold — 
  every realistic clarifier looked 24× overloaded → blanket pegged 0.95 → escape TSS 29 mg/L → 
  turbidity 23.2 NTU (vs 15 permit) + COD 101 mg/L (vs 90) → $1,700/d fines → steady-state profit −$650/d.
  Fixed: compute slrKgM2Hour = slrKgM2Day/24; overload checks use hourly threshold. UnitDesigner UI threshold
  updated from >6 to >144 kg/m²·d. Secondary clarifier now escapes 5 mg/L TSS, 4 NTU turbidity, 
  compliance 100%, fines $0, steady-state profit +$1k/d. All 5 previously-failing sim tests (S, Z2, Z5, Z6, Z8) pass.
  Gates: build ✅ tsc ✅ sim ✅ ui 96/96 ✅ eng 199/199 ✅.
- iter 8 (2026-08-27): Engineering warnings phase 2 (§AK item 15 / §AM list).
  DesignValidator now does REAL pump-station auditing — evaluatePumpStation-
  Design() intersects the pump curve with static lift + nominal discharge
  friction to flag no_duty_point (critical) / pump_undersized (critical) /
  pump_far_from_bep (info); NPSH available = atmosphere + sump submergence −
  vapor − suction losses vs catalog npshRequiredM → npsh_insufficient
  (critical) / npsh_margin_thin (warning); redundancy policy → no_standby_pump
  (warning), partial_capacity_no_standby (info), no_margin_one_down (warning).
  Replaced the old static "verify duty point" info stub. NEW generic civil
  sanity validateStructuralGeometry() runs on EVERY blueprint (wired into
  validateUnitDesign → renders live in UnitDesigner): impossible dimensions,
  thin walls/floor vs head, insufficient freeboard (<0.3 m any basin),
  extreme aspect ratio / diameter bounds, over-built walls, train count.
  Template defaults stay clean except the honest single-pump standby note.
  15 new WARN regression tests (eng 199/199). SIM HARNESS FIX: Test S Stage B
  waited a fixed 300 ticks then dereferenced an unaffordable UV placement —
  HEAD CRASHED there today (exit 1, TypeError null instanceId); now waits
  bounded (≤1200 ticks) for earned revenue and fails honestly if still poor.
  DISCOVERY: the 5 remaining sim failures (S/Z2/Z5/Z6/Z8 — Level-1 completion
  economy, e.g. −$645/d steady-state profit keeping objectives unlatched) are
  PRE-EXISTING at HEAD and import-isolated from this slice; they surfaced as
  visible FAILs only because the crash is gone. Gates: build ✅ tsc ✅
  eng 199/199 ✅ ui 70/70 + interaction 26/26 ✅ sim ❌ 5 (see backlog #1).
- iter 7 (2026-08-27): Clarifier outlet quality propagation fixed: calculateUnitProcess in UnitProcessModels.ts now uses engineered geometry (SOR/SLR/blanket) instead of unconditionally overwriting with legacy qForward/144 ladder; legacy ladder preserved only for blueprint-less saves (backward compat). SimulationEngine.ts now stores sludgeBlanketHeightPercent as real percent (×100) instead of raw fraction, so readers (UnitDesigner, process models) divide by 100 consistently. 6 new CLARW regression tests added to eng-tests.ts — all 184 pass. Clarifier physics now correctly discriminates undersized vs oversized tanks (Ø30 → 5 mg/L @ 22% blanket; Ø8 → 54 mg/L @ 95% blanket). Note: npm test sim Test S financials shift slightly due to corrected blanket dynamics; test reflects new correct behavior per §AK item 6.
- iter 5 (2026-08-26): Seed-sludge haul-in economics (backlog #1). NEW pure
  pricing `estimateSeedSludgeCAPEX(volume)` in CostEstimator (35% fill × $90/m³
  tanker price, $2,500 mobilization floor; default CAS basin ≈1728 m³ → ~$54k).
  NEW domain-layer `GameManager.setUnitCommissioning`: every unseeded→seeded
  transition buys a fresh truckload (charged once, no refund going unseeded,
  insufficient funds reject atomically, sandbox free) — closes the free
  instant-biomass toggle loophole while placement stays contractor-seeded at
  exactly def.capex (§AL guard test added). UnitDesigner checkbox shows the
  live quote and disables seeding when unaffordable (new `playerCash` prop);
  App routes through GameManager with purchase/rejection toasts. Build ✅
  tsc ✅ sim ✅ ui 67/67 + interaction 22/22 ✅ eng 169/169 (13 new SEED) ✅.
- iter 4 (2026-08-26): Dynamic municipal influent diurnal curve (Mission §AK
  Phase-1 item 14). Deterministic raised-cosine flow factor (trough 0.53× @04:30,
  morning peak 1.44× @10:00, evening bump 1.20× @20:00, 24-h mean = 1). Load
  damping 0.55 → night sewage stronger, peak slightly diluted. Gated by
  `state.diurnalInfluentStrength` (default 0.4 for legacy template trains;
  raise to 1.0 after peak-flow equipment sizing — items 5/6). New module
  `src/sim/InfluentProfile.ts`; wired in `GameManager.tick`; 16 INFLUENT
  regression tests added to `eng-tests.ts` (total 156 eng-tests). Build ✅
  tsc ✅ sim ✅ ui 67/67 + interaction 22/22 ✅ eng 156/156 ✅. §AL no regression.
- iter 3 (2026-08-26): PFD rendering — removed fake linear chain; replaced with real downstream splitters. Build ✅ tsc ✅ sim ✅ ui 67/67 + interaction 22/22 ✅ eng 47/47 ✅. A7: no _probe-ui.tsx present in conflict-copies-20260825; archives retained.
  - Unit Designer seed-sludge toggle (backlog #2): CAS units show an
    "Unseeded / Seed sludge" checkbox. Correctly lives on PlacedUnit's RUNTIME
    `commissioning` state via new optional prop `onUpdateCommissioning`
    (wired in App.tsx) — NOT the blueprint (UnitBlueprint has no commissioning
    field; GameManager seeds `seededWithSludge:true` at placement).
    Labels describe only real mechanics (no fake cost claims yet).
  - Mission A5: `scripts/ui-interaction-tests.tsx` — happy-dom + React 19
    real-mount interaction tests (toolbar tool switching, inspector close /
    demolish, slider wiring, port picker select/cancel/disable). Chained into
    `npm run test:ui`. happy-dom added to devDependencies.
  - Repaired the crashed edit: missing `}` closing a JSX comment in
    UnitDesigner.tsx (parse errors), missing import, dead vars,
    `unit.processType` → correct `unit.typeId` discriminator.
  - Test-env discovery (probes in junk/autopilot-20260826/): dispatched
    input/change events NEVER reach React's ChangeEventPlugin under
    happy-dom+React19 (clicks delegate fine). Controlled-input assertions use
    the fiber's real `memoizedProps.onChange` instead. Do NOT retry the
    native-setter/_valueTracker recipe here.
  Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui 67/67 + interaction 22/22 ✅
  eng 47/47 ✅.
- iter 2 (2026-08-26): LANDED the crashed run's WIP + finished it.
- iter 1 (2026-08-26): CLEARED backlog #1 — all 4 eng-test failures fixed,
  suite 47/47 (was 42/46). EQ analytic-CSTR + min-pool physics, PIPE test
  typo, PUMP wire-to-water envelope, PERMIT exact-survivor assertion.
- iter 0 (2026-08-26): LANDED pending foundation set (engineered-unit
  architecture, blueprints+geometry, hydraulics, processes, UnitDesigner UI,
  PermitEngine single-source compliance, eng-tests suite) + seeded-commissioning
  balance restore (CAS template volumes; seededWithSludge jump-to-stable).

## Backlog (work top-down)
1. ✅ RESOLVED (iter 9): Fix Level-1 completion economy — SLR unit mismatch fixed; all 5 sim tests pass.
2. Idea pool (post-mission freedom): blower VFD upgrade tree; sludge
   treatment line objectives; sound effects for placement.
3. ✅ RESOLVED (iter 10): Pump runout/service-factor clamping in
   `findPumpDutyPoint` — analytic intersections beyond the curve end now cap
   at runout (1.25×BEP default, affinity-scaled); `pump_at_runout` validator
   warning added.
4. EQ API: return `constituentMassKg` snapshot in `EqStepResult`.
5. Wire validatePipeVelocity into pipe design context (currently defined but
   uncalled) when §AK items 7/8 (custom pipe diameter/material) get their UI.
6. §AK Phase-1 audit of remaining vertical-slice items:
   - 1–3: design/runtime data model, custom geometry, CAS sizing (partial)
   - 5–6: blower/equipment capacity, clarifier custom sizing (templates need
     peak-flow resize before raising diurnal strength to 1.0)
   - 7–10: custom pipe diameter/material, pipe headloss, pump duty point,
     equalization dynamic storage (partial)
   - 11–13: quantity-based CAPEX, Unit Designer UI, Show Calculation (partial)
   - 14: dynamic influent ✅ (strength 0.4; full 1.0 after 5/6)
   - 15: engineering warnings ✅ phase 1+2 (structural + pump stations);
     membrane-flux check lands with the MBR migration
   - 16–17: updated campaign L1/L2/L3, tests.

## Notes
- Never delete files — move into junk/. Probes live in junk/autopilot-20260826/
  (delim-scan, probe-range-events, probe-input-death, probe-input-matrix,
  probe-checkbox-delegation document the React-event investigation);
  scratch gate-run logs in junk/autopilot-20260827/.
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a
  node_modules junction; prune metadata afterwards. (Used stash round-trip in
  iter 8 — equally effective for tracked-file baselines.)
