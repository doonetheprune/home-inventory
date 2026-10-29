import { expect, test, type Page } from '@playwright/test';

/** Signs in (setting up the household the first time) and loads the example data once. */
async function signIn(page: Page) {
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

test('home shows what needs attention', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { level: 2 })).toContainText('to use soon');
  await expect(page.getByText('Going shopping?')).toBeVisible();
  await expect(page.getByText('Tesco delivery · 1 item')).toBeVisible();
  await expect(page.getByText('Cordless drill').first()).toBeVisible();
});

test('search finds nicknames and counts with the keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Keyboard counting is a desktop feature');
  await signIn(page);
  const box = page.getByLabel('Search or add anything');
  await box.fill('bog rol');
  const row = page.locator('.gs-row.hl');
  await expect(row).toContainText('Toilet roll');
  const before = await row.locator('output').innerText();
  await box.press('ArrowUp');
  await box.press('ArrowUp');
  await expect(page.locator('.gs-pending')).toHaveText('+2');
  await box.press('Enter');
  await expect(page.locator('.toast')).toContainText('Added 2');
  await expect(row.locator('output')).not.toHaveText(before);
  await box.fill('zzz unknown thing');
  await expect(page.getByText('Add “zzz unknown thing” as a new item')).toBeVisible();
});

test('adds an item by name and uses it', async ({ page }, info) => {
  await signIn(page);
  const name = `Sealant ${info.project.name}`;
  await page.goto(`/#/add?name=${encodeURIComponent(name)}`);
  await page.getByRole('button', { name: 'Tools & DIY' }).click();
  await page.getByRole('button', { name: `Add ${name.toLowerCase()}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await page.getByRole('button', { name: 'Use', exact: true }).click();
  await page.getByRole('button', { name: /^Use 1/ }).click();
  await expect(page.locator('.toast')).toContainText('Used 1');
});

test('scans a known barcode by typing it and adds stock', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/scan');
  await page.getByLabel('Barcode or code').fill('5029053038889');
  await page.getByLabel('Barcode or code').press('Enter');
  await expect(page.getByRole('heading', { name: 'Toilet roll' })).toBeVisible();
  await page.getByRole('button', { name: /^Add 1 roll/ }).click();
  await expect(page.locator('.toast')).toContainText('Ready for the next scan');
});

test('names an unknown barcode once and remembers it', async ({ page }, info) => {
  await signIn(page);
  await page.goto('/#/scan');
  // Local-only code (letters), so no lookup provider is asked.
  const code = `LOCAL-${info.project.name}-1`;
  const name = `Chopped tomatoes ${info.project.name}`;
  await page.getByLabel('Barcode or code').fill(code);
  await page.getByLabel('Barcode or code').press('Enter');
  await page.getByLabel('What is it?').fill(name);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  // Next time it's instant.
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.getByLabel('Barcode or code').fill(code);
  await page.getByLabel('Barcode or code').press('Enter');
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

test('shopping: tick, done, gone from the list', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/shop');
  const first = page.locator('.item').filter({ has: page.locator('.check') }).first();
  const name = (await first.locator('.item-name').innerText()).split(' · ')[0]!;
  await first.locator('.check').click();
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.locator('.toast')).toContainText('added to stock');
  await expect(page.locator('.item-name', { hasText: name })).toHaveCount(0);
});

test('sets up a grid of shelves', async ({ page }, info) => {
  await signIn(page);
  await page.goto('/#/grid');
  const prefix = info.project.name === 'phone' ? 'P' : 'D';
  await page.locator('input.mono').fill(prefix);
  await page.getByRole('button', { name: 'Create 24 places' }).click();
  await expect(page.getByText(`4 shelves, 6 boxes each. Codes ${prefix}1-1 to ${prefix}4-6.`)).toBeVisible();
  await expect(page.locator('a.item .code', { hasText: `${prefix}2-4` })).toBeVisible();
});

test('links an NFC tag scanned on a phone to a place', async ({ page }, info) => {
  await signIn(page);
  const tag = `04:E2:${info.project.name}:${Date.now()}`;
  const place = (await page.evaluate(async (name) => (await fetch('api/v1/places', { method: 'POST', headers: { 'X-Larder-Client': 'web', 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).json(), `Tag box ${info.project.name}`)) as { id: string };
  await page.goto(`/#/places/${place.id}`);
  await page.getByRole('button', { name: 'Link a tag' }).click();
  await expect(page.getByText('Waiting for a new tag…')).toBeVisible();
  // What the Home Assistant integration sends when the app scans a tag; the page hears about it live.
  await page.evaluate(async (tagId) => fetch('api/v1/nfc/scanned', { method: 'POST', headers: { 'X-Larder-Client': 'web', 'Content-Type': 'application/json' }, body: JSON.stringify({ tagId, device: 'Pixel' }) }), tag);
  await expect(page.getByText(tag)).toBeVisible();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('Tag linked');
  await expect(page.getByRole('button', { name: 'Unlink' })).toBeVisible();
});

test('approves an AI assistant that asks to connect', async ({ page }) => {
  await signIn(page);
  const callback = 'http://localhost:33418/callback';
  const client = (await (await page.request.post('oauth/register', { data: { client_name: 'Claude', redirect_uris: [callback] } })).json()) as { client_id: string };
  const qs = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: callback, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 'abc' });
  const start = await page.request.get(`oauth/authorize?${qs}`, { maxRedirects: 0 });
  // The assistant's callback isn't running in the test; answer it here.
  await page.route(`${callback}**`, (route) => route.fulfill({ body: 'connected' }));
  await page.goto(start.headers().location!);
  await expect(page.getByRole('heading', { name: 'Connect Claude?' })).toBeVisible();
  await expect(page.getByText('localhost:33418')).toBeVisible();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.waitForURL(/localhost:33418\/callback\?.*code=/);
  expect(new URL(page.url()).searchParams.get('state')).toBe('abc');
});

test('opens a scenario, its printable page, and label sheets', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/m/scenarios/');
  await page.getByRole('link', { name: /Power cut/ }).click();
  await expect(page.getByRole('heading', { name: 'Power cut' })).toBeVisible();
  await expect(page.getByText('Head torch').first()).toBeVisible();
  await page.getByRole('link', { name: 'Print this scenario' }).click();
  await expect(page.getByRole('heading', { name: 'Power cut page' })).toBeVisible();
  await expect(page.locator('.print-area')).toContainText('items in');
  await page.goto('/#/m/printing/');
  await expect(page.getByRole('heading', { name: 'Label sheets' })).toBeVisible();
  await expect(page.locator('.label-sheet svg').first()).toBeVisible();
  await expect(page.locator('.print-area')).toContainText('G2-4');
});

test('cooks a saved recipe after confirming what comes out of stock', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/m/recipes/');
  await page.getByRole('link', { name: /Cheesy beans on toast/ }).click();
  await expect(page.getByText('Not tracked')).toBeVisible();
  await page.getByRole('button', { name: 'Cooked it' }).click();
  await expect(page.getByText('This is what Larder will take out of stock.')).toBeVisible();
  await page.getByRole('button', { name: 'Take them out' }).click();
  await expect(page.locator('.toast')).toContainText('out of stock');
  await expect(page.getByText(/Cooked \d+ time/)).toBeVisible();
});

/** The id of an example item, for going straight to its page. */
async function productId(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => ((await (await fetch('api/v1/products')).json()) as Array<{ product: { id: string; name: string } }>).find((s) => s.product.name === n)!.product.id, name);
}

test('stock opens on the types of thing, and each type lists its items', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/stock');
  await page.locator('.type-card', { hasText: 'Food' }).click();
  await expect(page.getByRole('heading', { name: 'Food' })).toBeVisible();
  await expect(page.getByText('Baby spinach').first()).toBeVisible();
  await page.getByRole('tab', { name: /Household/ }).click();
  await expect(page.getByRole('heading', { name: 'Household' })).toBeVisible();
  await expect(page.getByText('Toilet roll').first()).toBeVisible();
});

test('adds stock at another place, and says from home that something has moved', async ({ page, isMobile }) => {
  // Phone and desktop share one server, so each run uses its own places.
  const pick = isMobile ? 1 : 3;
  await signIn(page);
  await page.goto(`/#/products/${await productId(page, 'Baby spinach')}`);
  await page.getByRole('button', { name: 'Add somewhere else' }).click();
  await page.getByLabel('Where', { exact: true }).selectOption({ index: pick + 1 });
  await page.getByRole('button', { name: /^Add 1/ }).click();
  await expect(page.locator('.toast')).toContainText('Added 1 to');

  await page.goto('/#/');
  await page.getByRole('button', { name: "Something's moved" }).first().click();
  await page.getByPlaceholder("What's moved? e.g. drill").fill('torch');
  await page.locator('.sheet .item', { hasText: 'Head torch' }).click();
  await page.getByLabel('Where it is now').selectOption({ index: pick });
  await page.getByRole('button', { name: "It's there for now" }).click();
  await expect(page.locator('.toast')).toContainText('now in');
});

test('shows the usual price per 100 g or per kg, and checks a shelf price', async ({ page }) => {
  await signIn(page);
  await page.goto(`/#/products/${await productId(page, 'Baby spinach')}`);
  await page.getByLabel('Show the price per').selectOption('100g');
  await expect(page.getByText('£0.55', { exact: true })).toBeVisible();
  await page.getByLabel('How much is in the pack').fill('1');
  await page.getByLabel('Pack size unit').selectOption('kg');
  await page.getByPlaceholder('2.50').fill('4.40');
  await page.getByRole('button', { name: 'Check the price' }).click();
  await expect(page.locator('.verdict')).toContainText('Cheaper than usual');
  await expect(page.locator('.verdict')).toContainText('£0.44 per 100 g');
});

test('finds a shop\'s branches from its card, and offers the zones and automation as YAML', async ({ page }) => {
  await signIn(page);
  await page.goto('/#/shops');
  const aldi = page.locator('.card', { has: page.getByText('Aldi', { exact: true }) }).first();
  await aldi.getByRole('button', { name: /Find (nearby|more)/ }).click();
  // Without Home Assistant, Larder asks where home is before searching the map.
  await expect(page.getByRole('dialog').getByLabel('Postcode or town')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  await page.goto('/#/m/shop-locations');
  await expect(page.getByText('Larder isn’t connected to Home Assistant, so copy the YAML below')).toBeVisible();
  await page.getByRole('button', { name: 'Show the YAML' }).click();
  await expect(page.getByRole('textbox', { name: 'Zones (configuration.yaml)' })).toHaveValue(/zone:/);
  await expect(page.getByRole('textbox', { name: 'Automation' })).toHaveValue(/action: larder\.shopping_list_for/);
});
