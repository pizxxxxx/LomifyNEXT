import { settings } from '$lib/stores';
import { get } from 'svelte/store';

export function gibberish(node: HTMLElement) {
  let isGibberish = get(settings).gibberishMode;
  let originalTexts = new WeakMap<Node, string>();
  const gibberishWords = ['ывавылаывоапа', 'ывывоалдываор', 'ывлдаоыдвраун', 'ывпар', 'оыва', 'рыов', 'рыаыуцы', 'ыы', 'ы'];

  function makeGibberish(text: string) {
    return text.replace(/[а-яА-Яa-zA-Z0-9_]+/g, (match) => {
       let hash = 0;
       for (let i = 0; i < match.length; i++) hash = match.charCodeAt(i) + ((hash << 5) - hash);
       return gibberishWords[Math.abs(hash) % gibberishWords.length];
    });
  }

  function processNode(n: Node) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = n.textContent;
      if (text && text.trim().length > 0) {
        if (!originalTexts.has(n)) {
          originalTexts.set(n, text);
        }
        if (isGibberish) {
          n.textContent = makeGibberish(originalTexts.get(n)!);
        } else {
          n.textContent = originalTexts.get(n)!;
        }
      }
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      // Skip certain elements
      if (['SCRIPT', 'STYLE', 'INPUT', 'TEXTAREA'].includes(el.tagName)) return;
      
      // Preserve SVG inside players etc, but text might be inside
      n.childNodes.forEach(processNode);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!isGibberish) return;
    
    // Disconnect temporarily to avoid infinite loops from our own modifications
    observer.disconnect();
    
    mutations.forEach(m => {
      if (m.type === 'childList') {
        m.addedNodes.forEach(processNode);
      } else if (m.type === 'characterData') {
        const text = m.target.textContent;
        if (text && !gibberishWords.some(w => text.includes(w))) {
           originalTexts.set(m.target, text);
           m.target.textContent = makeGibberish(text);
        }
      }
    });
    
    observer.observe(node, { childList: true, subtree: true, characterData: true });
  });

  const unsubscribe = settings.subscribe($s => {
    if ($s.gibberishMode !== isGibberish) {
      isGibberish = $s.gibberishMode;
      observer.disconnect();
      processNode(node);
      if (isGibberish) {
         observer.observe(node, { childList: true, subtree: true, characterData: true });
      }
    }
  });

  if (isGibberish) {
    processNode(node);
    observer.observe(node, { childList: true, subtree: true, characterData: true });
  }

  return {
    destroy() {
      unsubscribe();
      observer.disconnect();
    }
  };
}
