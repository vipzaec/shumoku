<script lang="ts">
  /**
   * HighlightOverlay — adds `.node-highlighted` (and optionally
   * `.node-dimmed` on peers) to matching nodes. Also supports
   * attribute-based matching ('show all L3 switches').
   *
   * Exposes both a reactive prop-driven API (pass `highlightedIds` /
   * `attributeMatch` in) and an imperative handle (`bind:this`) so
   * event-driven callers (dashboard widget events) can call
   * `.applyIds(...)` / `.applyAttribute(...)` / `.clear()` directly.
   */

  interface AttributeMatch {
    key: string
    value: string
  }

  interface Props {
    svgElement: SVGSVGElement | null
    /** Reactive highlight state. Setting this re-applies. */
    highlightedIds?: ReadonlySet<string> | string[]
    highlightedLinkIds?: ReadonlySet<string> | string[]
    /** Reactive attribute match — wins over `highlightedIds` if both set. */
    attributeMatch?: AttributeMatch
    /** Dim non-highlighted nodes + links when something is highlighted. */
    dimOthers?: boolean
    /** Color applied via `--highlight-color` CSS variable. */
    highlightColor?: string
    /** Pulse animation on matched nodes. Default: true. */
    pulseAnimation?: boolean
  }

  let {
    svgElement,
    highlightedIds,
    highlightedLinkIds,
    attributeMatch,
    dimOthers = false,
    highlightColor,
    pulseAnimation = true,
  }: Props = $props()

  function clear(svg: SVGSVGElement) {
    for (const el of svg.querySelectorAll('.node-highlighted')) {
      el.classList.remove('node-highlighted')
    }
    for (const el of svg.querySelectorAll('.node-dimmed')) {
      el.classList.remove('node-dimmed')
    }
    for (const el of svg.querySelectorAll('.link-highlighted')) {
      el.classList.remove('link-highlighted')
    }
  }

  function applyPath(
    svg: SVGSVGElement,
    nodeIds: ReadonlySet<string>,
    linkIds: ReadonlySet<string>,
  ): void {
    clear(svg)
    if (nodeIds.size === 0 && linkIds.size === 0) return
    for (const node of svg.querySelectorAll('g.node[data-id]')) {
      const id = node.getAttribute('data-id')
      node.classList.toggle('node-highlighted', Boolean(id && nodeIds.has(id)))
      if (dimOthers) node.classList.toggle('node-dimmed', !id || !nodeIds.has(id))
    }
    for (const link of svg.querySelectorAll('g.link-group[data-link-id]')) {
      const id = link.getAttribute('data-link-id')
      link.classList.toggle('link-highlighted', Boolean(id && linkIds.has(id)))
      if (dimOthers) link.classList.toggle('node-dimmed', !id || !linkIds.has(id))
    }
  }

  function applyIds(svg: SVGSVGElement, ids: ReadonlySet<string>): void {
    clear(svg)
    if (ids.size === 0) return
    for (const node of svg.querySelectorAll('g.node[data-id]')) {
      const id = node.getAttribute('data-id')
      if (id && ids.has(id)) {
        node.classList.add('node-highlighted')
      } else if (dimOthers) {
        node.classList.add('node-dimmed')
      }
    }
    if (dimOthers) {
      for (const link of svg.querySelectorAll('g.link-group[data-link-id]')) {
        link.classList.add('node-dimmed')
      }
    }
  }

  function applyAttribute(svg: SVGSVGElement, key: string, value: string): void {
    clear(svg)
    let matched = 0
    for (const node of svg.querySelectorAll('g.node[data-id]')) {
      if (node.getAttribute(key) === value) {
        node.classList.add('node-highlighted')
        matched++
      } else if (dimOthers) {
        node.classList.add('node-dimmed')
      }
    }
    if (matched > 0 && dimOthers) {
      for (const link of svg.querySelectorAll('g.link-group[data-link-id]')) {
        link.classList.add('node-dimmed')
      }
    }
  }

  // Imperative handle for event-driven consumers
  export function apply(ids: Iterable<string>): void {
    if (!svgElement) return
    applyIds(svgElement, new Set(ids))
  }
  export function applyByAttribute(key: string, value: string): void {
    if (!svgElement) return
    applyAttribute(svgElement, key, value)
  }
  export function clearHighlight(): void {
    if (svgElement) clear(svgElement)
  }

  // Reactive prop-driven path
  $effect(() => {
    if (!svgElement) return
    const svg = svgElement

    // `--highlight-color` is picked up by CSS rules on the host
    // container. Scope it to the SVG so the caller doesn't have to
    // wire it up themselves.
    if (highlightColor) {
      svg.style.setProperty('--highlight-color', highlightColor)
    } else {
      svg.style.removeProperty('--highlight-color')
    }
    svg.style.setProperty('--highlight-pulse', pulseAnimation ? 'node-pulse' : 'none')

    if (attributeMatch) {
      applyAttribute(svg, attributeMatch.key, attributeMatch.value)
      return
    }
    if (highlightedIds || highlightedLinkIds) {
      const set = highlightedIds instanceof Set ? highlightedIds : new Set(highlightedIds ?? [])
      const linkSet =
        highlightedLinkIds instanceof Set
          ? highlightedLinkIds
          : new Set(highlightedLinkIds ?? [])
      applyPath(svg, set, linkSet)
      return
    }
    clear(svg)
  })

  $effect(() => {
    // Capture the svg reference at effect-run time. Reading the prop
    // in the teardown can throw if the parent's snippet context has
    // already been torn down (the prop getter dereferences a now-null
    // context). An unhandled error during navigation teardown causes
    // SvelteKit to fall back to a full page reload.
    const svg = svgElement
    return () => {
      if (svg?.isConnected) clear(svg)
    }
  })
</script>

<!-- Highlight styling is co-located so any consumer of this overlay
     gets the visuals automatically. `--highlight-color` and
     `--highlight-pulse` are set reactively above. -->
<svelte:head>
  {@html `<style id="shumoku-highlight-css">
    g.node.node-highlighted {
      animation: var(--highlight-pulse, node-pulse) 0.5s ease-in-out infinite alternate;
    }
    g.node.node-highlighted rect,
    g.node.node-highlighted circle,
    g.node.node-highlighted path {
      stroke: var(--highlight-color, #f59e0b) !important;
      stroke-width: 3px !important;
      filter: drop-shadow(0 0 8px color-mix(in srgb, var(--highlight-color, #f59e0b) 60%, transparent));
    }
    g.link-group.link-highlighted path:not(.edge-hit-area) {
      stroke: var(--highlight-color, #f59e0b) !important;
      stroke-width: 5px !important;
      opacity: 1 !important;
      filter: drop-shadow(0 0 5px color-mix(in srgb, var(--highlight-color, #f59e0b) 55%, transparent));
    }
    g.node.node-dimmed,
    g.link-group.node-dimmed {
      opacity: 0.15;
      transition: opacity 0.2s ease;
    }
    @keyframes node-pulse { from { opacity: 1; } to { opacity: 0.7; } }
  </style>`}
</svelte:head>
