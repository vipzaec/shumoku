import { darkTheme, type NetworkGraph } from '@shumoku/core'
import { describe, expect, it } from 'vitest'
import { prepareRender, renderEmbeddable, renderGraphToSvg, renderSvg } from './pipeline.js'

const graph: NetworkGraph = {
  version: '1',
  name: 'SVG pipeline',
  nodes: [{ id: 'node', label: 'Node' }],
  links: [],
}

describe('canonical SVG pipeline', () => {
  it('uses the canonical renderer from the graph convenience API', async () => {
    const svg = await renderGraphToSvg(graph, { theme: darkTheme })

    expect(svg).toContain('style="background: transparent;"')
    expect(svg).toContain(darkTheme.colors.textSecondary)
  })

  it('uses the canonical renderer for prepared and embeddable resolved layouts', async () => {
    const prepared = await prepareRender(graph)

    expect(await renderSvg(prepared)).toContain('style="background: transparent;"')
    expect(renderEmbeddable(prepared).svg).toContain('style="background: transparent;"')
  })

  it('includes moved continuation markers in embeddable fit bounds', async () => {
    const prepared = await prepareRender({
      version: '1',
      name: 'Moved continuation',
      nodes: [
        { id: 'source', label: 'Source' },
        { id: 'destination', label: 'Destination' },
      ],
      links: [
        {
          id: 'link',
          from: { node: 'source' },
          to: { node: 'destination' },
          metadata: {
            continuation: {
              enabled: true,
              label: 'LAN-42',
              source: { x: -1000, y: -800 },
              destination: { x: 1000, y: 800 },
            },
          },
        },
      ],
    })
    const embedded = renderEmbeddable(prepared)
    const svgViewBox = embedded.svg
      .match(/viewBox="([^"]+)"/)?.[1]
      .split(' ')
      .map(Number)

    expect(svgViewBox).toBeDefined()
    expect(embedded.viewBox.x).toBeLessThanOrEqual(-1036)
    expect(embedded.viewBox.y).toBeLessThanOrEqual(-812)
    expect(embedded.viewBox.x - 10).toBe(svgViewBox?.[0])
    expect(embedded.viewBox.y - 10).toBe(svgViewBox?.[1])
    expect(embedded.viewBox.width + 20).toBe(svgViewBox?.[2])
    expect(embedded.viewBox.height + 20).toBe(svgViewBox?.[3])
  })
})
