<script lang="ts">
  import { equalizerBands } from '$lib/stores';
  
  const frequencies = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  
  function resetEq() {
    $equalizerBands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  }
  
  function setPreset(name: string) {
    if (name === 'bass') $equalizerBands = [6, 5, 4, 2, 0, -1, -2, -3, -4, -5];
    if (name === 'vocal') $equalizerBands = [-2, -1, 0, 2, 4, 5, 4, 2, 0, -2];
    if (name === 'electronic') $equalizerBands = [5, 4, 1, 0, -2, -1, 2, 4, 5, 6];
    if (name === 'rock') $equalizerBands = [4, 3, 2, 0, -1, -1, 1, 3, 4, 4];
    if (name === 'priora') $equalizerBands = [12, 12, 12, 12, 5, -12, -12, -12, -12, -12];
  }
</script>

<div class="w-full max-w-4xl mx-auto py-8 flex flex-col items-center perspective-[1000px]">
  <div class="w-full flex justify-between items-center mb-10">
    <h2 class="text-4xl font-extrabold drop-shadow-md">Эквалайзер</h2>
    <div class="flex gap-4">
      <button class="glass-button px-6 py-3 font-bold hover:text-white transition-all shadow-sm" on:click={() => setPreset('priora')}>Приора под окном</button>
      <button class="glass-button px-6 py-3 font-bold hover:text-white transition-all shadow-sm" on:click={() => setPreset('bass')}>Бас</button>
      <button class="glass-button px-6 py-3 font-bold hover:text-white transition-all shadow-sm" on:click={() => setPreset('electronic')}>Электроника</button>
      <button class="glass-button px-6 py-3 font-bold hover:text-white transition-all shadow-sm" on:click={() => setPreset('vocal')}>Вокал</button>
      <button class="px-6 py-3 rounded-2xl font-bold bg-red-500/20 hover:bg-red-500/40 text-red-200 transition-all shadow-sm interactive-item" on:click={resetEq}>Сброс</button>
    </div>
  </div>

  <div class="glass-panel p-10 w-full flex justify-between items-end h-[450px] shadow-2xl relative overflow-hidden">
    <!-- Subtle background effect -->
    <div class="absolute inset-0 bg-gradient-to-b from-transparent to-white/5 pointer-events-none"></div>

    {#each $equalizerBands as band, i}
      <div class="flex flex-col items-center h-full z-10 group/eq">
        <div class="text-[13px] font-bold text-white/70 mb-4 bg-white/5 px-2 py-1 rounded-md">{band > 0 ? '+' : ''}{band.toFixed(1)}</div>
        <div class="relative flex-1 w-14 flex justify-center group">
          <!-- Background track -->
          <div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-3 bg-black/40 rounded-full overflow-hidden shadow-inner border border-white/5">
            <!-- Dynamic Green Fill -->
            <div 
              class="absolute bottom-0 w-full bg-gradient-to-t from-primary/20 to-primary transition-all duration-[50ms]" 
              style="height: {(Number($equalizerBands[i]) + 12) / 24 * 100}%">
            </div>
          </div>
          
          <!-- Slider -->
          <input 
            type="range" 
            min="-12" 
            max="12" 
            step="0.1" 
            bind:value={$equalizerBands[i]}
            class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-14 -rotate-90 appearance-none bg-transparent cursor-pointer z-20 opacity-0"
          />
          
          <!-- Thumb visual -->
          <div class="absolute w-8 h-8 rounded-full bg-neutral-800 border-2 border-primary/50 shadow-[0_0_15px_var(--color-primary)] pointer-events-none transition-all duration-[50ms] left-1/2 -translate-x-1/2 flex items-center justify-center group-hover/eq:scale-110" style="bottom: calc({(Number($equalizerBands[i]) + 12) / 24 * 100}% - 16px)">
            <div class="w-3 h-3 bg-primary rounded-full shadow-inner"></div>
          </div>
        </div>
        <div class="text-[15px] font-extrabold mt-6 text-white/80">{frequencies[i]}</div>
      </div>
    {/each}
  </div>
</div>
