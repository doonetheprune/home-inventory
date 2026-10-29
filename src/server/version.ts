/** Replaced at build time by scripts/build-server.mjs; falls back to package.json in development. */
declare const __LARDER_VERSION__: string | undefined;
export const VERSION: string = typeof __LARDER_VERSION__ === 'string' ? __LARDER_VERSION__ : (process.env.npm_package_version ?? '0.1.0-dev');
