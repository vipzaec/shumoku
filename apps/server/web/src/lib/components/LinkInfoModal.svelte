<script lang="ts">
  import { ArrowsLeftRightIcon } from 'phosphor-svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import type { LinkSelectEvent } from './InteractiveSvgDiagram.svelte'

  interface Props {
    open: boolean
    linkData: LinkSelectEvent | null
  }

  let { open = $bindable(false), linkData = null }: Props = $props()
  let metadata = $derived(linkData?.link.metadata ?? {})
  let source = $derived(typeof metadata.source === 'string' ? metadata.source : undefined)
  let tenant = $derived(typeof metadata.tenant === 'string' ? metadata.tenant : undefined)
  let state = $derived(typeof metadata.state === 'string' ? metadata.state : undefined)
  let protocol = $derived(typeof metadata.protocol === 'string' ? metadata.protocol : undefined)
  let observed = $derived(linkData?.link.provenance?.observedAt)
</script>

<Dialog.Root {open} onOpenChange={(value) => (open = value)}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        <ArrowsLeftRightIcon size={18} />
        {linkData?.link.label || 'Connection'}
      </Dialog.Title>
    </Dialog.Header>

    {#if linkData}
      <div class="space-y-4 py-2 text-sm">
        <div class="grid grid-cols-[80px_1fr] gap-x-3 gap-y-2">
          <span class="text-theme-text-muted">From</span>
          <span>{linkData.link.from.label}{linkData.link.from.port ? ` · ${linkData.link.from.port}` : ''}</span>
          <span class="text-theme-text-muted">To</span>
          <span>{linkData.link.to.label}{linkData.link.to.port ? ` · ${linkData.link.to.port}` : ''}</span>
          {#if linkData.link.vlan?.length}
            <span class="text-theme-text-muted">VLAN</span>
            <span>{linkData.link.vlan.join(', ')}</span>
          {/if}
          {#if protocol}
            <span class="text-theme-text-muted">Protocol</span><span>{protocol}</span>
          {/if}
          {#if state}
            <span class="text-theme-text-muted">State</span><span>{state}</span>
          {/if}
        </div>

        <div class="rounded-lg bg-muted/30 p-3 grid grid-cols-[80px_1fr] gap-x-3 gap-y-2 text-xs">
          <span class="text-theme-text-muted">Source</span>
          <span>{source ?? linkData.link.provenance?.source ?? 'Topology definition'}</span>
          {#if tenant}
            <span class="text-theme-text-muted">Tenant</span><span>{tenant}</span>
          {/if}
          {#if observed}
            <span class="text-theme-text-muted">Observed</span>
            <span>{new Date(observed).toLocaleString()}</span>
          {/if}
          <span class="text-theme-text-muted">ID</span>
          <span class="font-mono break-all">{linkData.link.id}</span>
        </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
