# Object catalogue

Reference for the `procedural-geometry` skill: per-object rules. Read the section for the thing being built; each says which surfaces come first, what must be present and what to avoid.

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

