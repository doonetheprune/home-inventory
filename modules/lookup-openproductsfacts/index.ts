/** Looks up unknown barcodes in Open Products Facts (household and other products). */
import { defineModule } from '@larder/core';
import { openFactsProvider } from '../_shared/open-facts';

export default defineModule({
  id: 'lookup-openproductsfacts',
  name: 'Open Products Facts',
  description: 'Fills in names, brands and photos for household and other products barcodes from Open Products Facts.',
  version: '1.0.0',
  defaultEnabled: true,
  setup(ctx) {
    ctx.addLookupProvider(openFactsProvider({ id: 'openproductsfacts', name: 'Open Products Facts', baseUrl: ctx.config.url ?? 'https://world.openproductsfacts.org' }));
  },
});
