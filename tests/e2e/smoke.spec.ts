import { expect, test, type Locator, type Page } from '@playwright/test';

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

test('home shows what needs attention', async ({ page, isMobile }) => {
  await signIn(page);
  await expect(page.getByRole('heading', { level: 2 })).toContainText('to use soon');
  await expect(page.getByText('Going shopping?')).toBeVisible();
  await expect(page.getByText('Tesco delivery · 1 item')).toBeVisible();
  await expect(page.getByText('Cordless drill').first()).toBeVisible();
  // Scan and the ways to add are on Home on a phone; on a big screen they're in the sidebar, so Home doesn't repeat them.
  const actions = page.locator('.home-grid .actions');
  if (isMobile) {
    await expect(actions.getByRole('link', { name: /Add by name/ })).toBeVisible();
    await expect(actions.getByRole('link', { name: /Put away/ })).toBeVisible();
  } else {
    await expect(actions).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Add by name' })).toBeVisible();
  }
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
  // Plainly already in Larder, and where it goes is a line, not a picker.
  await expect(page.locator('.sheet-card .pill', { hasText: 'In Larder' })).toBeVisible();
  await expect(page.getByText('Goes to')).toBeVisible();
  await page.getByRole('button', { name: /^Add 1 roll/ }).click();
  await expect(page.locator('.toast')).toContainText('Ready for the next scan');
});

test('adds an unknown barcode in one go, remembers it, and leaves the tidying for later', async ({ page }, info) => {
  await signIn(page);
  await page.goto('/#/scan');
  // Local-only code (letters), so no lookup provider is asked.
  const code = `LOCAL-${info.project.name}-1`;
  const name = `Chopped tomatoes ${info.project.name}`;
  await page.getByLabel('Barcode or code').fill(code);
  await page.getByLabel('Barcode or code').press('Enter');
  await expect(page.locator('.sheet-card .pill', { hasText: 'New' })).toBeVisible();
  await page.getByLabel('What is it?').fill(name);
  // One press names it, remembers the barcode and adds the stock; then it's ready for the next scan.
  await page.getByRole('button', { name: 'Add 1', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(`Added 1 · ${name}. Ready for the next scan.`);
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  // Next time it's instant, and known.
  await page.getByLabel('Barcode or code').fill(code);
  await page.getByLabel('Barcode or code').press('Enter');
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.locator('.sheet-card .pill', { hasText: 'In Larder' })).toBeVisible();
  // No place and no type yet: it waits under To tidy, and in Places → To sort for a shelf.
  await page.goto('/#/stock?status=to_tidy');
  await expect(page.locator('.item-name').filter({ hasText: name })).toBeVisible();
  await page.goto('/#/places/to-sort');
  await expect(page.locator('.item-name').filter({ hasText: name })).toBeVisible();
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
  await expect(page.locator('.item .code', { hasText: `${prefix}2-4` })).toBeVisible();
});

test('adds a room, then its spots one after another, and stock in a spot', async ({ page }, info) => {
  await signIn(page);
  const p = info.project.name === 'phone' ? 'P' : 'D';
  const toast = page.locator('.toast');
  await page.goto('/#/places');
  await page.getByRole('button', { name: 'Add a place' }).first().click();
  await page.getByPlaceholder('Kitchen, Top drawer, Shelf 2…').fill(`Loft ${info.project.name}`);
  await page.getByPlaceholder('e.g. K').fill(`L${p}`);
  await page.getByRole('button', { name: 'Add place' }).click();
  // Straight into the new room, ready for its first spot, with a code that follows the room's.
  await expect(page.locator('.bigcode')).toHaveText(`L${p}`);
  await expect(page.getByLabel("New spot's name")).toBeFocused();
  await expect(page.getByLabel("New spot's code")).toHaveValue(`L${p}1`);
  await page.keyboard.type('Left eaves');
  await page.keyboard.press('Enter');
  await expect(toast).toContainText(`Left eaves added as L${p}1`);
  await expect(page.getByLabel("New spot's code")).toHaveValue(`L${p}2`);
  await page.keyboard.type('Right eaves');
  await page.keyboard.press('Enter');
  await expect(toast).toContainText(`Right eaves added as L${p}2`);
  // Renamed without leaving the room.
  await page.getByRole('button', { name: 'Edit Left eaves' }).click();
  await page.getByLabel('Left eaves: name').fill('Left eaves boxes');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(toast).toContainText('Saved');

  // In a spot: what's waiting in To sort goes there in one press, then more of something Larder has.
  const tea = `Tea bags ${info.project.name}`;
  await page.evaluate(async (name) => {
    const headers = { 'X-Larder-Client': 'web', 'Content-Type': 'application/json' };
    const item = (await (await fetch('api/v1/products', { method: 'POST', headers, body: JSON.stringify({ name, unit: 'box' }) })).json()) as { id: string };
    await fetch('api/v1/stock/add', { method: 'POST', headers, body: JSON.stringify({ productId: item.id, quantity: 2, placeId: null }) });
  }, tea);
  await page.getByRole('link', { name: /Left eaves boxes/ }).last().click();
  await expect(page.locator('.bigcode')).toHaveText(`L${p}1`);
  await page.getByRole('button', { name: 'Add stock here' }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.locator('.item', { hasText: tea }).getByRole('button', { name: 'Put here' }).click();
  await expect(toast).toContainText(`${tea} put away in L${p}1`);
  await sheet.getByLabel('Which item?').fill('cable ties');
  await sheet.getByRole('button', { name: /Cable ties/ }).click();
  await sheet.getByRole('button', { name: 'More quantity' }).click();
  await sheet.getByRole('button', { name: /^Add 2/ }).click();
  await expect(toast).toContainText(`of Cable ties to L${p}1`);
  await sheet.getByRole('button', { name: 'Close' }).click();
  // Counted here, and changed here.
  await page.getByRole('button', { name: `More ${tea} here` }).click();
  await expect(toast).toContainText(`${tea}: 3 boxes here now`);
  await expect(page.getByLabel(`${tea} here`, { exact: true })).toHaveValue('3');
  // Scanning from here: whatever's scanned goes here.
  await page.getByRole('link', { name: 'Scan here' }).click();
  await expect(page.locator('.vf-chip').first()).toContainText(`Adding to L${p}1`);
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

test('keeps a recipe for its scenario, and lists recipes on the items they use', async ({ page }, info) => {
  await signIn(page);
  const name = `Bonfire night ${info.project.name}`;
  const title = `Bonfire beans ${info.project.name}`;
  const scenario = (await page.evaluate(async (n) => (await fetch('api/v1/modules/scenarios', { method: 'POST', headers: { 'X-Larder-Client': 'web', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) })).json(), name)) as { id: string };
  await page.goto(`/#/m/scenarios/${scenario.id}`);
  await page.getByRole('link', { name: 'Add one' }).click();
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Ingredient', { exact: true }).fill('baked beans');
  await expect(page.getByRole('switch', { name: 'Only show in these scenarios' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Only shows in ${name}.`)).toBeVisible();
  // Its ingredient opens the item, which lists the recipes that use it.
  await page.getByRole('link', { name: /baked beans/ }).click();
  await expect(page).toHaveURL(/#\/products\//);
  await expect(page.getByRole('heading', { name: 'Baked beans' }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  await expect(page.getByRole('link', { name: /Cheesy beans on toast/ })).toBeVisible();
  // Not on the main list: folded away under its scenarios.
  await page.goto('/#/m/recipes/');
  await expect(page.getByRole('link', { name: /Chicken and spinach traybake/ })).toBeVisible();
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeHidden();
  await page.getByText(/Kept for scenarios/).click();
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  await page.goto(`/#/m/scenarios/${scenario.id}`);
  await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
});

test('scales a recipe by its presets and by what you have, and keeps it as the default', async ({ page, isMobile }) => {
  // Phone and desktop share one server, so each run saves its own preset.
  const name = isMobile ? 'Brunch phone' : 'Brunch desktop';
  await signIn(page);
  await page.goto('/#/m/recipes/');
  await page.getByRole('link', { name: /Pancakes/ }).click();
  const amounts = page.getByRole('group', { name: 'Amounts' });
  await amounts.getByRole('button', { name: 'As saved' }).click();
  await expect(page.getByText('100 g plain flour')).toBeVisible();
  await amounts.getByRole('button', { name: /Family/ }).click();
  await expect(page.getByText('200 g plain flour')).toBeVisible();
  await expect(page.getByText('4 eggs')).toBeVisible();

  await amounts.getByRole('button', { name: /I've got/ }).click();
  await page.getByLabel('Ingredient').selectOption('eggs');
  await page.getByLabel('How many').fill('3');
  await page.getByRole('button', { name: 'Work it out' }).click();
  await expect(page.getByText('150 g plain flour')).toBeVisible();
  await expect(page.getByText('450 ml milk')).toBeVisible();
  await expect(page.getByText('From 3 eggs (×1.5)')).toBeVisible();

  await page.getByRole('button', { name: 'Save as preset' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('switch', { name: 'Use it by default' }).click();
  await page.getByRole('button', { name: 'Save preset' }).click();
  await expect(page.locator('.toast')).toContainText(`Saved the ${name} preset`);
  await expect(amounts.getByRole('button', { name: new RegExp(name) })).toHaveAttribute('aria-pressed', 'true');

  // Opened again, it starts on the default preset.
  await page.reload();
  await expect(page.getByText(`The ${name} preset (×1.5), the default.`)).toBeVisible();
  await expect(page.getByText('150 g plain flour')).toBeVisible();
  await page.getByRole('button', { name: 'Cooked it' }).click();
  await expect(page.getByText('This is what Larder will take out of stock.')).toBeVisible();
  await expect(page.locator('.sheet').getByText('Free-range eggs')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // The editor keeps the presets, and can change which is the default.
  await page.getByRole('link', { name: 'Edit' }).click();
  const presetRow = (preset: string) => page.locator('.inputrow').filter({ has: page.locator(`input[aria-label="Preset name"][value="${preset}"]`) });
  await expect(presetRow(name).getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true');
  await presetRow('Family').getByRole('button', { name: 'Default' }).click();
  await expect(presetRow(name).getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('The Family preset (×2), the default.')).toBeVisible();
  await expect(page.getByText('200 g plain flour')).toBeVisible();
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

/** Stands in for the AI: Larder's own pages, camera and saving are real. */
async function pretendAi(page: Page, answer: Record<string, unknown>) {
  const set = { enabled: true, keySet: true, keyHint: '…abcd', keyFrom: 'app', model: null };
  await page.route('**/api/v1/modules/ai', (r) => r.fulfill({ json: { ready: true, order: ['claude', 'gemini'], first: 'claude', claude: set, gemini: set } }));
  const sent: string[] = [];
  await page.route('**/api/v1/modules/ai/identify', (r) => {
    sent.push((r.request().postDataJSON() as { image: string }).image);
    return r.fulfill({ json: { readable: true, brand: null, unit: 'each', categoryId: null, shelfLifeDays: null, aliases: [], shop: null, provider: 'claude', model: 'claude-haiku-5-5', skipped: [], ...answer } });
  });
  return sent;
}

/** The size a photo on the page really is, so turning it can be checked. */
const size = (img: Locator) => img.evaluate((el) => {
  const i = el as unknown as { complete: boolean; naturalWidth: number; naturalHeight: number };
  return i.complete && i.naturalWidth ? `${i.naturalWidth}x${i.naturalHeight}` : '';
});

test('Add by photo is the scanner: Read with AI names it, one press adds it, and its photo can be turned later', async ({ page }, info) => {
  await signIn(page);
  const name = `Oat drink ${info.project.name}`;
  const shop = `Corner shop ${info.project.name}`;
  const sent = await pretendAi(page, {
    name, brand: 'Oatly Barista Edition 1 L', unit: 'carton', shelfLifeDays: 90, aliases: ['oat milk'], shop: { name: shop, id: null, preset: false },
    provider: 'gemini', model: 'gemini-3.6-flash', skipped: [{ provider: 'claude', message: "Claude couldn't read the photo: Your credit balance is too low." }],
  });
  await page.goto('/');
  await page.getByRole('link', { name: /Add by photo/ }).first().click();
  // The scanner, camera on, with Read with AI under it.
  await expect(page.locator('.viewfinder video')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Read with AI' })).toBeVisible();
  // A volume button reads it, like a camera's shutter.
  await page.keyboard.press('AudioVolumeDown');

  const card = page.locator('.sheet-card');
  await expect(card.getByText("Read from the photo by Gemini. Claude couldn't read the photo: Your credit balance is too low. Check the name.")).toBeVisible();
  await expect(card.getByLabel('Call it')).toHaveValue(name);
  await expect(page.getByText('Paused: finish this one first')).toBeVisible();
  // The photo was shrunk to a JPEG on the phone before it was sent, and sent once.
  expect(sent).toHaveLength(1);
  expect(Buffer.from(sent[0]!, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  // A shop Larder doesn't have is offered, without stopping to ask.
  await card.getByRole('button', { name: `Add ${shop}` }).click();
  await expect(page.locator('.toast')).toContainText(`${shop} added to your shops`);
  await card.getByRole('button', { name: 'Add 1', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(`Added 1 carton · ${name}. Ready for the next scan.`);
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();

  // It's in Larder with its photo, brand and shop, waiting to be tidied (no place yet); the photo can be turned there.
  await page.goto('/#/stock?status=to_tidy');
  await expect(page.locator('.item-name').filter({ hasText: name })).toBeVisible();
  const id = await page.evaluate(async (n) => ((await (await fetch('api/v1/products?status=to_tidy')).json()) as Array<{ product: { id: string; name: string } }>).find((s) => s.product.name === n)!.product.id, name);
  await page.goto(`/#/products/${id}`);
  await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  await expect(page.getByText('Oatly Barista Edition 1 L')).toBeVisible();
  const itemPhoto = page.getByRole('button', { name: 'Add a photo' }).locator('img');
  await expect.poll(() => size(itemPhoto)).toMatch(/^\d+x\d+$/);
  const [w, h] = (await size(itemPhoto)).split('x');
  await page.getByRole('button', { name: 'Rotate photo' }).click();
  await expect(page.locator('.toast')).toContainText('Photo turned');
  await expect.poll(() => size(itemPhoto)).toBe(`${h}x${w}`);
});

test('Add from receipt matches lines to items, leaves the rest out, and adds what is ticked', async ({ page }, info) => {
  await signIn(page);
  await pretendAi(page, {});
  const p = info.project.name;
  const make = (name: string, unit: string) => page.evaluate(async (b) => ((await (await fetch('api/v1/products', { method: 'POST', headers: { 'X-Larder-Client': 'web', 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json()) as { id: string }).id, { name, unit });
  const rice = await make(`Basmati rice ${p}`, 'bag');
  const tea = await make(`Tea bags ${p}`, 'box');
  const coffee = await make(`Ground coffee ${p}`, 'bag');
  const tesco = await page.evaluate(async () => ((await (await fetch('api/v1/shops')).json()) as Array<{ id: string; name: string }>).find((s) => s.name === 'Tesco')!.id);
  const ref = (id: string, name: string, unit: string) => ({ id, name, unit });
  await page.route('**/api/v1/modules/ai/receipt', (r) => r.fulfill({
    json: {
      readable: true, shop: { name: 'Tesco', id: tesco, preset: false }, date: '2026-11-02', total: 9.4,
      lines: [
        { text: 'TSC BASMATI 1KG', count: 1, price: 1.85, item: ref(rice, `Basmati rice ${p}`, 'bag'), quantity: 1, match: 'sure' },
        { text: 'TETLEY 80S', count: 1, price: 2.5, item: ref(tea, `Tea bags ${p}`, 'box'), quantity: 1, match: 'guess' },
        { text: 'KENCO SMTH 200G', count: 1, price: 4.75, item: null, quantity: 1, match: 'none' },
        { text: 'CARRIER BAG', count: 1, price: 0.3, item: null, quantity: 1, match: 'none' },
      ],
      addedBefore: null, receiptKey: `e2e-${p}-${Date.now()}`, provider: 'claude', model: 'claude-haiku-5-5', skipped: [],
    },
  }));

  await page.goto('/');
  await page.getByRole('link', { name: /Add from receipt/ }).first().click();
  await expect(page.locator('.viewfinder video')).toBeVisible();
  await page.getByRole('button', { name: 'Take photo' }).click();

  // The sure one is ticked; the guess is shown to check; the rest are left out.
  await expect(page.getByLabel('Shop')).toHaveValue(tesco);
  await expect(page.getByRole('button', { name: `Add Basmati rice ${p}` })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: `Add Tea bags ${p}` })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('Check', { exact: true })).toBeVisible();
  await expect(page.getByText('Not in Larder · left out')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add 1 thing to stock' })).toBeVisible();

  // Tick the tea, two boxes; match the coffee by hand; the carrier bag stays out.
  await page.getByRole('button', { name: `Add Tea bags ${p}` }).click();
  await page.getByRole('button', { name: `More How many Tea bags ${p} (box)` }).click();
  await expect(page.getByLabel(`How many Tea bags ${p} (box)`, { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: 'Match' }).first().click();
  await page.getByLabel('Search your items').fill(`ground coffee ${p}`);
  await page.getByRole('dialog').getByRole('button', { name: new RegExp(`Ground coffee ${p}`) }).click();
  await expect(page.getByRole('button', { name: `Add Ground coffee ${p}` })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Add 3 things to stock' }).click();
  await expect(page.getByText('Added 3 things from Tesco to stock. Ready for the next receipt.')).toBeVisible();
  await expect(page.locator('.viewfinder video')).toBeVisible();
  const stock = await page.evaluate(async (ids) => {
    const all = (await (await fetch('api/v1/products')).json()) as Array<{ product: { id: string }; inStock: number }>;
    return ids.map((id) => all.find((s) => s.product.id === id)!.inStock);
  }, [rice, tea, coffee]);
  expect(stock).toEqual([1, 2, 1]);
});

test('a barcode nothing knows can be read with AI, and is remembered', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Once is enough');
  await signIn(page);
  const name = `Smoked paprika ${info.project.name}`;
  await pretendAi(page, { name, brand: 'Schwartz Smoked Paprika 46 g', unit: 'jar' });
  await page.goto('/#/scan');
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.locator('.viewfinder video')).toBeVisible();
  const code = `LOCAL-AI-${info.project.name}`;
  await page.getByLabel('Barcode or code').fill(code);
  await page.getByLabel('Barcode or code').press('Enter');
  await page.getByRole('button', { name: 'Read it with AI' }).click();
  const card = page.locator('.sheet-card');
  await expect(card.getByLabel('Call it')).toHaveValue(name);
  await expect(card.getByText(code)).toBeVisible();
  await card.getByRole('button', { name: 'Add 1', exact: true }).click();
  await expect(page.locator('.toast')).toContainText(`Added 1 jar · ${name}`);
  // The barcode is remembered.
  await page.getByLabel('Barcode or code').fill(code);
  await page.getByLabel('Barcode or code').press('Enter');
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.locator('.sheet-card .pill', { hasText: 'In Larder' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip' }).click();

  // An uploaded photo the AI can't make out says so.
  await pretendAi(page, { readable: false, name: 'Blurry thing' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await page.getByTestId('scan-upload').setInputFiles({ name: 'pack.png', mimeType: 'image/png', buffer: png });
  await expect(card.getByText("It couldn't make it out: check the name.")).toBeVisible();
  await card.getByRole('button', { name: 'Skip' }).click();
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
});

test('settings set the order the AIs are asked in, and switch one off without losing its key', async ({ page }, info) => {
  test.skip(info.project.name === 'phone', 'Once is enough: settings are the same on both');
  // Google can be slow to list Gemini's models. Each change waits for that before the next can be made,
  // so the switches are greyed out meanwhile rather than missing a tap.
  await page.route('**/modules/ai/models**', async (r) => { await new Promise((ok) => setTimeout(ok, 1000)); await r.continue(); });
  await signIn(page);
  await page.goto('/#/settings');
  await expect(page.getByText('Add a key to Claude or Gemini to use Add by photo.')).toBeVisible();
  // A key is saved but never shown again.
  await page.getByLabel('Gemini API key').fill('AIza-not-a-real-key-1234');
  await page.getByLabel('Gemini API key').press('Enter');
  await expect(page.getByText('Saved (…1234)')).toBeVisible();
  await expect(page.getByLabel('Gemini API key')).toHaveValue('');
  await expect(page.getByText('1. Claude')).toBeVisible();
  await expect(page.getByText('Needs an API key')).toBeVisible();
  await expect(page.getByText('Asked first', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Ask first' }).click();
  await expect(page.getByText('1. Gemini')).toBeVisible();
  await expect(page.getByText('2. Claude')).toBeVisible();

  await page.getByRole('switch', { name: 'Use Gemini' }).click();
  await expect(page.getByText('Off for now. Its key and model are kept.', { exact: true })).toBeVisible();
  await expect(page.getByText('Every AI with a key is switched off, so Add by photo is hidden.')).toBeVisible();
  await expect(page.getByText('Saved (…1234)')).toBeVisible();
  await page.getByRole('switch', { name: 'Use Gemini' }).click();
  await expect(page.getByText('Asked first', { exact: true })).toBeVisible();
});

test('shared links wait in Pending, to go on the wish list or into Larder', async ({ page, isMobile }, info) => {
  await signIn(page);
  // As the Home Assistant integration sends them (the shop's page can't be reached here, so the subject names them).
  const share = (subject: string) => page.evaluate(async (s) => {
    const res = await fetch('api/v1/modules/sharing/link', { method: 'POST', headers: { 'X-Larder-Client': 'web', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: `https://shop.example.invalid/p/${encodeURIComponent(s)}`, subject: s, device: 'Test phone' }) });
    return res.json();
  }, subject);
  const wish = `Garden kneeler ${info.project.name}`;
  const got = `Bird feeder ${info.project.name}`;
  await share(wish);
  await share(got);
  const named = (name: string) => page.locator('.item-name').filter({ hasText: name });
  const row = (name: string) => page.locator('.item', { hasText: name });

  // The Wish list says they're waiting, without listing them: they aren't wishes yet.
  await page.goto('/#/wishlist');
  await expect(named(wish)).toHaveCount(0);
  if (!isMobile) await expect(page.locator('.tabbar').getByText('Pending')).toBeVisible();
  await page.getByText(/shared links? in Pending/).click();
  await expect(named(wish)).toBeVisible();
  await expect(named(got)).toBeVisible();

  await row(wish).getByRole('button', { name: 'Add to wish list' }).click();
  await expect(page.locator('.toast')).toContainText(`${wish} is on the wish list`);
  await expect(named(wish)).toHaveCount(0);

  // Got it already: the Add item page, filled in; saving takes it out of Pending.
  await row(got).getByRole('button', { name: 'Add to Larder' }).click();
  await expect(page.getByText("Say how many you've got and where")).toBeVisible();
  await expect(page.getByLabel('What is it?')).toHaveValue(got);
  await page.getByRole('button', { name: `Add ${got.toLowerCase()}`, exact: true }).click();
  await expect(page.getByRole('heading', { level: 2, name: got })).toBeVisible();
  await expect(page.getByText('On the wish list.')).toHaveCount(0);
  await expect(page.getByText('From a shared link')).toBeVisible();

  await page.goto('/#/m/sharing/');
  await expect(named(got)).toHaveCount(0);
  await page.goto('/#/wishlist');
  await expect(named(wish)).toHaveCount(1);
});

test('the camera needs a clear read, and holds still while a card is open', async ({ page }) => {
  // A pretend barcode reader: each frame it "sees" the next code queued by the test, if any.
  await page.addInitScript(() => {
    const w = globalThis as unknown as { __frames: string[]; BarcodeDetector: unknown };
    w.__frames = [];
    w.BarcodeDetector = class {
      static async getSupportedFormats() { return ['ean_13', 'qr_code']; }
      async detect() {
        const code = w.__frames.shift();
        return code ? [{ rawValue: code }] : [];
      }
    };
  });
  const see = (...codes: string[]) => page.evaluate((c) => { (globalThis as unknown as { __frames: string[] }).__frames.push(...c); }, codes);
  await signIn(page);
  await page.goto('/#/scan');
  await page.getByRole('button', { name: 'Start camera' }).click();
  await expect(page.locator('.viewfinder video')).toBeVisible();

  // A glimpse in one frame (a misread) isn't taken.
  await see('5000000000017');
  await page.waitForTimeout(800);
  await expect(page.getByText('Looking it up…')).toHaveCount(0);
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();

  // Read the same twice: that's the toilet roll.
  await see('5029053038889', '5029053038889');
  await expect(page.getByRole('heading', { name: 'Toilet roll' })).toBeVisible();
  await expect(page.getByText('Paused: finish this one first')).toBeVisible();

  // Another barcode while the card is open doesn't replace it.
  await see('5000157024671', '5000157024671', '5000157024671');
  await page.waitForTimeout(800);
  await expect(page.getByRole('heading', { name: 'Toilet roll' })).toBeVisible();

  // Done with it: still in view, it isn't scanned straight back in.
  await page.getByRole('button', { name: 'Skip' }).click();
  await see('5029053038889', '5029053038889', '5029053038889');
  await page.waitForTimeout(800);
  await expect(page.getByText('Ready', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Toilet roll' })).toHaveCount(0);
});
