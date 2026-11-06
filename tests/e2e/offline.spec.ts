import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';

/** Moves around inside the app without loading the page again (which, with no connection, starts afresh). */
const go = (page: Page, hash: string) => page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
const offlineSection = (page: Page) => page.locator('.section', { has: page.locator('.label', { hasText: 'Offline copies' }) });

test.describe('offline copies', () => {
  test('saves a copy, then opens Larder with no connection and loads it: search, an item, a scenario, read only', async ({ page, context, isMobile }) => {
    await page.addInitScript(() => localStorage.setItem('larder.offline.daily', 'off'));
    await signIn(page);
    await go(page, '#/settings');
    const section = offlineSection(page);
    await section.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Saved a copy');
    await expect(section.getByRole('button', { name: /^Load the copy saved Today/ })).toHaveCount(1);

    // The app itself is kept on the device once its service worker is in charge of the page.
    await page.waitForFunction('!!navigator.serviceWorker.controller', undefined, { timeout: 15_000 });
    await context.setOffline(true);
    const reloaded = await page.reload();
    expect(reloaded?.fromServiceWorker()).toBe(true);
    await expect(page.getByText("Can't reach Larder.")).toBeVisible();
    await expect(page.getByText('Load data from')).toBeVisible();
    await page.getByRole('button', { name: /^Load the copy saved Today/ }).click();
    await expect(page.locator('.copy-bar')).toContainText('Saved copy');
    await expect(page.locator('.copy-bar')).toContainText('read only');

    // Search works from the copy, nicknames too, and nothing to scan or add.
    await go(page, '#/');
    await expect(page.getByText('Going shopping?')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Scan' })).toHaveCount(0);
    await page.getByLabel('Search or add anything').fill('bog rol');
    await expect(page.locator('.gs-row').first()).toContainText('Toilet roll');
    await expect(page.getByText(/as a new item/)).toHaveCount(0);
    await page.locator('.gs-row').first().locator('.gs-main').click();
    await expect(page.getByRole('heading', { name: 'Toilet roll' }).first()).toBeVisible();

    // Changes say why they can't happen.
    await page.getByRole('button', { name: /Put on the list|Take off the list/ }).click();
    await expect(page.locator('.toast')).toContainText('This is a saved copy, so nothing can be changed');

    // Stock filters are worked out from the copy, and scenarios come with it.
    await go(page, '#/stock?view=all');
    await expect(page.getByText('Toilet roll').first()).toBeVisible();
    await go(page, '#/m/scenarios/');
    await page.getByRole('link', { name: /Power cut/ }).click();
    await expect(page.getByRole('heading', { name: 'Power cut' })).toBeVisible();
    await expect(page.getByText('Head torch').first()).toBeVisible();
    // Modules that don't work from a copy aren't offered.
    if (isMobile) await go(page, '#/more');
    await expect(page.getByRole('link', { name: /Label sheets/ })).toHaveCount(0);

    // Back to the live Larder once it can be reached.
    await page.locator('.copy-bar').getByRole('button', { name: 'Change' }).click();
    await page.getByRole('button', { name: 'Back to the live Larder' }).click();
    await expect(page.locator('.toast')).toContainText("Still can't reach Larder");
    await context.setOffline(false);
    await page.getByRole('button', { name: 'Back to the live Larder' }).click();
    await expect(page.locator('.copy-bar')).toHaveCount(0);
    await go(page, '#/');
    await expect(page.getByRole('link', { name: 'Scan' }).first()).toBeVisible();
  });

  test('saves a copy each day by itself, and signing out removes them', async ({ page }) => {
    await signIn(page);
    await go(page, '#/settings');
    const section = offlineSection(page);
    await expect(section.getByRole('switch', { name: 'Save a copy each day' })).toHaveAttribute('aria-checked', 'true');
    await expect(section.getByText(/saved automatically/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    const left = await page.evaluate(`new Promise((ok) => {
      const req = indexedDB.open('larder-offline');
      req.onsuccess = () => {
        const count = req.result.transaction('copies').objectStore('copies').count();
        count.onsuccess = () => ok(count.result);
      };
    })`);
    expect(left).toBe(0);
  });
});

test.describe('with nothing saved', () => {
  test.use({ serviceWorkers: 'block' });
  test('says there are no copies on this device', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('larder.offline.daily', 'off'));
    await signIn(page);
    await page.route('**/api/v1/**', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(page.getByText("Can't reach Larder.")).toBeVisible();
    await expect(page.getByText('There are no copies saved on this device.')).toBeVisible();
    await page.unroute('**/api/v1/**');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('link', { name: 'Larder home' })).toBeVisible();
  });
});
