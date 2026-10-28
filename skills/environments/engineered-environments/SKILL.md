---
name: engineered-environments
description: Lay out believable large engineered environments in Three.js, as systems rather than props. Use for streets, railways, stations, buildings, bridges, utilities, industrial districts, ships and any place where infrastructure has to read as working.
---

# Engineered Environments

Target: Three.js 0.186.1, WebGPU renderer (`three/webgpu`) and TSL node materials (`three/tsl`); no WebGL fallback, no GLSL.

Create a coherent engineered place, not a collection of disconnected props.

## Core idea

Everything exists because people live, travel, work, maintain and repair the place.

Think in systems:

- transport
- pedestrian circulation
- utilities
- power
- water
- waste
- ventilation
- communications
- emergency access
- maintenance
- structural support
- habitation
- commerce
- industry

## Ground and orientation

The ground is the local reference for everything built on it. When creating long structures, decide whether each should follow:

- the ground's own surface (a road, a wall, a pipe along a floor)
- a straight local tangent (a beam, a bridge span, a rail that must stay flat)
- a structural direction (a column, a mast, a hanger)
- an independent suspended structure (a cable, a gantry, a roof)

Do not flatten everything to one plane, and do not bend everything to the ground. A straight span over curved or uneven ground needs supports where it leaves the ground; a structure that follows the ground needs its pieces oriented to the local surface normal, not to a world axis.

Build in the environment's own coordinates (along, across, height) and convert to world space once, when placing. For thousands of repeated objects, compose the same basis into `InstancedMesh` matrices instead of placing separate objects.

## Infrastructure hierarchy

Large infrastructure should have:

1. primary structure
2. secondary structure
3. services
4. access/maintenance
5. visual details

For example, a bridge needs its structural members before cables, lights and signs.

## Human scale

Use doors, people, trains, stairs, handrails and vehicles as scale references.

Infrastructure should support plausible human movement.

## Futuristic design

Prefer:

- modular construction
- clean structural systems
- integrated utilities
- compact machinery
- automated maintenance
- advanced materials
- efficient space usage

Avoid generic sci-fi decoration.

## Repetition and variation

Use procedural repetition for modules, windows, railings, lights, sleepers, panels and structural members.

Introduce controlled variation so large areas do not look copy-pasted.

## Environmental storytelling

Objects should reveal function. A service hatch implies maintenance. A cable tray implies distribution. A drainage channel implies water management. A ventilation duct implies air handling.

Use these cues to make the place believable without filling every surface with detail.
