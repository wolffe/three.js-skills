# Skills guide

How the 26 skills in `skills/` relate, which one to load for a given request, and how
they combine. The catalog README has the full table with one line per skill; this file
is for choosing.

## Shape of the catalog

Three parents, each with children, plus standalone kits:

```
threejs-director                 routes any request to the skills below
├── tsl-materials                parent for every material
│   ├── glass
│   ├── metal
│   ├── paint
│   ├── rust
│   ├── water                    principles; ocean-water is the implementation
│   ├── material-composition
│   └── interior-mapping         ships windowMaterial.tsl.js
├── procedural-geometry          parent for every built thing; references/ holds the vocabulary and object catalogue
│   ├── pipes                    ships pipe-rack.js
│   └── signage
├── engineered-environments      parent for every large place
│   ├── station-maglev
│   └── megacity
├── character-kit                parent for the player
│   ├── character-walking        ships walking-controller.js
│   ├── character-camera         ships character-camera.js
│   ├── character-model          ships character-model.js
│   └── character-input          ships character-input.js
└── outdoor kits                 standalone, each ships its source
    ├── photo-sky                photo-sky.tsl.js, convert-sky.html, convert-sky.mjs
    ├── snow-weather             blizzard.tsl.js, weather-spells.js
    ├── card-grass               card-grass.tsl.js, make-atlas.md
    ├── ocean-water              ocean.tsl.js, planar-reflection.js
    ├── far-shade                far-shade.tsl.js
    └── jolt-driving             jolt-world.js, jolt-vehicle.js, jolt-towing.js
```

A parent is read before its children. A child can be used alone when the request is
narrow (one material, one camera), but the parent holds the measurements and the
vocabulary the child assumes.

## Decision trees

### "I need a material"

```
Is it one object with several surfaces (a vehicle, a machine)?
├── yes → material-composition, then one child per surface
└── no  → which surface?
    ├── transparent (window, canopy, porthole, bottle)    → glass
    ├── metal, bare or finished                            → metal (+ rust if aged)
    ├── painted, coated, livery                            → paint (+ rust if chipped)
    ├── corroded, weathered steel                          → rust (over metal or paint)
    ├── water, wet ground, puddles                         → water (see next tree)
    ├── a building window seen from outside                → interior-mapping (+ glass)
    └── anything else (plastic, concrete, fabric)          → tsl-materials alone
```

### "I need water"

```
How big, and does it reflect the scene?
├── open sea, coast, a lake that must mirror the scene   → ocean-water (read water first)
├── ice, wet floor, a single-layer puddle reflection     → ocean-water (PlanarReflection only)
└── small, no scene reflection (pond, canal, fountain)   → water
```

### "I need geometry"

```
What is being built?
├── a station, platform, guideway, rail                  → station-maglev
├── a city block, towers, podiums, districts             → megacity
├── pipes, ducts, conduits, cable trays                  → pipes
├── signs, markings, labels, decals                      → signage
└── anything else built (train, bridge, house, stairs)   → procedural-geometry
Is it part of a larger working place?
└── yes → engineered-environments first, for the hierarchy and the ground
```

### "I need a player"

```
What is the player?
├── on foot, first or third person                       → character-kit (all four children)
│   ├── only the movement                                → character-walking
│   ├── only the camera                                  → character-camera
│   ├── only the body                                    → character-model
│   └── only the keys and mouse                          → character-input
└── in a vehicle                                         → jolt-driving
Both? Build one Jolt world with jolt-driving and pass it to the character adapter.
```

### "I need an outdoor scene"

```
In this order, taking only what the scene needs:
1. photo-sky        the sky, sun direction and cloud state everything else reads
2. far-shade        if the terrain is large and streamed
3. card-grass       if there is open ground seen from a road or on foot
4. ocean-water      if there is sea or a reflective lake
5. snow-weather     if weather changes or it snows or rains
6. jolt-driving     if there is a vehicle
```

## Combining skills

The director skill fixes the order: place and scale, ground and sky, geometry,
materials, facades and cover, weather, then player and vehicles. The reason is that each
stage leaves something the next needs: the sky lights the geometry, the geometry
receives the materials, the finished geometry becomes the physics colliders.

Pairs that are always loaded together:

| Load | With |
| --- | --- |
| any material child | `tsl-materials` |
| `ocean-water` | `water` |
| `station-maglev` or `megacity` | `procedural-geometry`, `engineered-environments` |
| `pipes` | `metal`, `paint` |
| `interior-mapping` on a near facade | `glass` |
| `snow-weather` | `photo-sky` |
| any `character-*` child used alone | the interface section of `character-kit` |

Pairs that need a decision before both are loaded:

| Pair | Decide |
| --- | --- |
| `character-kit` + `jolt-driving` | one Jolt build and one world; the kits were written against different Jolt releases |
| `water` + `ocean-water` | whether the water needs to reflect the scene |
| `glass` + `interior-mapping` | whether the window is close enough to need a real pane |

## Shipped source files

Fourteen skills ship a `.js` file beside the instructions. They import only
`three/webgpu`, `three/tsl` and, for the two physics kits, `jolt-physics`. Copy the file
into the project; do not import it from the skill folder. Each file's first comment says
what it exports and what the caller must supply (a height function, a surface type, a
layer whitelist).

How far each has been run is in the README under "How much has been run". The first
use of any kit in a project should be a headless render.

## Measurements

The catalog is built on one ruler, from the character kit. Keep level geometry on it and
everything reads at the right scale from the first run.

| Quantity | Value |
| --- | --- |
| standing height | 1.8 m |
| door | 2.1 m |
| step riser | 0.17 m |
| handrail | 0.9 m |
| capsule radius | 0.35 m |
| walk / run speed | 4 / 7 m/s |
| coordinates | metres, +Y up |
