/**
 * Every feature module Larder loads. To add one, copy modules/_template,
 * then add it to this list. Lookup providers are asked in this order.
 */
import type { ModuleDefinition } from '@larder/core';
import openFoodFacts from './lookup-openfoodfacts';
import openBeautyFacts from './lookup-openbeautyfacts';
import openProductsFacts from './lookup-openproductsfacts';
import pricing from './pricing';
import batteries from './batteries';
import scenarios from './scenarios';
import printing from './printing';
import recipes from './recipes';
import mqttModule from './mqtt';
import template from './_template';

export const modules: ModuleDefinition[] = [openFoodFacts, openBeautyFacts, openProductsFacts, pricing, batteries, scenarios, printing, recipes, mqttModule, template];
