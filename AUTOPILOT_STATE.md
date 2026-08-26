# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 17 — single-source peak basis: VALIDATOR_REFERENCE_FLOW_M3D + clarifier factor unified; §AK items 5/6 CLOSED)
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
- iter 17 (2026-08-26): §AK items 5/6 CLOSED — ONE authoritative peak-flow
  basis everywhere. (a) NEW PeakFlow.VALIDATOR_REFERENCE_FLOW_M3D = 3500 (the
  L1 contract flow every PF template pin uses); DesignValidator.
  estimateDesignFlow returns it instead of magic 5000 — before this, a FRESH
  default CAS placement tripped blower_no_peak_headroom under the validator's
  own basis (peak need 2429 > capacity 2413 kg O₂/d @5000 m³/d), directly
  contradicting PF10's "templates validate clean". Now fresh CAS + clarifier
  carry zero peak issues [none]. (b) Clarifier.ts legacy private
  PEAK_FACTOR = 1.8 deleted → imports shared PEAK_FLOW_FACTOR (×1.446):
  peakSorM3M2Day now honestly reports 19.9 m/d where it said 24.8 @L1. No
  runtime physics consumed that field, so zero sim impact. 4 new eng tests
  PF19–PF22 pin the shared constant, clean fresh-template validation for
  CAS+clarifier, and the death of ×1.8. Branch hygiene: main fast-forwarded
  to the autopilot-attempts tip (iters 15–16 had been stranded there);
  iteration committed on main. Probe quarantined in junk/autopilot-probe-peak/.
  Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui 26/26 ✅ eng 298/298 ✅.
- iter 16 (2026-08-26): Fixed sim Test K (compliance streak) — TN/NH₄ violations
  under full municipal diurnal peak (strength 1.0). Root cause: MBBR only
  nitrified (NH₄→NO₃) with NO denitrification; TN accumulated at ~68 mg/L vs
  Level 3 standard 15 mg/L. Fix: added Simultaneous Nitrification-Denitrification
  (SND) to MBBR model — anoxic biofilm interior denitrifies a fraction of TOTAL
  NO₃ (upstream + newly nitrified) using biodegradable COD diffusing from bulk.
  SND fraction scales with carrier fill ratio (up to 90% at 100% fill).
  Also fixed Test K plumbing bug (missing m2→m3 pipe, p4b typo) and added EQ
  basin to test plant for diurnal dampening. 3 MBBRs at 100% fill + EQ now
  achieve complianceScore ≥ 90% at full diurnal strength. streakBefore = 2.9d
  → streakAfter = 0.0d on bypass. All gates: build ✅ tsc ✅ sim 29/29 ✅
  ui 96/96 ✅ eng 294/294 ✅.
- iter 14 (2026-08-26): Quantity-based pipe CAPEX billing end-to-end (§AK item 11 —
  the "billing still open" half of iter 12's display work). NEW GameManager pure
  statics: purchasePipes() bills Σ estimatePipeCAPEX over drafts at pathLengthM and
  installs ATOMICALLY (reject = no pipes, no debit); updatePipeEngineering() prices
  PFD DN/material change orders as the positive DELTA vs capexPaid (downsizes refund
  nothing; legacy no-capexPaid pipes price first edit vs their DN80-floor estimate);
  removePipes()/demolishUnit pay 70% salvage (PIPE_SALVAGE_RATE) on actually-billed
  pipe, $0 for legacy/tutorial. PipeConnection.capexPaid records the paid basis;
  auto-sizer re-picks stay inside the original lump sum by design. App.tsx: both
  creation sites + auto-train bundle + toggle-remove + DN/material edit route through
  billing with ⛔ toasts; undo/redo already snapshots financials so Ctrl+Z
  self-refunds. Sandbox & tutorial training grant build free (placeUnit parity).
  14 new PBILL eng tests (255→269). GOTCHA: pathLengthM takes WORLD CELLS (×6 m),
  not metres — test drafts must be built in cells.
  Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui 70+26 ✅ eng 269/269 ✅.
- iter 13 (2026-08-26): Wired stepPumpStation into runtime pump_station (§AK item 9 runtime half). pump_station units now use the real duty-point solver (intersect pump curve with static lift + downstream pipe headloss) instead of the legacy pass-through. NEW: SimulationEngine computes discharge headloss from cachedHydraulics and passes it via ctx to calculateUnitProcess; UnitProcessModels.replace legacy pump_station case with stepPumpStation call (honors VFD speedCommand, clog penalty stacks on duty-point power/opex, returns PumpRuntimeTelemetry {status, dutyFlowM3h, dutyHeadM, bepFraction, cavitating, failedUnitCount, electricalPowerKw}). ProcessResult and PlacedUnitRuntimeState extended with optional pumpRuntime. UnitDesigner DiagnosticsTab shows live pump station telemetry (status, duty flow/head, BEP%, power, cavitation/failed-unit badges). 12 new PUMP_RT eng tests added (242→255) covering normal delivery, undersized clamp, VFD scaling, clog penalty stacking, legacy save compat. All gates: build ✅ tsc ✅ sim 118/118 ✅ ui 96/96 ✅ eng 255/255 ✅.
- iter 12 (2026-08-26): Engineered pipes end-to-end (§AK items 7/8 + backlog #5)...
  NEW `src/design/PipeSizing.ts`: STANDARD_DIAMETERS_M ladder (DN80–DN1200),
  recommendDiameterM() = smallest DN keeping MEAN velocity ≤1.2 m/s at observed
  daily volume, defaultMaterialForPipeType() per service (liquid/recycle→PVC,
  sludge/RAS→HDPE, gas→carbon steel, chemical→PVC), refreshPipeHydraulics()
  called by SimulationEngine AFTER convergence each tick — auto-sized pipes
  re-pick DN from the ladder as observed flow evolves (discrete ⇒ stable), all
  sized pipes get cachedHydraulics {lengthM(cells×6), velocityMs, headlossM}.
  Both App.tsx pipe-creation sites now emit materialId + autoSized:true.
  NEW PFD "Pipe Engineering" panel (PlantFlowDiagram): per liquid pipe a DN
  select (Auto + ladder; explicit pick sets autoSized=false and is never
  overridden), material select, live Q/v/Δh/L readout, estimatePipeCAPEX
  display (function finally called), and validatePipeVelocity warnings —
  backlog #5 validator wiring done. Legacy unsized pipes remain untouched
  (backward compat). 25 new PIPE2 eng tests (217→242) covering §AM PIPE rows.
  DISCOVERY for later: stepPumpStation (§AK item 9 runtime: duty point/NPSH/
  energy) is still NEVER CALLED — pump_station units run a legacy pass-through
  in UnitProcessModels; wiring it needs topology context passed into process
  evaluation (next natural slice, closes the headloss→energy loop).
  Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui ✅ eng 242/242 ✅.
- iter 11 (2026-08-26): EQ storage observability + overflow-risk audit (backlog #4,
  §AK item 10). EqStepResult now returns an inflowM3d report and a CLONED
  constituentMassKg snapshot — UnitProcessModels persists from the snapshot so
  tank state no longer aliases step-mutated objects. NEW validateEqualization-
  Design() in DesignValidator (wired into validateUnitDesign → live in
  UnitDesigner): critical eq_no_outflow (target ≤ 0), warning/critical
  eq_target_below_inflow when pump-out can't match observed average inflow,
  info eq_oversized, runtime telemetry checks eq_level_high (≥90%) /
  eq_overflowing_now (≥99.9%) reading unit.eqStorage. DiagnosticsTab shows a
  live EQ block (level %, stored volume, stored BOD/TSS mass, min pool).
  Flow/level checks are telemetry-gated so fresh placements stay clean.
  11 new EQ/EQV eng tests (206→217).
  Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui ✅ eng 217/217 ✅.
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
2. ✅ RESOLVED (iter 16): Fix sim Test K — TN/NH₄ violations under full diurnal peak. MBBR SND model added; compliance streak test passes.
3. Idea pool (post-mission freedom): blower VFD upgrade tree; sludge
   treatment line objectives; sound effects for placement.
4. ✅ RESOLVED (iter 10): Pump runout/service-factor clamping in
   `findPumpDutyPoint` — analytic intersections beyond the curve end now cap
   at runout (1.25×BEP default, affinity-scaled); `pump_at_runout` validator
   warning added.
5. ✅ RESOLVED (iter 11): EQ API returns `constituentMassKg` snapshot +
   `inflowM3d` in `EqStepResult`; validator EQ audit + live DiagnosticsTab
   readout landed with it (§AK item 10 telemetry half).
6. ✅ RESOLVED (iter 12): validatePipeVelocity wired into the PFD Pipe
   Engineering panel (live per-pipe warnings); §AK items 7/8 landed with it
   (auto-sizing ladder, materials UI, cached hydraulics, CAPEX display).
7. ✅ RESOLVED (iter 13): Wired stepPumpStation into runtime pump_station (§AK item 9 runtime half). Pump stations now use real duty-point solver (static lift + downstream headloss → system curve intersect), return PumpRuntimeTelemetry (status, duty point, power, BEP%, cavitation, failed units). VFD speedCommand honored, clog penalty stacks on duty-point power/opex. Live telemetry panel in UnitDesigner DiagnosticsTab. 12 new PUMP_RT eng tests. All gates clean.
8. §AK Phase-1 audit of remaining vertical-slice items:
   - 1–3: design/runtime data model, custom geometry, CAS sizing (partial)
   - 5–6: blower/equipment capacity ✅, clarifier custom sizing ✅ — physics +
     validators + PF tests landed iter 15; iter 17 closed the residue by
     sharing ONE reference flow (VALIDATOR_REFERENCE_FLOW_M3D) between
     validator and template pins and purging Clarifier's private ×1.8 factor
   - 7–10: custom pipe diameter/material ✅, pipe headloss ✅ (iter 12),
     pump duty point ✅ runtime-wired iter 13, equalization dynamic storage ✅ —
     §AK items 7–10 CLOSED (NEXT slice candidates: items 5/6 template peak-flow resize → diurnal 1.0, or 16/17 campaign)
   - 11–13: quantity-based CAPEX ✅ FULLY RESOLVED iter 14 (billing charged on
     build/edit/remove + 70% salvage; display ✅ iter 12), Unit Designer UI, Show Calculation (partial)
   - 14: dynamic influent ✅ (full strength 1.0 default since iter 15)
   - 15: engineering warnings ✅ phase 1+2 (+pipe velocity iter 12);
     membrane-flux check lands with the MBR migration
   - 16–17: updated campaign L1/L2/L3, tests.

Next goal (iter 18): §AK items 16/17 — updated campaign L1/L2/L3 levels that
exercise the engineered systems (+tests). Documented follow-up: wire
per-contract design flow through placement context into DesignValidator,
retiring the VALIDATOR_REFERENCE_FLOW_M3D heuristic (its stated exit condition).

## Notes
- Never delete files — move into junk/. Probes live in junk/autopilot-20260826/
  (delim-scan, probe-range-events, probe-input-death, probe-input-matrix,
  probe-checkbox-delegation document the React-event investigation);
  scratch gate-run logs in junk/autopilot-20260827/.
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a
  node_modules junction; prune metadata afterwards. (Used stash round-trip in
  iter 8 — equally effective for tracked-file baselines.)
