/** Writes custom_components/larder/services.yaml and actions.json. See scripts/ha-services.ts. */
import { writeFileSync } from 'node:fs';
import { haActionsJson, haServicesYaml } from './ha-services';

writeFileSync('custom_components/larder/services.yaml', await haServicesYaml());
writeFileSync('custom_components/larder/actions.json', await haActionsJson());
console.log('Wrote custom_components/larder/services.yaml and actions.json');
