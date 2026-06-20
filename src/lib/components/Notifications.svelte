<script lang="ts">
  import { notifications } from '$lib/stores';
  import { CheckCircle2, AlertCircle, Info } from 'lucide-svelte';
  import { fly, fade } from 'svelte/transition';
</script>

<div class="fixed bottom-24 right-6 z-[100] flex flex-col gap-2 pointer-events-none">
  {#each $notifications as notification (notification.id)}
    <div 
      in:fly={{ y: 20, duration: 300 }} 
      out:fade={{ duration: 200 }}
      class="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl glass-panel border {notification.type === 'success' ? 'border-primary/30 bg-primary/5' : notification.type === 'error' ? 'border-red-500/30 bg-red-500/5' : 'border-white/10'} min-w-[250px] backdrop-blur-xl"
    >
      {#if notification.type === 'success'}
        <CheckCircle2 size={18} class="text-primary" />
      {:else if notification.type === 'error'}
        <AlertCircle size={18} class="text-red-500" />
      {:else}
        <Info size={18} class="text-blue-400" />
      {/if}
      <span class="text-sm font-medium text-white">{notification.message}</span>
    </div>
  {/each}
</div>
