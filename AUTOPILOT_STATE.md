# AUTOPILOT STATE — Aquatycoon

STATUS: OK
Last run: 2026-08-26 (cron, iter 0 landing)
Gate policy: `npm run build` + `npx tsc --noEmit` must be clean; suites:
`npm test` (sim), `npm run test:ui`, `npm run test:eng`.

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
2. Unit Designer: expose seed-sludge as an optional cost choice (unseeded =
   cheap but weeks-long commissioning ramp) — machinery exists via
   `seededWithSludge`.
3. Clarifier outlet quality probe reads zeros in Test S context — verify
   `lastOutletQuality` propagation for clarifier units (outfall values are
   correct; cosmetic/debug concern only).
4. Idea pool: influent flow varies diurnally; blower VFD upgrade tree;
   sludge treatment line objectives; sound effects for placement.

## Notes
- Never delete files — move into junk/. Probe scripts live in
  junk/autopilot-20260826/.
- HEAD baseline comparison trick: git worktree in $LOCALAPPDATA/Temp with a
  node_modules junction; prune metadata afterwards.
