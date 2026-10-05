---
'@shumoku/core': patch
'@shumoku/renderer': patch
---

Keep straight-path and block-avoidance settings independent. A straight link stays straight in free space and receives a rounded detour only when a block obstructs it, including both halves of a paired continuation. Interactive and static SVG rendering honor the computed detour.
