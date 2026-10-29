/**
 * The public core API. Modules, adapters and the server import from
 * "@larder/core" only, never from files inside src/core (an architecture test
 * enforces this for modules and adapters).
 */
export * from './model';
export * from './inputs';
export * from './errors';
export type * from './ports';
export { createCore, type CoreApi } from './core';
export { defineModule, type ModuleContext, type ModuleDefinition, type ModuleInfo, type ModuleRoute, type ModuleRequest, type ModuleLogger, type HttpMethod } from './modules';
export { HouseholdSettings, type CoreDeps } from './services/context';
export type { LookupProvider } from './services/lookup';
export type { SearchSection } from './services/search';
export type { ActionDefinition, ActionInfo, ActionResult, SensorDefinition, SensorInfo, SensorReading, SensorState } from './services/automation';
export { AmbiguousError } from './services/resolve';
export { NfcScan } from './services/nfc';
export { DEFAULT_CATEGORIES, SHOP_PRESETS } from './services/catalogue';
export { addDays, amount, andList, daysBetween, localDate, newId, pluralWord, roundQty } from './util';
