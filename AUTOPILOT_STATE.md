# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 1 — backlog #1 cleared)
Gate policy: `npm run build` + `npx tsc --noEmit` must be clean; suites:
`npm test` (sim), `npm run test:ui`, `npm run test:eng`.

## ⭐ MISSION DIRECTIVE (user, 2026-08-26)
`MISSION_REDESIGN.md` (repo root) is now the authoritative roadmap: full
architectural redesign into a wastewater-engineering tycoon / process-design
simulator. Work it TOP-DOWN:
1. First clear legacy backlog #1 below (4 eng-test failures) — they gate
   everything else.
2. Then execute Section A bug fixes (A1 terrain decals, A2 tool invariant,
   A3 permit single-source verification, A4 CI gating, A5 UI interaction
   tests, A6 PFD branching, A7 junk cleanup).
3. Then §AK PHASE 1 vertical slice: AUDIT each of the 17 items against the
   actual code (iter 0 landed much of the skeleton), finish/strengthen what
   is partial, one coherent slice per iteration, tests per §AM.
4. After Phase 1 stabilizes: migrate MBR/RO/A2O/DAF/sludge/disinfection.
Never regress §AL. Respect §AI performance limits. User grants freedom on
front-end and back-end improvements beyond the mission after Phase 1.

## Iteration log
- iter 1 (2026-08-26): CLEARED backlog #1 — all 4 eng-test failures fixed,
  suite now 47/47 (was 42/46). Gates: build ✅ tsc ✅ sim ALL PASS ✅
  ui 67/67 ✅ eng 47/47 ✅.
  - EQ (REAL physics fix, src/sim/processes/Equalization.ts): removed the
    empty-basin raw-passthrough bypass; added EQ_MIN_POOL_FRACTION = 0.08
    minimum operating pool (water below the pump intake) so every slug blends
    with basin contents; mass balance now uses the EXACT analytic CSTR
    solution (unconditionally stable); pump cannot draw the pool itself;
    simplified pH blend. Test harness no longer feeds effluent CONCENTRATIONS
    back as constituent MASSES (kg) — that unit mismatch was masked by the old
    bypass and corrupted state across steps.
  - PIPE (test typo): "longer pipe" case compared identical args (300 m vs
    300 m); now 300 m vs 30 m + friction term pinned.
  - PUMP (calibration): replaced magic "<50 kW" with the physics-derived
    wire-to-water envelope (hydraulic ρgQH < P_elec < ρgQH/0.55). At the free-
    running duty point 759 m³/h @ 16.5 m, ~50.2 kW at η=0.68 is correct.
  - PERMIT (unsatisfiable assertion): a single pH can never violate BOTH
    bounds; now asserts exactly which criterion survives (ph_high) on a
    too-low sample — stronger than a bare count.
- iter 0 (2026-08-26): LANDED pending foundation set (engineered-unit
  architecture: src/design/* blueprints+geometry, src/sim/hydraulics,
  src/sim/processes/{ActivatedSludge,Clarifier,Equalization,Pumping},
  UnitDesigner UI, PermitEngine single-source compliance, eng-tests suite).
  Balance fixes included in the landing:
  1. Template defaults resized to legacy working volumes so Level-1 HRT /
     economics stay balanced under blueprints (CAS 36x12x4 m = 1728 m³;
     secondary clarifier 2 x Ø18 m @ 4.5 m SWD ≈ 2290 m³).
  2. Seeded commissioning: new engineerable placements arrive with
     `seededWithSludge: true`; stepCasRuntime jumps seeded reactors straight
     to 'stable' with ~800 mg/L imported biomass instead of the multi-week
     unseeded ramp that made Level 1 economically unplayable (fines $4250/d
     during ramp). Unseeded natural-growth path preserved for future use.
  Verification at land time: build ✅ tsc ✅ sim ALL PASS ✅ ui 67/67 ✅
  eng-tests 42/46 (4 pre-existing failures, see backlog #1).

## Backlog (work top-down)
1. MISSION_REDESIGN.md Section A (A1–A7), then Phase-1 audit (§AK).
2. Unit Designer: expose seed-sludge as an optional cost choice (unseeded =
   cheap but weeks-long commissioning ramp) — machinery exists via
   `seededWithSludge`.
3. Clarifier outlet quality probe reads zeros in Test S context — verify
   `lastOutletQuality` propagation for clarifier units (outfall values are
   correct; cosmetic/debug concern only).
4. Idea pool (post-mission freedom): blower VFD upgrade tree; sludge
   treatment line objectives; sound effects for placement.
5. Pump runout/service-factor clamping (real physics refinement): at free-
   running duty points far beyond rated flow, motor would trip — add a
   continuous shaft-power cap in `findPumpDutyPoint`.
6. EQ API: return `constituentMassKg` snapshot in `EqStepResult` so callers
   don't reconstruct from concentrations; makes the test pattern type-safe.

## Notes
- Never delete files — move into junk/. Probe scripts live in
  junk/autopilot-20260826/. (Mission A7 asks to tidy junk probes: MOVE them,
  do not delete.)
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a
  node_modules junction; prune metadata afterwards.
