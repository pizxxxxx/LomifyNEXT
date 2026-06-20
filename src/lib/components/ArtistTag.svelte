<script lang="ts">
  export let artist: string;
</script>

<div class="flex items-center gap-1.5 min-w-0 w-full">
  <span class="truncate">{artist}</span>
  {#if ['klimentos', 'uniquebleed', 'bleed'].includes(artist.toLowerCase())}
    <span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 whitespace-nowrap shrink-0 border border-orange-500/30 leading-none shadow-[0_0_8px_rgba(249,115,22,0.2)]">
      Team Lomify
    </span>
  {/if}
  {#if ['pizxx'].includes(artist.toLowerCase())}
    <span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 whitespace-nowrap shrink-0 border border-green-500/30 leading-none shadow-[0_0_8px_rgba(34,197,94,0.2)]">
      Developer
    </span>
  {/if}
</div>
