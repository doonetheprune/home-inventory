import { expect, type Page } from '@playwright/test';

/** Signs in (setting up the household the first time) and loads the example data once. */
export async function signIn(page: Page) {
  await page.goto('/');
  const setup = page.getByRole('button', { name: 'Create account' });
  const signInBtn = page.getByRole('button', { name: 'Sign in' });
  await expect(setup.or(signInBtn)).toBeVisible();
  await page.getByLabel('Username').fill('shaun');
  await page.getByLabel('Password').fill('correct horse battery');
  if (await setup.isVisible()) await setup.click();
  else await signInBtn.click();
  await expect(page.getByRole('link', { name: 'Larder home' })).toBeVisible();
  const status = (await page.evaluate(async () => (await fetch('api/v1/home')).json())) as { counts: { products: number } };
  if (status.counts.products === 0) {
    await page.evaluate(async () => fetch('api/v1/settings/demo', { method: 'POST', headers: { 'X-Larder-Client': 'web', 'Content-Type': 'application/json' }, body: '{}' }));
    await page.reload();
  }
}
