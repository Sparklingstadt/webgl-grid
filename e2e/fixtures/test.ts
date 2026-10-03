import { test as base } from '@playwright/test';

export { expect, type Page } from '@playwright/test';

// e2e テストの共通の土台 (いまは Playwright のものそのまま。物理エンジンの Ammo.js は、アプリが自分で配る)
export const test = base;
