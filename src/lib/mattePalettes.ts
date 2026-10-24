export const MATTE_PALETTES = [
  { id: 'graphite-rose', name: 'Графит и розовый', background: '#292929', primary: '#C88E9B', accent: '#E1AAB6' },
  { id: 'espresso-orange', name: 'Эспрессо и апельсин', background: '#24150F', primary: '#D96B27', accent: '#EEA16C' },
  { id: 'black-red', name: 'Чёрный и красный', background: '#080808', primary: '#C1121F', accent: '#F57781' },
  { id: 'electric-blue', name: 'Электрический синий', background: '#101A46', primary: '#245BFF', accent: '#A3BDFF' },
  { id: 'acid-black', name: 'Чёрный и лайм', background: '#0A0A0A', primary: '#B6FF00', accent: '#B6FF00' },
  { id: 'blue-yellow', name: 'Ультрамарин и жёлтый', background: '#101052', primary: '#2820CF', accent: '#F6FF00' }
] as const;
export type MattePaletteId = typeof MATTE_PALETTES[number]['id'];
export function mattePalette(id: unknown) { return MATTE_PALETTES.find(palette => palette.id === id) || MATTE_PALETTES[0]; }
