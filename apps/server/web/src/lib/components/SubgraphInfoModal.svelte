<script lang="ts">
  import { ArrowSquareOutIcon, GraphIcon } from 'phosphor-svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import type { SubgraphSelectEvent } from './InteractiveSvgDiagram.svelte'

  interface Props {
    open: boolean
    subgraphData: SubgraphSelectEvent | null
    onDrillDown?: (subgraphId: string) => void
  }

  let { open = $bindable(false), subgraphData = null, onDrillDown }: Props = $props()
  let sources = $derived(
    [...new Set(subgraphData?.subgraph.members.map((member) => member.source).filter(Boolean) ?? [])],
  )

  function handleClose() {
    open = false
  }

  function handleDrillDown() {
    if (subgraphData?.subgraph.id && onDrillDown) {
      onDrillDown(subgraphData.subgraph.id)
      open = false
    }
  }
</script>

<Dialog.Root {open} onOpenChange={(isOpen) => { if (!isOpen) handleClose() }}>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <GraphIcon size={18} />
        {subgraphData?.subgraph.label || 'Subgraph'}
      </Dialog.Title>
    </Dialog.Header>

    {#if subgraphData}
      <div class="space-y-3 py-2">
        <div class="grid grid-cols-2 gap-3 text-sm">
          <div class="text-theme-text-muted">ID</div>
          <div class="text-theme-text font-mono text-xs">{subgraphData.subgraph.id}</div>

          <div class="text-theme-text-muted">Nodes</div>
          <div class="text-theme-text">{subgraphData.subgraph.nodeCount}</div>

          <div class="text-theme-text-muted">Links</div>
          <div class="text-theme-text">{subgraphData.subgraph.linkCount}</div>

          {#if subgraphData.subgraph.parent}
            <div class="text-theme-text-muted">Parent</div>
            <div class="text-theme-text font-mono text-xs break-all">{subgraphData.subgraph.parent}</div>
          {/if}

          {#if sources.length > 0}
            <div class="text-theme-text-muted">Sources</div>
            <div class="text-theme-text">{sources.join(', ')}</div>
          {/if}
        </div>

        {#if subgraphData.subgraph.members.length > 0}
          <details class="pt-2 border-t border-theme-border">
            <summary class="text-xs font-medium cursor-pointer">
              Members ({subgraphData.subgraph.members.length})
            </summary>
            <div class="mt-2 max-h-48 overflow-y-auto divide-y divide-theme-border">
              {#each subgraphData.subgraph.members as member}
                <div class="py-1.5 flex items-start justify-between gap-3 text-xs">
                  <span>{member.label}</span>
                  <span class="text-theme-text-muted text-right">{member.role ?? member.source ?? ''}</span>
                </div>
              {/each}
            </div>
          </details>
        {/if}

        {#if subgraphData.subgraph.canDrillDown}
          <div class="pt-2 border-t border-theme-border">
            <Button variant="outline" size="sm" class="w-full" onclick={handleDrillDown}>
              <ArrowSquareOutIcon size={14} class="mr-1.5" />
              詳細を見る
            </Button>
          </div>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
