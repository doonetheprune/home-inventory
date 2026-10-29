/** Looks up unknown barcodes in Open Beauty Facts (toiletries and cosmetics). */
import { defineModule } from '@larder/core';
import { openFactsProvider } from '../_shared/open-facts';

export default defineModule({
  id: 'lookup-openbeautyfacts',
  name: 'Open Beauty Facts',
  description: 'Fills in names, brands and photos for toiletries and cosmetics barcodes from Open Beauty Facts.',
  version: '1.0.0',
  defaultEnabled: true,
  setup(ctx) {
    ctx.addLookupProvider(openFactsProvider({ id: 'openbeautyfacts', name: 'Open Beauty Facts', baseUrl: ctx.config.url ?? 'https://world.openbeautyfacts.org' }));
  },
});
