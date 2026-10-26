# Modelling vocabulary

Reference for the `procedural-geometry` skill: the named operations every built thing is made of, when each applies and what it must produce. Read before constructing new geometry.

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

