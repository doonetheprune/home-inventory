/**
 * Run by the add-on's entrypoint, as root, before Larder starts: puts the
 * matching Home Assistant integration into Home Assistant's config folder.
 * Larder itself runs as an unprivileged user and can't write there.
 */
import { runIntegrationInstall } from './addon';

await runIntegrationInstall(process.env);
