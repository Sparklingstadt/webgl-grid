import { test as base } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export { expect, type Page } from '@playwright/test';

// どのテストでも、物理エンジン Ammo.js (と WebAssembly) は CDN から取らずに node_modules から返す
// (速くなり、インターネットにつながっていなくても物理演算のテストが動く)
const libs = fileURLToPath(new URL('../../node_modules/three/examples/jsm/libs/', import.meta.url));
const files = new Map<string, Promise<Buffer>>();
const local = (name: string) => {
  if (!files.has(name)) files.set(name, readFile(libs + name));
  return files.get(name)!;
};

export const test = base.extend<{ localAmmo: void }>({
  localAmmo: [async ({ context }, use) => {
    await context.route(/\/libs\/ammo\.wasm\.(js|wasm)$/, async route => {
      const name = new URL(route.request().url()).pathname.split('/').pop()!;
      await route.fulfill({
        body: await local(name),
        contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        headers: { 'access-control-allow-origin': '*' },
      });
    });
    await use();
  }, { auto: true }],
});
