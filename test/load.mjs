// Load the extension's classic scripts into a sandbox that mimics `self`.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadScripts(...files) {
  const ctx = vm.createContext({});
  ctx.self = ctx;
  for (const f of files) {
    vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}
