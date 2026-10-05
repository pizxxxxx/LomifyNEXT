import test from 'node:test';
import assert from 'node:assert/strict';
import { pointerMissed, trackPointerActions } from './hitGuard.ts';

class Button {
  isConnected = true;
  parentElement = null;
  box = { left: 10, right: 40, top: 10, bottom: 40, width: 30, height: 30 };
  style = { opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' };
  closest() { return this; }
  matches() { return false; }
  getBoundingClientRect() { return this.box; }
}
globalThis.Element = Button;
globalThis.getComputedStyle = node => node.style;
const listeners = new Map();
globalThis.window = {
  addEventListener: (type, fn) => listeners.set(type, fn),
  removeEventListener: type => listeners.delete(type)
};
function event(target, overrides = {}) {
  return { target, button: 0, detail: 1, clientX: 20, clientY: 20, blocked: false,
    preventDefault() { this.blocked = true; }, stopImmediatePropagation() { this.blocked = true; }, ...overrides };
}
function activate(down, click) {
  const cleanup = trackPointerActions();
  if (down) listeners.get('pointerdown')(down);
  listeners.get('click')(click);
  cleanup();
  return click.blocked;
}

test('ordinary clicks and keyboard activation still work', () => {
  const button = new Button();
  assert.equal(activate(event(button), event(button)), false);
  assert.equal(activate(null, event(button, { detail: 0, clientX: 0, clientY: 0 })), false);
});

test('a stale hit target and an action revealed after pointerdown cannot remove a track', () => {
  const button = new Button();
  assert.equal(activate(event(button, { clientX: 100 }), event(button)), true);
  const cleanup = trackPointerActions();
  const panel = new Button(); panel.style.opacity = '0'; button.parentElement = panel;
  listeners.get('pointerdown')(event(button));
  panel.style.opacity = '1';
  const click = event(button); listeners.get('click')(click);
  assert.equal(click.blocked, true);
  cleanup();
});

test('removing or moving a card during the gesture blocks the replacement action', () => {
  const first = new Button(), replacement = new Button();
  assert.equal(activate(event(first), event(replacement)), true);
  const cleanup = trackPointerActions();
  listeners.get('pointerdown')(event(first));
  first.box = { left: 100, right: 130, top: 10, bottom: 40, width: 30, height: 30 };
  const click = event(first); listeners.get('click')(click);
  assert.equal(click.blocked, true);
  cleanup();
  first.box.width = 0;
  assert.equal(pointerMissed(event(first), first), true);
});
