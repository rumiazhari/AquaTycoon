# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 5 — seed-sludge haul-in economics, backlog #1)
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
1. Unseeded placement pre-select (follow-up): the cheaper-but-slow start is
   currently reachable only by placing seeded then toggling off. Add a
   seed/no-seed choice to the placement flow (toolbar toggle or confirm
   dialog) wired through placeUnit options.
2. Clarifier outlet quality probe reads zeros in Test S context — verify
   `lastOutletQuality` propagation for clarifier units (cosmetic/debug).
3. Idea pool (post-mission freedom): blower VFD upgrade tree; sludge
   treatment line objectives; sound effects for placement.
4. Pump runout/service-factor clamping in `findPumpDutyPoint`.
5. EQ API: return `constituentMassKg` snapshot in `EqStepResult`.
6. §AK Phase-1 audit of remaining 16 vertical-slice items:
   - 1–3: design/runtime data model, custom geometry, CAS sizing (partial)
   - 5–6: blower/equipment capacity, clarifier custom sizing (templates need
     peak-flow resize before raising diurnal strength to 1.0)
   - 7–10: custom pipe diameter/material, pipe headloss, pump duty point,
     equalization dynamic storage (partial)
   - 11–13: quantity-based CAPEX, Unit Designer UI, Show Calculation (partial)
   - 14: dynamic influent ✅ (strength 0.4; full 1.0 after 5/6)
   - 15–17: engineering warnings, updated campaign L1/L2/L3, tests.

## Notes
- Never delete files — move into junk/. Probes live in junk/autopilot-20260826/
  (delim-scan, probe-range-events, probe-input-death, probe-input-matrix,
  probe-checkbox-delegation document the React-event investigation).
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a
  node_modules junction; prune metadata afterwards.
