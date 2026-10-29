# Recipes

Recipes the household liked, saved so they can be found again and checked against what's in the house. Larder doesn't invent recipes: AI assistants do, from what's in stock and what needs using soon (the `expiring` and `search` tools), and save the good ones here.

- **Data:** `recipes` collection: `{ id, title, serves, ingredients: [{ name, productId, quantity, amount, optional }], method, notes, source, lastCookedAt, timesCooked }`. `quantity` is in the linked item's own unit (1 tin, 50 g) and is what cooking takes from stock; `amount` is how the recipe puts it ("400 g", "a handful"). Ingredients are linked to items when their name (or `item`) clearly is one, using the core's strict name matching; unclear ones stay unlinked rather than guessed. Saving again keeps an ingredient's link unless it's given a new `item` or `productId` (`null` unlinks it); `serves: null` clears it, leaving it out keeps it. Assistants find recipes by title with the same strict rules (`core.resolve.among`).
- **Cooking:** `POST /:id/cook` `{ servings? }` proposes what to take out (scaled to servings, never more than there is) and **changes nothing**. `POST /proposals/:proposalId/confirm` `{ items?: [{ productId, quantity }] }` applies it, with any quantities changed (0 leaves an item alone), all together or not at all (`core.stock.useMany`). Two lines for the same item add up to one. Changes can only adjust items in the proposal. Proposals last six hours and work once, even when confirmed twice at the same moment.
- **Other routes** (under `/api/v1/modules/recipes`): `GET /`, `POST /`, `GET /:id`, `PUT /:id`, `DELETE /:id`, `POST /:id/missing-to-list`.
- **Search:** "Saved recipes" (order 70), by title and ingredients, saying what's missing.
- **AI tools:** `save_recipe`, `list_recipes`, `get_recipe`, `propose_cooking`, `confirm_cooking`. The assistant is told to show the proposal and ask before confirming.
- **Demo:** two recipes in the example household.
- **UI:** the recipe list; a recipe page with each ingredient in or not, **Cooked it** (adjust, then confirm) and **Add missing to list**; and a simple editor.
