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
import template from './_template';

export const modules: ModuleDefinition[] = [openFoodFacts, openBeautyFacts, openProductsFacts, pricing, batteries, template];
