// LomifyNEXT Soundprint Generator
// Analyzes liked tracks to generate a unique visual "aura" or "tint" for the background.

export interface Soundprint {
    tint: string[];
    energy: number;
    accentGlow: string;
    hasData: boolean;
}

// A simple deterministic color generator based on artist/title strings
function hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return hash;
}

function colorFromHash(hash: number): string {
    const r = (hash & 0xFF0000) >> 16;
    const g = (hash & 0x00FF00) >> 8;
    const b = hash & 0x0000FF;
    // Keep it bright and saturated for the "aura" effect
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (l < 100) return `rgb(${r + 100}, ${g + 100}, ${b + 100})`;
    return `rgb(${r}, ${g}, ${b})`;
}

export function generateSoundprint(tracks: any[]): Soundprint {
    if (!tracks || tracks.length === 0) {
        return {
            tint: ['rgb(100, 50, 150)', 'rgb(50, 100, 200)'],
            energy: 0.5,
            accentGlow: 'rgba(100, 50, 150, 0.32)',
            hasData: false
        };
    }

    // Top 3 tracks define the colors
    const topTracks = tracks.slice(0, 3);
    const tint = topTracks.map(t => colorFromHash(hashString(t.artist || t.title)));
    
    // Ensure we have at least 2 colors for a gradient
    if (tint.length === 1) tint.push(colorFromHash(hashString(topTracks[0].title + "mix")));

    const primaryColor = tint[0].replace('rgb(', '').replace(')', '');
    
    return {
        tint,
        energy: 0.8,
        accentGlow: `rgba(${primaryColor}, 0.4)`,
        hasData: true
    };
}
