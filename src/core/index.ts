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
export { defineModule, type DemoSeed, type ModuleContext, type ModuleDefinition, type ModuleInfo, type ModuleRoute, type ModuleRequest, type ModuleLogger, type HttpMethod } from './modules';
export { HouseholdSettings, type CoreDeps } from './services/context';
export type { LookupMatch, LookupProvider } from './services/lookup';
export type { SearchSection } from './services/search';
export type { ActionDefinition, ActionInfo, ActionResult, SensorDefinition, SensorInfo, SensorReading, SensorState } from './services/automation';
export { AmbiguousError } from './services/resolve';
export { NfcScan } from './services/nfc';
export { ASSISTANT_INSTRUCTIONS, type AssistantTool, type ToolInfo, type ToolResult } from './services/assistant';
export { DEFAULT_CATEGORIES, SHOP_PRESETS } from './services/catalogue';
export { addDays, andList, daysBetween, localDate, newId, publicWebAddress, roundQty } from './util';
export { photoType } from './photos';
export {
  BUILT_IN_UNITS, UnknownUnitError, amountText, asWeight, boughtInText, builtInUnits, canConvert, containsText, daysFor, durationText, everyText, exactText, fromBoughtIn, givenInText,
  isCount, isLoose, isMeasure, lastsText, newUnit, parseAmount, periodsPerTake, pluralOf, singularGuess, singularOf, startsOne, stockText, stockWithInside, toBoughtIn, unitKeyOf, unitList, unitOf, unitWord,
  usageInBoughtIn, usageText, weightText, worthText,
  type HouseholdUnit, type NumberText, type UnitItem, type UnitUsage, type Units,
} from './services/units';
