// Re-export the canonical settings store from $lib/stores.
// This file previously declared a duplicate, incompatible store with TODO stubs.
// It is kept as a thin compatibility shim in case any module still imports from here.
export { settings, initStore } from './stores';
