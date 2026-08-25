# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 2 — backlog #2 + mission A5 landed)
Gate policy: `npm run build` + `npx tsc --noEmit` must be clean; suites:
`npm test` (sim), `npm run test:ui` (= static ui-tests + ui-interaction-tests),
`npm run test:eng`.

## ⭐ MISSION DIRECTIVE (user, 2026-08-26)
`MISSION_REDESIGN.md` (repo root) is the authoritative roadmap: full
architectural redesign into a wastewater-engineering tycoon / process-design
simulator. Work it TOP-DOWN:
1. ✅ Legacy backlog #1 cleared in iter 1.
2. Section A bug fixes: A1 terrain decals, A2 tool invariant, A3 permit
   single-source verification, A4 CI gating, A5 UI interaction tests (✅
   landed iter 2), A6 PFD branching, A7 junk cleanup.
3. Then §AK PHASE 1 vertical slice: AUDIT each of the 17 items against the
   actual code, finish/strengthen what is partial, one coherent slice per
   iteration, tests per §AM.
4. After Phase 1 stabilizes: migrate MBR/RO/A2O/DAF/sludge/disinfection.
Never regress §AL. Respect §AI performance limits. User grants freedom on
front-end and back-end improvements beyond the mission after Phase 1.

## Iteration log
- iter 2 (2026-08-26): LANDED the crashed run's WIP + finished it.
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
- iter 1 (2026-08-26): CLEARED backlog #1 — all 4 eng-test failures fixed,
  suite 47/47 (was 42/46). EQ analytic-CSTR + min-pool physics, PIPE test
  typo, PUMP wire-to-water envelope, PERMIT exact-survivor assertion.
- iter 0 (2026-08-26): LANDED pending foundation set (engineered-unit
  architecture, blueprints+geometry, hydraulics, processes, UnitDesigner UI,
  PermitEngine single-source compliance, eng-tests suite) + seeded-commissioning
  balance restore (CAS template volumes; seededWithSludge jump-to-stable).

## Backlog (work top-down)
1. MISSION_REDESIGN.md Section A remaining: A1 terrain decals, A2 tool
   invariant, A3 permit single-source verification, A4 CI gating,
   A6 PFD branching, A7 junk cleanup (move, never delete).
2. Seed-sludge cost choice (follow-up): wire a real one-time CAPEX charge /
   discount so the toggle's economics are more than cosmetic; optionally let
   placement dialog pre-select seeding.
3. Clarifier outlet quality probe reads zeros in Test S context — verify
   `lastOutletQuality` propagation for clarifier units (cosmetic/debug).
4. Idea pool (post-mission freedom): blower VFD upgrade tree; sludge
   treatment line objectives; sound effects for placement.
5. Pump runout/service-factor clamping in `findPumpDutyPoint`.
6. EQ API: return `constituentMassKg` snapshot in `EqStepResult`.
7. Then §AK Phase-1 audit of the 17 vertical-slice items.

## Notes
- Never delete files — move into junk/. Probes live in junk/autopilot-20260826/
  (delim-scan, probe-range-events, probe-input-death, probe-input-matrix,
  probe-checkbox-delegation document the React-event investigation).
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a
  node_modules junction; prune metadata afterwards.
