# MISSION: AquaTycoon Architectural Redesign — Wastewater Engineering Tycoon

> Autopilot working document. Execute top-down: Section A fixes + PHASE 1
> vertical slice first (see §AK), then later phases. Update AUTOPILOT_STATE.md
> progress notes as sections complete. Do not regress existing work (§AL).

REPOSITORY
rumiazhari/AquaTycoon

MISSION

Perform a major architectural redesign of AquaTycoon from a predefined-unit placement game into a genuine wastewater-engineering tycoon / process-design simulator intended to be technically useful and enjoyable for engineering students.

Do not merely add more sliders to the current predefined units.

The central gameplay must become:

PROJECT BRIEF
→ wastewater/load characterization
→ process selection
→ engineering design
→ physical sizing
→ equipment/material selection
→ hydraulic design
→ construction/procurement
→ commissioning
→ operation
→ troubleshooting
→ maintenance
→ optimization
→ expansion/retrofit
→ financial/performance evaluation

The player must engineer the plant rather than place developer-designed boxes.

Use the CURRENT repository architecture as the migration baseline. Inspect all relevant existing code before changing it, especially:

src/types/simulation.ts
src/types/game.ts
src/sim/UnitProcessModels.ts
src/sim/SimulationEngine.ts
src/sim/PipeNetwork.ts
src/sim/PermitEngine.ts
src/gameplay/GameManager.ts
src/gameplay/LevelsData.ts
src/gameplay/TechTreeData.ts
src/graphics/UnitMeshes.ts
src/graphics/TerrainGrid.ts
src/ui/UnitInspector.tsx
src/ui/BuildToolbar.tsx
src/ui/PlantFlowDiagram.tsx
src/ui/OperatorConsole.tsx
scripts/sim-tests.ts
scripts/ui-tests.tsx
scripts/eng-tests.ts (if present)
.github/workflows/deploy.yml

Do not build a parallel disconnected prototype. Migrate the actual game.

============================================================
A. FIX THE HELD BUGS BEFORE/WHILE REFACTORING
============================================================

These existing issues must not be forgotten.

A1. REMOVE THE FLOATING YELLOW/GREEN TERRAIN POLYGON ARTIFACT

In TerrainGrid._buildScatterFill(), the game creates approximately 260 large transparent ground-tone polygons using CircleGeometry(1, 7) with yellow/olive and green instance colors. They are scaled to large diameters but their Y elevation is sampled only at their center: terrainHeight(x, z) — so on slopes their edges float in the air. There is also progressive artificial elevation from + nP * 0.0006 which can raise later instances by ~0.15 m. These are the yellow/green floating polygon sheets visible around roads, hills and shorelines.

Remove the large N_PATCH ground decal system entirely. Do NOT replace it with another collection of flat transparent decals. The terrain already has vertex-color variation. If more ground variation is desired, implement it through terrain vertex color/material variation or geometry-conforming methods. Keep legitimate rocks, shrubs and vegetation. This removal should slightly improve rendering performance as well.

A2. TOOL STATE INVARIANT

The recent tool-mode fix is improved but the tool-state reducer must make this state IMPOSSIBLE: toolMode = 'place_unit' with selectedUnitTypeId = null. If select_unit_type(null) occurs while place_unit is active, transition cleanly to select or otherwise enforce an invariant. Do not rely on UI callback ordering to prevent the invalid state. Add a reducer-level regression test asserting the invariant.

A3. PERMIT ENGINE MUST REALLY BE AUTHORITATIVE

PermitEngine currently exists, but SimulationEngine still manually repeats the 11 permit checks. Remove duplicated regulatory-compliance logic from SimulationEngine. SimulationEngine, HUD, Operator Console, PFD, advisories and campaign compliance logic must consume one authoritative permit evaluator. Criteria include: BOD, COD, TSS, TN, NH4, TP, pathogens (including TRUE zero limits), minimum DO, minimum pH, maximum pH, turbidity. No duplicate formula sets.

A4. UI TESTS MUST RUN IN CI

package.json currently has: test, test:ui, test:all — but GitHub deployment currently runs only npm test before build. Change CI/deployment gating to run: npm ci, npm run test:all, npm run build. A UI regression must block deployment.

A5. IMPROVE FRONTEND INTERACTION TEST QUALITY

The current UI tests are mostly static markup/pure-function tests. Retain useful pure tests, but add real React interaction tests for important player actions, especially: Inspect, Pipes, Demolish, unit selection, tool switching, pipe cancellation, level-change reset, Tech Tree lock reasons, engineering designer interactions introduced below. Use a lightweight approach. Do not add an enormous browser-testing stack without reason.

A6. PFD BRANCHING

The current TrainTopology/PFD linearization can append branch nodes into mainTrainOrder and visually render "→" between nodes that are not directly connected. Do not display a branching hydraulic graph as a fake linear sequence. Represent actual edges. A splitter should visually appear as:

         → Train A
Inlet →
         → Train B

not: Inlet → Train A → Train B

Preserve stream classes: main liquid, sludge, RAS, internal/external recycle, gas, chemical.

A7. REPOSITORY CLEANUP

Remove accidental debug/probe content under junk that is not a legitimate retained conflict archive or useful test artifact, especially: junk/conflict-copies-20260825/_probe-ui.tsx. Do not leave temporary probes in production history going forward. (Per standing user policy: MOVE such files to C:\junk or the project junk folder — never hard-delete.)

============================================================
B. NEW CORE DOMAIN MODEL
============================================================

The current architecture hard-codes these properties into UnitDefinition: footprint, capex, baseOpexPerDay, powerConsumptionKw, minHRT_hours, ports, process tuning ranges — while PlacedUnit mostly stores position, volume and customParams. This architecture must change.

The game should distinguish:
1. PROCESS FAMILY
2. PHYSICAL DESIGN
3. INSTALLED EQUIPMENT
4. OPERATOR CONTROLS
5. CURRENT PROCESS STATE
6. ASSET CONDITION

Do not mix these together in customParams.

Introduce explicit data structures conceptually similar to:

PlacedUnit {
  instanceId
  processType
  geometry
  construction
  processDesign
  equipment
  electrical
  instrumentation
  controls
  runtime
  assetCondition
  gridX
  gridY
  rotation
}

Exact names can differ, but separation of responsibilities must be explicit.

Example distinction:
DESIGN: water depth = 5.2 m, diffuser count = 460, blower rated airflow = 5200 m3/h
CONTROL: DO setpoint = 2.0 mg/L, blower speed command = 72%
RUNTIME: actual DO = 1.63 mg/L, actual airflow = 4210 m3/h, actual MLSS = 3475 mg/L

Do not allow: DO setpoint == actual DO unless process physics genuinely allows the controller to maintain it.

============================================================
C. UNIT DEFINITIONS BECOME PROCESS TEMPLATES
============================================================

Do NOT remove existing process families (activated_sludge_cas, primary_clarifier_circular, secondary_clarifier, mbr_membrane, reverse_osmosis, equalization_basin, etc.). Instead, convert them into STARTING DESIGN TEMPLATES.

For example: "Conventional Activated Sludge — Municipal Default" is a blueprint starting point. The player must be able to alter the engineering design before or after placement, subject to construction/retrofit rules.

Existing predefined units should therefore become: template defaults + process-model identity, not immutable final assets.

Players should eventually be able to save reusable custom blueprints such as: Compact CAS 5k, High Reliability CAS 12k, Low Energy A2O, High Flux MBR, Conservative MBR, Industrial Equalization 8k.

============================================================
D. FREEFORM PHYSICAL UNIT SIZING
============================================================

The player must be able to create custom tank/unit dimensions. Do not restrict every structure to predefined [w,l] footprints. Maintain a practical world-grid conversion. The current game implicitly uses approximately 1 world/grid unit = 6 m through volume = (w*6)*(l*6)*4. Retain world-scale consistency but permit engineering dimensions with finer resolution.

For rectangular basins store/design: lengthM, widthM, waterDepthM, freeboardM, wallThicknessM, floorThicknessM, numberOfParallelTrains.
Derived: plan area A = L * W; working volume V = L * W * D * n; HRT_hours = 24 * V / Q.

For circular tanks: diameterM, sideWaterDepthM. A = pi*D²/4; V = A*depth.

Do not manually store values that are safely derivable.

PLAYER INTERACTION — implement an actual engineering placement workflow:
1. select process family
2. click/drag footprint in world
3. designer displays live dimensions
4. change water depth, train count, construction
5. live calculations update
6. confirm design
7. construction cost is deducted
8. generated 3D geometry reflects that exact design

The renderer must consume instance geometry rather than UnitDefinition.footprint.

============================================================
E. PROCEDURAL 3D UNIT MESHES MUST REFLECT THE DESIGN
============================================================

UnitMeshBuilder currently derives const [w,l] = def.footprint. Replace this for customizable assets with the placed unit's actual design geometry. A 30 × 15 × 5 m basin must visually differ from a 12 × 8 × 4 m basin. Walkways, walls, water surfaces, bridges, equipment and ports should scale/reposition logically. Do not simply scale the entire mesh uniformly. Generate components from the engineering geometry. Port world positions must derive from actual custom dimensions. PipeNetwork helpers must no longer assume static UnitDefinition port offsets for customizable units.

============================================================
F. ACTIVATED SLUDGE REWORK — FIRST REFERENCE IMPLEMENTATION
============================================================

Use CAS as the first fully engineered process model demonstrating the new architecture. The current CAS implementation largely determines BOD removal from DO and toxic penalty and directly assigns target MLSS as actual MLSS. That must be replaced.

CAS design variables (minimum): tank length, tank width, water depth, number of trains, design MLSS range, target SRT, diffuser type, diffuser count/density, blower configuration, blower rated airflow, motor efficiency, VFD availability, DO instrumentation/control strategy, RAS configuration, WAS capacity.

Core derived quantities: V, HRT, F/M, organic loading, oxygen demand, oxygen-transfer capacity, airflow requirement, installed aeration capacity, actual DO capability, SRT, MLSS, nitrification capacity, power demand.

Use educational engineering equations. Example: F/M = Q*S0/(V*X). Oxygen demand should include a simplified mechanistic formulation: O2 demand = organic oxidation demand + nitrification demand − denitrification oxygen credit. Nitrification stoichiometric demand ≈ 4.57 kg O2/kg NH4-N nitrified; denitrification credit ≈ 2.86 kg O2/kg NO3-N reduced. Do not use these numbers blindly if the code already uses a better internally consistent formulation; preserve mass conservation.

CRITICAL GAMEPLAY CONSEQUENCE: if oxygen required = 2100 kg O2/day but installed equipment transfers only 1750 kg O2/day → blower reaches capacity, actual DO falls, BOD removal deteriorates, nitrification deteriorates, NH4 rises, power reaches installed maximum. The player solves it through physically different interventions: more/larger blowers, more diffusers, better diffuser technology, deeper basin, larger reactor, parallel train, lower loading, operational changes. No hidden arbitrary "efficiency boost".

============================================================
G. MLSS / SRT MUST BE DYNAMIC
============================================================

Remove patterns where targetMlss → actual mlss. Actual biomass evolves over simulation time. Use a simplified dynamic biomass balance appropriate for gameplay/education: dX/dt = growth − endogenous decay − solids wasting − solids carried out.

SRT derives from: SRT = total biomass inventory / daily biomass removed.

Operator controls: WAS rate, RAS rate, SRT setpoint (if automated SRT controller installed).

Gameplay consequences: WAS too high → SRT falls → nitrifiers wash out → NH4 increases. WAS too low → MLSS rises → oxygen demand increases → clarifier solids loading increases.

New reactors must require commissioning. They must NOT instantly begin at stable full performance.

============================================================
H. COMMISSIONING
============================================================

Add meaningful commissioning state. A biological reactor progresses through: empty, fill, seed, startup, developing biomass, nitrification establishment, stable operation. Provide practical options: seed with activated sludge, natural startup, import biomass at financial cost. During commissioning: MLSS changes over time, treatment changes over time, nitrification may lag heterotrophic BOD removal. Visible to the player.

============================================================
I. CLARIFIER ENGINEERING
============================================================

Retain and expand the existing SOR/HRT mechanics foundation. Use SOR = Q/A; solids loading SLR = Q*X/A; where appropriate weir loading = Q/weir length.

Player design variables: circular vs rectangular, diameter or L×W, side-water depth, number of trains, weir arrangement, scraper type, sludge withdrawal capacity, RAS pump sizing for secondary clarification.

Peak hydraulic load must matter. A small clarifier may operate acceptably at average flow but fail during storm/peak flow. Failure sequence: Q rises → SOR rises → solids loading rises → sludge blanket rises → solids carryover rises → effluent TSS/turbidity rises. Make these actual simulation consequences.

============================================================
J. EQUALIZATION MUST BECOME REAL STORAGE
============================================================

Current equalization simply alters toxicity/pH. Replace with dynamic mixed-storage behavior. Store: tank volume, current stored volume, mixed constituent mass, outflow control.

Each step: V_next = V_current + (Qin−Qout)*dt. Per pollutant: M_next = M_current + Qin*Cin*dt − Qout*Ctank*dt, where Ctank = M/V. This inherently produces real hydraulic/load equalization. Basin size matters: 1000 m³ buffers far less than 8000 m³.

Controls: outflow target, level target, maximum pump discharge. Overflow must be possible when storage capacity exceeded.

============================================================
K. PIPE DESIGN BECOMES HYDRAULIC DESIGN
============================================================

PipeConnection currently lacks diameter/material/roughness/pressure rating/invert-elevation. Add them. Suggested properties: diameterM, materialId, roughnessM, startInvertM, endInvertM, minorLossK, maxPressureBar, condition, installationCost. Length derived from pathPoints.

Use actual hydraulic equations: A = pi*D²/4; v = Q/A; Darcy-Weisbach hf = f*(L/D)*(v²/(2g)); minor losses hm = ΣK*(v²/(2g)).

Pipe material catalog affects roughness, cost, corrosion resistance, pressure rating, service life (PVC, HDPE, ductile iron, carbon steel, stainless steel). Material is not cosmetic. Real trade-off: small diameter → lower CAPEX, higher velocity/headloss/pumping energy; large diameter → higher CAPEX, lower energy. Routing distance must matter.

============================================================
L. GRAVITY HYDRAULICS / ELEVATION
============================================================

Introduce hydraulic elevations lightweightly. Units have relevant elevations: ground elevation, water surface elevation, inlet invert, outlet invert. Flows move by gravity when available head suffices; otherwise upstream backing/level rise, reduced flow, or pump requirement. No CFD — steady/quasi-steady network calculation is sufficient.

============================================================
M. REAL PUMP DESIGN
============================================================

Replace pass-through pump_station with equipment-based pump systems. Pump definition: rated flow, shutoff head, rated head, pump efficiency curve, motor efficiency, NPSH required, min/max speed, VFD yes/no.

System curve: Hsystem = Hstatic + KQ². Pump curve: Hpump = H0 − kQ². Find the operating point. Power: P = rho*g*Q*H/(pumpEfficiency*motorEfficiency).

Consequences: oversized pump → high CAPEX, poor BEP operation, energy waste. Undersized → insufficient peak flow, upstream accumulation/overflow. High suction loss → cavitation risk, condition loss. VFD → better variable-flow efficiency, higher initial CAPEX.

============================================================
N. EQUIPMENT SYSTEM
============================================================

Create reusable equipment catalogs instead of embedding mechanical properties in process units. Architecture for: Pumps, Blowers, Motors, Diffusers, Mixers, Membrane modules, UV lamps, Chemical dosing pumps, Scrapers. Components carry engineering attributes, not arbitrary game bonuses. Example blower: ratedAirflowM3h, ratedPressureKPa, isentropicEfficiency, motorEfficiency, minimumTurndown, hasVFD, capex, maintenanceCost, MTBF.

============================================================
O. REDUNDANCY / RELIABILITY
============================================================

Allow configurations: 1×100%, 2×100% (duty+standby), 3×50% (two duty + one standby). Affects CAPEX, available capacity, energy efficiency where relevant, failure resilience.

Equipment condition + lightweight reliability: P(failure during dt) = 1 − exp(−dt/MTBF). Modify failure risk through overload, off-design-point operation, cavitation, high TMP, corrosion, maintenance condition. Deterministic seeded randomness (reproducible). Failures have physical consequences.

============================================================
P. MAINTENANCE
============================================================

Assets accumulate operating hours, wear, fouling, corrosion where relevant. Player choices: preventive maintenance, run-to-failure, overhaul, replacement. Maintenance costs money and may cause downtime. Standby redundancy allows maintenance without total capability loss.

============================================================
Q. MBR ENGINEERING
============================================================

Replace crude fouled/not-fouled with real membrane design. Design variables: material, configuration, pore size, module area, module count, total membrane area, design flux, maximum TMP, air scour, backwash interval, chemical cleaning strategy, trains, redundancy.

Flux J = Qp*1000/(Am*24) LMH → required area Am = Qp*1000/(24*J). High flux: area↓ CAPEX↓ fouling↑ TMP↑ cleaning↑ replacement↑. Conservative: CAPEX↑ resilience↑.

Simplified resistance/fouling progression (no binary penalty): TMP ∝ flux × total hydraulic resistance. Resistance increases with TSS, flux, time, insufficient scour; decreases via backwashing/CIP. No computationally heavy membrane model.

============================================================
R. MEMBRANE MATERIAL CATALOG
============================================================

Membrane material must not be "+10% better". Catalog attributes: permeability, chemical resistance, chlorine tolerance, abrasion resistance, max TMP, fouling coefficient, module CAPEX/m², expected lifetime. Categories e.g. PVDF, PES, ceramic. Technically defensible comparative behavior; avoid false precision.

============================================================
S. REVERSE OSMOSIS ENGINEERING
============================================================

Preserve current mass-conserving permeate/reject logic. Add design parameters: membrane area, vessels, elements/vessel, feed pressure, recovery target, pump efficiency, pretreatment quality, cleaning state. RO energy derives from pressure and flow, not static powerConsumptionKw. Recovery influences permeate flow, brine concentration, osmotic/hydraulic burden, fouling/scaling risk. Poor pretreatment worsens pressure requirement, fouling, cleaning frequency, membrane life.

============================================================
T. CONSTRUCTION MATERIALS
============================================================

Quantity-based design cost for custom structures. Rectangular tanks: floor area, wall area, concrete volume, excavation volume, lining area. Example: A_floor = L*W; A_wall = 2*(L+W)*(depth+freeboard); concrete volume ≈ floor area*floor thickness + wall area*wall thickness.

Material catalog: reinforced concrete, epoxy-lined concrete, carbon steel, SS304, SS316, FRP, HDPE — affecting unit cost, corrosion/chemical resistance, service life, maintenance, embodied carbon (if carbon tracking added). Warn on impossible material/process combinations.

============================================================
U. CAPEX MUST BE QUANTITY BASED
============================================================

Replace fixed def.capex for engineered assets with: civil, mechanical, electrical, instrumentation, pipework, sitework, construction contingency. CAPEX = excavation + concrete/structure + equipment + electrical + instrumentation + piping + installation. Player sees breakdown. Templates keep estimated default CAPEX before customization.

============================================================
V. OPEX MUST BE MECHANISTIC
============================================================

Operational cost derives from actual simulation outputs: electricity, chemicals, sludge disposal, membrane replacement reserve, maintenance, labor where modeled, spare parts, heating, cleaning. Report specific values: kWh/m3, currency/m3, kg chemical/day, kg sludge DS/day, membrane replacement/year. No arbitrary static OPEX where a quantity is calculable.

============================================================
W. ECONOMIC TYCOON LAYER
============================================================

Each project has: capital budget, operating budget/target, effluent requirements, design flow, peak flow, available site area, reliability expectation, contract tariff/revenue, completion reward/penalty. Longer-term: loan/debt, maintenance reserve, replacement CAPEX, upgrade contracts, reputation. No shallow "click to earn money". Economic gameplay comes from engineering decisions.

============================================================
X. PROJECT/CONTRACT MODEL
============================================================

Evolve CampaignLevel toward EngineeringProject/Contract. Handle saved level data migration safely. Contracts define: average flow, peak flow, influent profile, effluent permit, land area, capital budget, operating targets, reliability requirements, special constraints (max footprint, energy target, no membrane processes, limited chemical use, reuse quality, industrial toxicity, storm resilience). Do not prescribe one correct train unless tutorial. Evaluate by OUTPUT and DESIGN PERFORMANCE, not hardcoded sequences.

============================================================
Y. EXISTING FIVE CAMPAIGN LEVELS MUST BECOME AN ENGINEERING CURRICULUM
============================================================

Keep existing settings/world environments.

LEVEL 1 — SEASIDE HAVEN: existing municipal influent/permit. Teach: basic sizing, HRT, CAS fundamentals, oxygen demand, clarifier SOR, pipe sizing, simple pumping, disinfection, CAPEX/OPEX. Tutorial guidance only, no forced single sequence.

LEVEL 2 — HOP & CREAM: high-strength food/brewery load. Teach: organic loading, diurnal/batch loading, equalization, DAF, aeration capacity, peak design, sludge handling. Player learns why equalization helps through behavior.

LEVEL 3 — SYNTHVILLE: industrial toxicity, material compatibility, shock loads, robust biological design, AOP, chemical treatment, maintenance consequences.

LEVEL 4 — EMERALD LAKE: nitrification, denitrification, SRT, anoxic/aerobic zoning, internal recycle, phosphorus removal, digestion, energy recovery, high reliability.

LEVEL 5 — NEW OASIS: MBR, membrane flux, TMP, fouling, cleaning, RO pressure/recovery, membrane materials, energy, redundancy, potable reuse reliability.

============================================================
Z. DYNAMIC INFLUENT
============================================================

Levels mostly expose one static influentSpec. Introduce InfluentProfile { baseQuality, hourlyFlowProfile, hourlyLoadProfile, industrialBatchEvents, stormInfiltrationInflow, temperatureProfile }. Municipal flow varies diurnally (night low, morning peak, midday moderate, evening peak — pattern not globally hardcoded). Industrial scenarios: pollutant mass spikes independent of flow. Storms increase flow while diluting sanitary concentrations. Mass loading stays physically coherent.

============================================================
AA. STORM / PEAK HYDRAULIC EVENTS
============================================================

Peak flow matters to pipes, pumps, equalization, clarifiers, reactor HRT, disinfection contact time, membrane loading. A design passing Qavg only must not automatically pass the project. Provide design-flow and peak-flow diagnostics.

============================================================
AB. PROCESS FAILURE MUST BE VISIBLE
============================================================

Translate failures into the 3D world lightweightly: clarifier overload → blanket visibly rises, water dirties, solids carryover; low aeration → basin appearance changes, low-DO status; membrane fouling → TMP warning, pressure state; pump failure → stopped animation/status, upstream level problem; overflow → visible spill/bypass. Lightweight state-driven cues; don't destroy performance.

============================================================
AC. UNIT DESIGNER UI
============================================================

Structured engineering interface with tabs ≈ DESIGN / OPERATE / DIAGNOSTICS / ECONOMICS / MAINTENANCE.

DESIGN: geometry, materials, process configuration, installed equipment, rated capacity, construction cost.
OPERATE: setpoints, pump speed, blower control, RAS, WAS, chemical dose, membrane operation.
DIAGNOSTICS: HRT, SRT, F/M, SOR, SLR, DO, MLSS, OUR, airflow, headloss, pump duty point, TMP, flux (where relevant).
ECONOMICS: CAPEX, electricity, chemicals, maintenance, replacement, specific OPEX.
MAINTENANCE: condition, runtime, next service, failure risk, actions.

============================================================
AD. "SHOW CALCULATION" EDUCATIONAL MODE
============================================================

For important outputs add "Show Calculation": equation, substituted values, units, result, short explanation. Examples: HRT = V/Q = 2500 m³/5000 m³/d = 0.5 d = 12 h; pump Q/TDH/hydraulic power/efficiency/motor input; clarifier area/SOR/SLR; membrane flow/area/flux/TMP basis. Essential for engineering-student utility. Do not hide mechanics behind unexplained ratings.

============================================================
AE. DESIGN VALIDATION
============================================================

Engineering warnings rather than arbitrary blocking: HRT below range, excessive SOR, pipe velocity too high/too low, blower below demand, no valid pump duty point, aggressive membrane flux, inadequate NPSH margin, unrealistic structural dimensions, insufficient freeboard, missing standby where contract requires redundancy. Classify INFO/WARNING/CRITICAL. A design may remain buildable despite warnings — let failure teach.

============================================================
AF. BLUEPRINT SYSTEM
============================================================

Reusable player-designed unit blueprints: process family, geometry, construction, equipment selections, default controls. NO runtime state. Save Blueprint / Duplicate / Rename / Use in another project. Existing predefined units provide templates.

============================================================
AG. TECH TREE REWORK
============================================================

Rework gradually toward engineering capability unlocks: process configurations, advanced materials, equipment families, high-efficiency motors, fine-bubble diffusers, VFDs, advanced membranes, better instrumentation, control strategies, advanced cleaning, automation. Avoid hidden global "+20% efficiency" — improvements come from explicit equipment properties.

============================================================
AH. INSTRUCTOR / EDUCATIONAL SCENARIO ARCHITECTURE
============================================================

Design so an instructor scenario can eventually specify: influent, flow, permit, budget, energy target, allowed/forbidden technologies, site size, reliability target. Example: Design 10,000 m³/day WWTP, BOD < 20 mg/L, NH4-N < 3 mg/L, energy < 0.45 kWh/m³, budget constraint, no MBR. Grade: compliance, CAPEX, OPEX, energy, reliability, footprint, stability. Implement foundational data architecture even if instructor editor deferred.

============================================================
AI. SIMULATION COMPLEXITY / PERFORMANCE LIMIT
============================================================

NO CFD, finite-element structural analysis, full spatial ASM, or high-frequency transient hydraulic solvers. Lumped engineering models. Design calculations run primarily on design/equipment/network changes. Runtime process calculations stay lightweight for ordinary office laptops. Preserve performance-oriented rendering work.

============================================================
AJ. FILE/ARCHITECTURE REORGANIZATION
============================================================

Stop growing UnitProcessModels.ts forever. Gradually migrate toward modules like:

src/design/
  UnitBlueprint.ts, Geometry.ts, DesignValidator.ts, DesignCalculator.ts, CostEstimator.ts
  catalogs/ Materials.ts, Pumps.ts, Blowers.ts, Diffusers.ts, Membranes.ts, Motors.ts
src/sim/
  hydraulics/ PipeHydraulics.ts, PumpCurves.ts, HydraulicNetwork.ts
  processes/ ActivatedSludge.ts, Clarifier.ts, Equalization.ts, MBR.ts, ReverseOsmosis.ts, Disinfection.ts, SludgeTreatment.ts
  reliability/ EquipmentCondition.ts, Maintenance.ts

SimulationEngine remains network/process coordinator. PRESERVE good foundations: WaterQuality, mass-balance helpers, per-port stream architecture, gas/liquid separation, permit evaluator, topology validation. Don't unnecessarily rewrite stable systems. (Note: parts of this structure already exist from iter 0 — extend, don't duplicate.)

============================================================
AK. MIGRATION STRATEGY
============================================================

No reckless all-at-once rewrite leaving the game unplayable; also do not stop at documents. Implement a coherent vertical slice.

PHASE 1 / REQUIRED VERTICAL SLICE:
1. new design/runtime data model
2. custom rectangular geometry
3. CAS custom sizing
4. dynamic CAS MLSS/SRT
5. blower/equipment capacity
6. secondary clarifier custom sizing
7. custom pipe diameter/material
8. basic pipe headloss
9. real pump/system operating point
10. equalization dynamic storage
11. quantity-based CAPEX
12. Unit Designer UI
13. Show Calculation
14. dynamic influent
15. engineering warnings
16. updated campaign L1/L2 using these systems
17. tests

Then migrate: MBR, RO, A2O, DAF, sludge processes, advanced disinfection, energy systems. Unsupported processes may temporarily use compatibility adapters.

STATUS NOTE (2026-08-26): iter 0 landed much of the Phase-1 skeleton
(src/design/*, src/sim/hydraulics, src/sim/processes/{ActivatedSludge,
Clarifier,Equalization,Pumping}, UnitDesigner UI, PermitEngine
single-sourcing, eng-tests suite 42/46). Workers should AUDIT each Phase-1
item above against the actual code, finish/strengthen what is partial, and
start with the 4 failing eng-tests (legacy backlog #1).

============================================================
AL. DO NOT REGRESS EXISTING WORK
============================================================

Preserve working behavior unless directly replaced by a stronger model: mass conservation, per-port liquid routing, RAS/recycle semantics, gas stream separation, true-zero pathogen permits, objective correctness, river rendering, GTAO fix, night lighting, real shadows, performance autoscaling, traffic behavior, road terrain clearance, water VFX, terrain river palette, tool interaction, undo/redo, responsive HUD, tutorial functionality. No fake cone lighting or fake white texture lighting.

============================================================
AM. TESTING
============================================================

Extensive deterministic tests, at minimum:

GEOMETRY: volume from rectangular/circular dimensions; rotated custom footprint; port coordinates update with geometry.
CAS: HRT tracks volume; F/M responds correctly; blower undersizing causes oxygen limitation; more blower capacity improves available O2; actual DO ≠ blindly setpoint; WAS affects SRT; SRT affects nitrification; MLSS evolves over time; startup reactor doesn't instantly reach steady state.
CLARIFIER: SOR from Q/A; SLR from solids load/A; larger clarifier reduces loading; peak flow can overload; blanket/carryover response.
EQUALIZATION: water volume conservation; pollutant mass conservation; load spike attenuation; overflow at capacity.
PIPE: length from path; velocity from Q/D; headloss grows as diameter shrinks; grows with length; roughness affects headloss.
PUMP: pump/system intersection; no-duty-point failure; power equation; VFD behavior; undersized cannot meet flow.
CAPEX: bigger tanks cost more; material changes structural cost; equipment cost included; pipe size/length alters CAPEX.
MEMBRANE (if implemented): flux from Q/A; area requirement; fouling progression; TMP response.
PERMIT: one authoritative evaluator only.
UI: drag custom dimensions; live recalculation; invalid geometry warning; equipment selection; tool-state invariant; level reset; PFD graph correctness.

CI runs ALL tests.

============================================================
AN. PLAYER EXPERIENCE
============================================================

Not a spreadsheet with 3D background. World is the main workspace. Spatial engineering: drag tank size, see dimensions, route pipe, place pumps, see equipment, parallel trains, physical consequences. Side panels/modals for calculations. Beginner presets + contextual explanations. Students go deep; non-experts start from templates and learn why it works.

============================================================
AO. GAME DESIGN PRINCIPLE
============================================================

No universally optimal asset. Every meaningful choice trades off: larger tank (+stability +HRT −land −CAPEX); small pipe (+cheap −headloss −energy); high flux (+low CAPEX −fouling/cleaning/lifetime); redundancy (+reliability −CAPEX); high SRT (+nitrification −O2 demand −clarifier loading); high aeration (+O2 −electricity). Tycoon tension comes from balancing CAPEX, OPEX, land, energy, effluent quality, reliability, maintenance, stability, expansion.

============================================================
AP. FINAL GAME IDENTITY
============================================================

The player solves not "which predefined WWTP box to place" but "how should I engineer this facility under technical, financial, physical and operational constraints?" — a genuine WASTEWATER ENGINEERING TYCOON + PROCESS DESIGN SIMULATOR + EDUCATIONAL ENGINEERING GAME.

============================================================
AQ. REQUIRED COMPLETION REPORT
============================================================

Before editing: inspect current implementation; identify exact migration dependencies; run baseline tests/build. Then implement. At completion provide:
1. architecture changes
2. old systems replaced
3. compatibility systems retained
4. files created
5. files changed
6. engineering equations implemented
7. assumptions and units
8. gameplay consequences introduced
9. test coverage
10. npm test/test:all/build results
11. performance implications
12. remaining process families not yet migrated
13. any newly discovered bugs

Do not claim a feature is implemented if it is merely a UI slider without a physical/economic simulation consequence.
