/** Looks up unknown barcodes in Open Food Facts (food and drink). */
import { defineModule } from '@larder/core';
import { openFactsProvider } from '../_shared/open-facts';

export default defineModule({
  id: 'lookup-openfoodfacts',
  name: 'Open Food Facts',
  description: 'Fills in names, brands and photos for food and drink barcodes from Open Food Facts.',
  version: '1.0.0',
  defaultEnabled: true,
  setup(ctx) {
    ctx.addLookupProvider(openFactsProvider({ id: 'openfoodfacts', name: 'Open Food Facts', baseUrl: ctx.config.url ?? 'https://world.openfoodfacts.org' }));
  },
});
