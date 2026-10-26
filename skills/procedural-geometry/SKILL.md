---
name: procedural-geometry
description: Create realistic procedural Three.js geometry for large engineered environments. Use for trains, tracks, stations, buildings, bridges, pipes, infrastructure, vehicles, structures, and other 3D geometry generated from code.
---

# Procedural Geometry for Engineered Environments

Target: Three.js 0.186.1, WebGPU renderer (`three/webgpu`) and TSL node materials (`three/tsl`); WebGPU only, no WebGL fallback, no GLSL strings.

## Purpose

Create realistic, high-quality 3D geometry for engineered environments (vehicles, tracks, stations, buildings, bridges, pipes and infrastructure) using Three.js procedural geometry.

All geometry must be generated procedurally from JavaScript and Three.js geometry. Do not use GLB, GLTF, FBX, OBJ, CAD imports, downloaded meshes, or other pre-made 3D assets unless explicitly requested.

The objective is **believable manufactured geometry**, not generic "sci-fi" decoration and not low-poly abstraction.

The environment should feel like a functioning, enormous engineered place designed for humans.

---

# Core Modelling Vocabulary

Use these concepts deliberately when constructing geometry.

### Sweep

Carry a 2D profile along a path.

Use for:

* rails
* pipes
* cables
* handrails
* beams
* structural members
* conduits
* curved walls
* bridge members
* train body sections

Think:

`profile + path = swept solid`

---

### Loft

Transition smoothly between multiple cross-sections.

Use for:

* train noses
* aerodynamic bodies
* architectural transitions
* bridge supports
* tapered columns
* ducts
* tunnels
* structural transitions

Use enough intermediate sections to control curvature rather than forcing two extreme shapes to connect directly.

---

### Revolve

Rotate a profile around an axis.

Use for:

* wheels
* pipes
* bearings
* tanks
* columns
* lamps
* mechanical components
* circular architectural elements

Prefer accurate radial profiles over primitive cylinders when the silhouette matters.

---

### Extrude

Extend a 2D profile through space.

Use for:

* beams
* panels
* walls
* brackets
* signs
* structural plates
* architectural elements

---

### Fillet

Create a rounded transition between surfaces.

Use where manufactured parts would naturally have a radius.

Do not use arbitrary large fillets everywhere.

---

### Bevel / Chamfer

Cut or soften a sharp edge.

Manufactured objects almost never have mathematically perfect infinitely sharp edges.

Use small bevels on:

* structural panels
* doors
* train bodies
* machinery
* furniture
* containers
* architectural edges

The bevel should match the scale and manufacturing method of the object.

---

### Inset / Recess

Push a surface inward rather than placing another flat object on top.

Use for:

* windows
* doors
* vents
* access panels
* control panels
* lighting
* architectural openings
* train doors

Prefer physically recessed geometry over texture-like decoration.

---

### Shell

Give surfaces actual thickness.

Use for:

* walls
* roofs
* train bodies
* containers
* pipes
* ducts
* architectural panels

Do not represent substantial structures as infinitely thin planes unless the object genuinely requires it.

---

### Sweep Along the Ground's Curvature

Long structures follow the ground they are built on: a hillside, a viaduct's vertical curve, a ring station, a curved deck.

Whenever the ground is curved, construct roads, tracks, buildings, walls, pipes and other long structures relative to that curvature (sweep them along a guide curve) rather than treating the environment as an infinite flat plane.

Maintain consistent local orientation relative to the ground: "up" for each piece is the local surface normal, not a global axis.

---

### Panel Gap / Seam

Represent real manufactured separation between components.

Use for:

* train body panels
* containers
* buildings
* bridge components
* machinery
* access panels
* infrastructure

Do not use random decorative lines. Every seam should imply assembly, maintenance, expansion, movement or manufacturing.

---

### Curvature Continuity

Surfaces that are intended to be smooth should transition smoothly.

Avoid:

* sudden curvature changes
* visible kinks
* primitive intersections
* faceted transitions
* abrupt changes in surface normals

Prefer tangent-continuous or curvature-continuous transitions where appropriate.

---

### Hard-Surface Topology

Geometry should follow the physical construction of manufactured objects.

Topology should support:

* edges
* openings
* panel transitions
* curvature
* bevels
* structural connections

Do not simply subdivide a primitive until it looks smooth.

---

### Radial Profile

Define the actual cross-section of rotational components.

Use for:

* train wheels
* bearings
* axles
* pipes
* rollers
* structural rings
* mechanical components

A wheel should not automatically be represented as a cylinder.

---

### Edge Loops

Place geometry deliberately around:

* openings
* corners
* bevels
* panel transitions
* curved sections

Use geometry where it affects the form.

---

### Support Loops

Use additional geometry to control the sharpness of edges when smoothing or subdividing.

Do not add support geometry where it has no visual or structural purpose.

---

### Normal Continuity

Surfaces that physically form one continuous surface should shade continuously.

Use deliberate hard/soft edge decisions rather than relying on default smoothing.

---

### Silhouette Fidelity

Prioritize the outer silhouette above small details.

A model with excellent small details but incorrect proportions is a bad model.

Always prioritize:

1. silhouette
2. proportions
3. major surfaces
4. curvature
5. structural construction
6. functional components
7. small details

---

### Manufacturing Logic

If two surfaces meet on a real manufactured object, model the physical transition between them.

Do not simply intersect two primitives and assume the intersection is sufficient.

Ask:

* How would this be manufactured?
* How would it be assembled?
* Where would panels separate?
* Where would bolts or fasteners exist?
* Where would maintenance access be required?
* Where would structural loads travel?
* Where would expansion or movement occur?

The model should imply a believable construction process.

---

# Large Engineered Environments

A station, an industrial district, a city or a ship is one engineered system, not a collection of unrelated futuristic buildings.

Everything should appear to exist within a coherent infrastructure. It should have:

* transportation infrastructure
* structural infrastructure
* utilities
* maintenance access
* drainage
* ventilation
* power distribution
* water distribution
* communications
* emergency systems
* pedestrian infrastructure
* service infrastructure
* residential, commercial and industrial areas

Whenever appropriate, incorporate:

* utility corridors
* service ducts
* cable trays
* maintenance walkways
* inspection panels
* structural rings or frames
* expansion joints
* access hatches

Infrastructure should reinforce the scale of the place. It should feel as though thousands or millions of people could actually live or work there.

---

# Scale

Use real-world dimensions.

Prefer metres.

Maintain consistent scale between:

* people
* trains
* tracks
* doors
* stairs
* buildings
* roads
* pipes
* bridges
* vehicles
* structural members

Avoid arbitrary scale.

Whenever an object has an obvious human reference, use it.

Examples:

* door
* staircase
* handrail
* train door
* platform
* window
* container
* vehicle
* walkway

---

# Futuristic Does Not Mean Decorative

Avoid generic sci-fi design language such as:

* random glowing strips
* arbitrary circular details
* meaningless panels
* excessive greebles
* random antennas
* decorative pipes going nowhere
* impossible structures
* arbitrary neon
* unexplained mechanical components

Futuristic design should come primarily from:

* advanced manufacturing
* efficient structures
* modular construction
* sophisticated infrastructure
* compact machinery
* clean materials
* automation
* maintenance systems
* integrated utilities
* large-scale engineering

Technology should be implied by the construction.

---

# Structural Believability

Large structures must appear capable of supporting themselves.

For:

* bridges
* elevated tracks
* stations
* buildings
* platforms
* parapets
* towers
* large roofs

show believable structural paths.

Use:

* beams
* columns
* trusses
* braces
* support plates
* foundations
* joints
* expansion sections

Do not allow large structures to appear to float without explanation.

---

# Trains

Construct trains from major structural surfaces first.

Use:

* swept body profiles
* lofted nose sections
* curved roofs
* recessed windows
* recessed doors
* window seals
* panel seams
* underbody equipment
* bogies
* realistic wheels
* axles
* suspension
* brake components
* couplers
* roof equipment

Windows should follow the body curvature.

The nose should be constructed from controlled profiles rather than spheres or stacked boxes.

Wheels should use radial profiles.

Bogies should contain believable mechanical structure.

Prioritize the train's silhouette and proportions before small details.

---

# Railway Tracks

Construct tracks from actual railway components.

Include:

* rails
* sleepers
* fasteners
* ballast or engineered track bed
* support structure
* switches where appropriate
* drainage
* cable/conduit infrastructure

Rails should be generated using swept profiles.

Track geometry should follow the intended path.

On curved ground, account for the curvature and keep the track oriented to the local surface.

Do not represent rails as simple rectangular beams.

---

# Train Stations

Model stations as real infrastructure.

Consider:

* platforms
* platform edges
* structural roof
* columns
* stairs
* elevators
* escalators
* lighting
* signage
* barriers
* ventilation
* utilities
* maintenance access
* drainage
* emergency equipment

Large station roofs require believable structural support.

Use repeated modular components procedurally.

---

# Stairs

Stairs should be physically constructible.

Generate:

* individual treads or a coherent stair slab
* risers
* stringers
* supports
* landings
* handrails
* balustrades
* guardrails

Use real stair proportions.

Avoid simply creating a staircase from stacked boxes.

Handrails should generally be generated using sweeps along a path.

---

# Parapets and Guardrails

Use real structural construction.

Generate:

* parapet body
* coping
* posts
* rails
* mounting plates
* structural connections

For metal railings, use swept profiles.

Avoid infinitely thin planes.

---

# Houses and Residential Buildings

Residential architecture should appear modular and habitable.

Consider:

* walls
* floors
* roof
* windows
* doors
* balconies
* railings
* service access
* ventilation
* utilities
* drainage
* structural supports

Use repetition intelligently.

A residential district should have variation without appearing randomly generated.

Vary:

* dimensions
* balconies
* window arrangements
* materials
* facade modules
* roof equipment
* entrances

Maintain an underlying architectural system.

---

# Containers

Containers should feel manufactured.

Use:

* shell construction
* reinforced corners
* structural ribs
* doors
* hinges
* locking mechanisms
* panel seams
* handles
* mounting points

Do not make containers as simple boxes with decorative lines.

---

# Buildings

Construct buildings hierarchically.

### Primary structure

* foundations
* columns
* beams
* floors
* roof

### Secondary structure

* walls
* windows
* doors
* balconies
* stairs
* service areas

### Tertiary detail

* vents
* conduits
* lights
* signs
* panels
* access hatches

Do not start with tertiary detail.

---

# Pipes

Pipes should almost always use sweeps.

Generate:

* circular or custom profiles
* bends
* elbows
* joints
* flanges
* valves
* supports
* mounting brackets

Avoid sharp 90-degree changes unless the real system would use an actual elbow fitting.

Pipes should connect believable endpoints.

Avoid pipes that mysteriously terminate in mid-air.

See the `pipes` skill for sizes, supports and service colours.

---

# Wires and Cables

Use spline/sweep geometry.

Consider:

* sag
* tension
* attachment points
* cable bundles
* clamps
* conduits
* junction boxes

Cables should follow physically plausible paths.

Do not make every wire perfectly straight.

---

# Bridges

Model bridges as structural systems rather than flat platforms.

Consider:

* deck
* primary beams
* secondary beams
* supports
* expansion joints
* railings
* underside structure
* service conduits
* maintenance access

Use sweeps and extrusions for structural members.

Large unsupported spans require believable structural solutions.

---

# Bridge Supports

Use lofted or tapered profiles.

Consider:

* foundation
* shaft
* transition
* bearing
* connection to deck

Avoid simple cylinders unless the real structural concept calls for one.

---

# Repetition

Use procedural repetition for:

* windows
* sleepers
* bolts
* lights
* panels
* structural members
* railings
* pipes
* facade modules

Do not manually duplicate identical geometry. Draw repeated parts as `InstancedMesh` instances of one geometry.

However, introduce controlled variation where appropriate.

Perfect repetition everywhere can make the environment feel artificial.

---

# Geometry Quality

The generated geometry must:

* use BufferGeometry
* have valid positions
* have valid indices
* have correct normals
* avoid degenerate triangles
* avoid unnecessary geometry
* avoid accidental intersections
* avoid z-fighting
* avoid broken topology
* maintain consistent winding
* maintain consistent scale

Use flat shading where the physical surface should be faceted.

Use smooth shading where the physical surface should be smooth.

Do not use smooth shading to hide bad topology.

---

# Polygon Distribution

Spend polygons where they affect the image.

High polygon density is justified for:

* silhouettes
* curved bodywork
* close-up mechanical components
* wheels
* pipes with visible bends
* rounded corners

Low polygon density is acceptable for:

* hidden surfaces
* flat structural panels
* distant components
* simple internal geometry

Never equate polygon count with quality.

---

# Materials

Geometry and materials should remain conceptually separate.

Geometry should describe physical surfaces.

Materials should describe:

* painted metal
* bare metal
* aluminium
* glass
* rubber
* concrete
* ceramic
* plastic
* composite materials

Material boundaries should correspond to actual physical components.

---

# Scale-Aware Detail

Small details must make sense relative to the object's scale.

Do not add bolts that are too small to see.

Do not make panel gaps enormous.

Do not use identical bevel sizes on a train and a tiny electronic component.

Geometry should be proportional to the object.

---

# Procedural API

Prefer reusable procedural functions such as:

```js
createSweep();
createLoft();
createRevolve();
createExtrusion();
createRoundedBox();
createPipe();
createCable();
createRail();
createWheel();
createPanel();
createDoor();
createWindow();
createStair();
createHandrail();
createBeam();
createColumn();
createBracket();
createFlange();
createValve();
createBogie();
createTrainBody();
```

Build complex objects from these reusable concepts rather than writing unrelated geometry generators for every model.

A sweep, with its segment count as the level-of-detail knob:

```js
import * as THREE from 'three/webgpu';

// profile: THREE.Shape in the path's normal/binormal plane; path: a THREE.Curve
export function createSweep(profile, path, { steps = 64 } = {}) {
  const geo = new THREE.ExtrudeGeometry(profile, { steps, bevelEnabled: false, extrudePath: path });
  geo.computeVertexNormals();
  return geo;
}

// a rail head (simplified profile) along a gentle curve, 40 m long
const head = new THREE.Shape([[-0.035, 0], [0.035, 0], [0.035, 0.04], [0.02, 0.06], [-0.02, 0.06], [-0.035, 0.04]]
  .map(([x, y]) => new THREE.Vector2(x, y)));
const path = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(20, 0, 2), new THREE.Vector3(40, 0, 8)]);
const rail = new THREE.Mesh(createSweep(head, path, { steps: 80 }),
  new THREE.MeshStandardNodeMaterial({ color: 0x8a8d90, metalness: 0.9, roughness: 0.35 }));
```

---

# Model Hierarchy

Prefer meaningful groups:

```text
Train
├── Body
├── Windows
├── Doors
├── Bogies
│   ├── Wheels
│   ├── Axles
│   └── Suspension
├── RoofEquipment
└── Undercarriage
```

Objects should remain independently addressable where practical.

This allows later animation, replacement, LOD generation and material changes.

---

# Animation Readiness

Where appropriate, structure geometry so that obvious moving components can later be animated.

Examples:

* train doors
* wheels
* switches
* valves
* fans
* elevators
* station doors
* mechanical arms

Do not bake moving parts into a single inseparable mesh.

---

# LOD

If practical, generate different levels of detail from the same procedural definition.

The LOD system should reduce:

* segment counts
* small components
* hidden geometry
* tiny bevels

without changing the fundamental silhouette.

Never create separate unrelated models merely for LOD.

---

# Quality Priority

Always prioritize in this order:

1. Correct proportions
2. Silhouette
3. Large-scale curvature
4. Structural plausibility
5. Physical construction
6. Surface transitions
7. Major functional components
8. Material boundaries
9. Medium-scale details
10. Small details

Never sacrifice the first six merely to add more detail.

---

# Final Rule

Before adding another detail, ask:

**"Would this exist on the real object, and does its geometry explain why it exists?"**

If yes, model it.

If no, do not add it merely because it makes the object look more "sci-fi".

The target is:

**real engineering, imagined technology.**

Not:

**real-world object + random sci-fi decorations.**
