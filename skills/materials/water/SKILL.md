---
name: water
description: Create realistic procedural water and wet surfaces with Three.js TSL on WebGPU. Use for lakes, rivers, reservoirs, canals, puddles, drainage, fountains and wet materials.
---

# Water

Target: Three.js 0.187.0, `three/webgpu` and TSL node materials from `three/tsl`; WebGPU only, no WebGL fallback, no GLSL strings.

## Water response

Think in terms of:

- reflection
- transmission/refraction
- Fresnel
- depth-dependent absorption
- roughness
- normal waves
- surface displacement
- ripples
- foam
- shoreline effects
- flow direction
- interaction with objects

Do not make all water bright blue.

## Scale-specific variants

Distinguish:

- large reservoir/lake water
- canal/river water
- shallow drainage
- puddles
- fountains
- wet concrete
- wet metal

Each has different wave scale, roughness, depth and reflection behaviour.

## Surface

Use layered wave scales:

- large gentle waves for silhouette and broad reflection
- medium waves for visible surface structure
- small normal-scale ripples for highlights

Do not use high-frequency displacement everywhere.

## Depth

Water should generally become visually deeper with depth. Use attenuation and colour response rather than a flat colour overlay.

## Foam

Place foam where physically plausible:

- shorelines
- obstacles
- strong flow
- turbulence
- waterfalls

Do not distribute foam uniformly.

## Wet surfaces

Wet concrete, rails and metal are not the same thing as standing water. For wet surfaces, primarily alter roughness/specular response and add subtle darkening/reflection rather than turning the entire surface transparent.
