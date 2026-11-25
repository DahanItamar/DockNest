// One small store for the toast stack, so any part of the app (the update gate, the page notices, the poll) can raise a
// toast without a provider. The list logic lives in model.js.
import { useSyncExternalStore } from 'react';
import { pushToast, dismissToast } from './model.js';

let list = [];
const listeners = new Set();
const set = next => { if (next !== list) { list = next; for (const listener of listeners) listener(); } };
export const toasts = {
  push: toast => set(pushToast(list, toast)),
  dismiss: key => set(dismissToast(list, key)),
  clear: () => set([]),
  get: () => list,
  subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
};
export const useToasts = () => useSyncExternalStore(toasts.subscribe, toasts.get, toasts.get);
