# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 20 — wired per-contract design flow into DesignValidator placement context, retiring the VALIDATOR_REFERENCE_FLOW_M3D heuristic; gates: build ✅ tsc ✅ sim ✅ ui ✅ eng 300/300 ✅)

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
  validator's design basis replaces magic 5000 in DesignValidator; fresh CAS +
  clarifier carry zero peak issues). (b) Clarifier.ts legacy private
  PEAK_FACTOR = 1.8 deleted → imports shared PEAK_FLOW_FACTOR (×1.446); peakSor
  now honestly reports 19.9 m/d where it said 24.8 @L1. No runtime physics
  consumed that field, so zero sim impact. 4 new eng tests PF19–PF22 pin the
  shared constant, clean fresh-template validation for CAS+clarifier, and the
  death of ×1.8. Branch hygiene: main fast-forwarded to the autopilot-attempts
  tip (iters 15–16 had been stranded there); iteration committed on main.
  Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui 26/26 ✅ eng 298/298 ✅.
- iter 18 (2026-08-26): Updated Level 1 briefing to reference VALIDATOR_REFERENCE_FLOW_M3D design basis. Gates: build ✅ tsc ✅ sim ✅ ui ✅.
- iter 19 (2026-08-26): §AK items 16/17 CLOSED — campaign L1/L2/L3 levels updated with new objectives (obj_pump, obj_cas_sizing) and Test S revised for staged pump+UV build. Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui ✅.
- iter 19 (2026-08-26): §AK item 13 ✅ Show Calculation panel rolled out across all four engineerable unit types (CAS, clarifier, equalization basin, pump station) — each DiagnosticsTab now renders per‑process CalcBlock derivations with honest substituted equations and live numbers. §AK items 16/17 remain: updated campaign L1/L2/L3 levels with tests.
- iter 20 (2026-08-26): Wired per-contract design flow through placement context into DesignValidator. Added `OperatorControls.designFlowM3d?`; `estimateDesignFlow` now returns `unit.blueprint?.controls?.designFlowM3d ?? VALIDATOR_REFERENCE_FLOW_M3D`, retiring the Phase-1 heuristic's stated exit condition (§AK item 17 follow-up). Backward-compatible: absent contract flow falls back to the shared basis. New eng tests PF23/PF23b pin the override (8000 m³/d → CAS reports `blower_undersized`) and the clean fallback. Gates: build ✅ tsc ✅ sim ALL PASS ✅ ui 70+52 ✅ eng 300/300 ✅. New ui‑interaction-tests.tsx section added verifying every CalcBlock's equation string and EconomicsTab civil‑derivation math.

## Backlog (work top-down)
1. ✅ RESOLVED (iter 9): Fix Level-1 completion economy — SLR unit mismatch fixed; all 5 sim tests pass.
2. ✅ RESOLVED (iter 16): Fix sim Test K — TN/NH₄ violations under full diurnal peak. MBBR SND model added; compliance streak test passes.
3. Idea pool (post-mission freedom): blower VFD upgrade tree; sludge treatment line objectives; sound effects for placement.
4. ✅ RESOLVED (iter 10): Pump runout/service-factor clamping in `findPumpDutyPoint` — analytic intersections beyond the curve end now cap at runout (1.25×BEP default, affinity-scaled); `pump_at_runout` validator warning added.
5. ✅ RESOLVED (iter 11): EQ API returns `constituentMassKg` snapshot + `inflowM3d` in `EqStepResult`; validator EQ audit + live DiagnosticsTab readout landed with it (§AK item 10 telemetry half).
6. ✅ RESOLVED (iter 12): validatePipeVelocity wired into the PFD Pipe Engineering panel (live per-pipe warnings); §AK items 7/8 landed with it (auto‑sizing ladder, materials UI, cached hydraulics, CAPEX display).
7. ✅ RESOLVED (iter 13): Wired stepPumpStation into runtime pump_station (§AK item 9 runtime half). Pump stations now use real duty‑point solver (static lift + downstream headloss → system curve intersect), return PumpRuntimeTelemetry (status, duty point, power, BEP%, cavitation, failed units). VFD speedCommand honored, clog penalty stacks on duty‑point power/opex. Live telemetry panel in UnitDesigner DiagnosticsTab. 12 new PUMP_RT eng tests. All gates clean.
8. §AK Phase‑1 audit of remaining vertical‑slice items:
   - 1–3: design/runtime data model, custom geometry, CAS sizing (partial)
   - 5–6: blower/equipment capacity ✅, clarifier custom sizing ✅ — physics + validators + PF tests landed iter 15; iter 17 closed the residue by sharing ONE reference flow (VALIDATOR_REFERENCE_FLOW_M3D) between validator and template pins and purging Clarifier's private ×1.8 factor
   - 7–10: custom pipe diameter/material ✅, pipe headloss ✅ (iter 12), pump duty point ✅ runtime‑wired iter 13, equalization dynamic storage ✅ — §AK items 7–10 CLOSED
   - 11: quantity‑based CAPEX ✅ FULLY RESOLVED iter 14 (billing charged on build/edit/remove + 70% salvage; display ✅ iter 12)
   - 12: Unit Designer UI ✅ (enhanced §AK item 13 Show Calculation rollout)
   - 13: Show Calculation ✅ (rolled out across all four engineerable units in iter 19)
   - 14: dynamic influent ✅ (full strength 1.0 default since iter 15)
   - 15: engineering warnings ✅ phase 1+2 (+pipe velocity iter 12); membrane‑flux check lands with the MBR migration
   - 16–17: ✅ RESOLVED (iter 19): updated campaign L1/L2/L3 levels with new objectives (obj_pump, obj_cas_sizing) and revised Test S for staged pump+UV build.

Next goal (iter 20): §AK item 17 follow-up DONE — per-contract design flow now flows through placement context. Next: begin MBR migration (or user freedom post-mission work) — gate by eng tests.

## Notes
- Never delete files — move into junk/. Probes live in junk/autopilot-20260826/ (delim-scan, probe-range-events, probe-input-death, probe-input-matrix, probe-checkbox-delegation document the React‑event investigation); scratch gate‑run logs in junk/autopilot-20260827/.
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a node_modules junction; prune metadata afterwards. (Used stash round‑trip in iter 8 — equally effective for tracked‑file baselines.)