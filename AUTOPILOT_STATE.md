# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 0 landing)
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
1. eng-tests: 4 failing assertions in new modules —
   - EQ. load spike not attenuated (outlet BOD = raw spike 800)
   - PIPE. headloss returns 0 for both short and long pipe
   - PUMP. electrical power outside expected band (50.2 kW)
   - PERMIT. expected 11 criteria failing on bad effluent (count mismatch)
   → These are REAL physics gaps (EQ storage not conserving mass, pipe
   headloss stub, pump duty point wrong, permit criteria count). Fixing them
   = first slice of MISSION §J/§K/§M/§A3.
2. MISSION_REDESIGN.md Section A (A1–A7), then Phase-1 audit (§AK).
3. Unit Designer: expose seed-sludge as an optional cost choice (unseeded =
   cheap but weeks-long commissioning ramp) — machinery exists via
   `seededWithSludge`.
4. Clarifier outlet quality probe reads zeros in Test S context — verify
   `lastOutletQuality` propagation for clarifier units (outfall values are
   correct; cosmetic/debug concern only).
5. Idea pool (post-mission freedom): blower VFD upgrade tree; sludge
   treatment line objectives; sound effects for placement.

## Notes
- Never delete files — move into junk/. Probe scripts live in
  junk/autopilot-20260826/. (Mission A7 asks to tidy junk probes: MOVE them,
  do not delete.)
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a
  node_modules junction; prune metadata afterwards.
