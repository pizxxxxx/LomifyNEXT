<script lang="ts">
  import type { Soundprint } from '$lib/utils/soundprint';
  
  export let sound: Soundprint;

  // Background gradient based on Soundprint tint
  $: bgStyle = `
    background: radial-gradient(circle at 50% 10%, ${sound.tint[0]} 0%, transparent 50%),
                radial-gradient(circle at 80% 80%, ${sound.tint[1] || sound.tint[0]} 0%, transparent 50%),
                radial-gradient(circle at 10% 90%, ${sound.tint[2] || sound.tint[0]} 0%, transparent 40%);
    background-color: #050505;
    opacity: 0.6;
    filter: blur(80px);
  `;
</script>

<div class="relative w-full min-h-full overflow-hidden">
  <!-- Dynamic Atmosphere / Wave overlay -->
  <div class="absolute inset-0 pointer-events-none z-0 transition-all duration-1000 ease-in-out" style={bgStyle}></div>
  
  <!-- Content wrapper -->
  <div class="relative z-10 w-full h-full pb-24">
    <slot />
  </div>
</div>

<style>
  /* Base animations for the "wave" / "river" feel */
  @keyframes riv-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  
  @keyframes riv-drift {
    from { transform: translateY(0px) rotate(0deg); }
    to { transform: translateY(-20px) rotate(2deg); }
  }
</style>
