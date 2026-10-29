"""Larder's actions as Home Assistant actions: larder.add_stock, larder.use_stock, and the rest.

Larder lists its actions with their fields as JSON Schema (GET
/api/v1/automation). Each becomes an action here with the same name, fields
and descriptions, so new actions (including ones modules add) need no
change to this file. Every action can return Larder's answer, which has a
`message` to read out or send in a notification.

The actions of the Larder version this integration ships with are in
actions.json (generated, like services.yaml, by `npm run ha:services`) and
registered when Home Assistant starts, so they exist even while Larder
can't be reached; they then say so when called.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_set_service_schema
import voluptuous as vol

from .api import LarderConnectionError, LarderError
from .const import ATTR_CONFIG_ENTRY_ID, DOMAIN

_LOGGER = logging.getLogger(__name__)

DATE_PATTERN = r"^\d{4}-\d{2}-\d{2}$"
REGISTERED = f"{DOMAIN}_registered_actions"
BUNDLED = f"{DOMAIN}_bundled_actions"
# Each connected Larder's own list; Home Assistant gets them all together.
PER_ENTRY = f"{DOMAIN}_actions_by_entry"
BUNDLED_FILE = Path(__file__).parent / "actions.json"


def _validator(prop: dict[str, Any]) -> Any:
    kind = prop.get("type")
    if "enum" in prop:
        return vol.In(prop["enum"])
    if kind == "number":
        return vol.Coerce(float)
    if kind == "integer":
        return vol.Coerce(int)
    if kind == "boolean":
        return cv.boolean
    if kind == "array":
        return vol.All(cv.ensure_list, [cv.string])
    if kind == "string" and prop.get("pattern") == DATE_PATTERN:
        # Dates from the UI and templates arrive as dates or strings; Larder wants YYYY-MM-DD.
        return vol.All(cv.date, lambda d: d.isoformat())
    return cv.string


def _selector(prop: dict[str, Any]) -> dict[str, Any]:
    kind = prop.get("type")
    if "enum" in prop:
        return {"select": {"options": prop["enum"]}}
    if kind in ("number", "integer"):
        return {"number": {"mode": "box", "min": 0, "step": "any" if kind == "number" else 1}}
    if kind == "boolean":
        return {"boolean": {}}
    if kind == "string" and prop.get("pattern") == DATE_PATTERN:
        return {"date": {}}
    return {"text": {}}


def _label(key: str) -> str:
    return key.replace("_", " ").capitalize()


def build_schema(action: dict[str, Any]) -> vol.Schema:
    """A voluptuous schema for an action, from its JSON Schema. Defaults are left to Larder."""
    schema = action.get("schema", {})
    required = set(schema.get("required", []))
    fields: dict[Any, Any] = {vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string}
    for key, prop in schema.get("properties", {}).items():
        marker = vol.Required(key) if key in required else vol.Optional(key)
        fields[marker] = _validator(prop)
    return vol.Schema(fields)


def build_description(action: dict[str, Any]) -> dict[str, Any]:
    """What Home Assistant shows for an action in the UI."""
    schema = action.get("schema", {})
    required = set(schema.get("required", []))
    fields: dict[str, Any] = {}
    for key, prop in schema.get("properties", {}).items():
        field: dict[str, Any] = {"name": _label(key), "description": prop.get("description", ""), "required": key in required, "selector": _selector(prop)}
        if "default" in prop:
            field["default"] = prop["default"]
        fields[key] = field
    fields[ATTR_CONFIG_ENTRY_ID] = {
        "name": "Larder",
        "description": "Only needed when Home Assistant is linked to more than one Larder.",
        "required": False,
        "advanced": True,
        "selector": {"config_entry": {"integration": DOMAIN}},
    }
    return {"name": action["name"], "description": action["description"], "fields": fields}


def _entry_for(hass: HomeAssistant, call: ServiceCall) -> Any:
    entries = [e for e in hass.config_entries.async_entries(DOMAIN) if e.state is ConfigEntryState.LOADED]
    wanted = call.data.get(ATTR_CONFIG_ENTRY_ID)
    if wanted:
        entries = [e for e in entries if e.entry_id == wanted]
    if not entries:
        raise ServiceValidationError("Larder isn't connected. Check the Larder integration.")
    if len(entries) > 1:
        raise ServiceValidationError("Home Assistant is linked to more than one Larder. Say which with config_entry_id.")
    return entries[0]


def _wanted(hass: HomeAssistant) -> dict[str, dict[str, Any]]:
    """Every connected Larder's actions together (the first to offer one describes it), or the bundled ones."""
    lists: dict[str, list[dict[str, Any]]] = hass.data.get(PER_ENTRY, {})
    wanted: dict[str, dict[str, Any]] = {}
    for actions in lists.values() if lists else [hass.data.get(BUNDLED, [])]:
        for action in actions:
            wanted.setdefault(action["id"], action)
    return wanted


@callback
def async_update_actions(hass: HomeAssistant, actions: list[dict[str, Any]], entry_id: str | None = None) -> None:
    """Record one Larder's actions (or the bundled ones) and make Home Assistant's match: add new ones, remove gone ones."""
    if entry_id is None:
        hass.data[BUNDLED] = actions
    else:
        hass.data.setdefault(PER_ENTRY, {})[entry_id] = actions
    _apply(hass)


@callback
def _apply(hass: HomeAssistant) -> None:
    registered: dict[str, dict[str, Any]] = hass.data.setdefault(REGISTERED, {})
    wanted = _wanted(hass)

    for name in [n for n in registered if n not in wanted]:
        hass.services.async_remove(DOMAIN, name)
        registered.pop(name)

    for name, action in wanted.items():
        if registered.get(name) == action:
            continue

        async def handle(call: ServiceCall, name: str = name) -> ServiceResponse:
            entry = _entry_for(hass, call)
            data = {k: v for k, v in call.data.items() if k != ATTR_CONFIG_ENTRY_ID}
            try:
                result = await entry.runtime_data.client.run_action(name, data)
            except LarderConnectionError as err:
                raise HomeAssistantError(err.message) from err
            except LarderError as err:
                # Larder's messages say what went wrong and how to fix it, e.g. which items a name could mean.
                raise ServiceValidationError(err.message) from err
            # Sensors follow straight away rather than waiting for the live event.
            await entry.runtime_data.coordinator.async_request_refresh()
            return result if call.return_response else None

        if hass.services.has_service(DOMAIN, name):
            hass.services.async_remove(DOMAIN, name)
        hass.services.async_register(DOMAIN, name, handle, schema=build_schema(action), supports_response=SupportsResponse.OPTIONAL)
        async_set_service_schema(hass, DOMAIN, name, build_description(action))
        registered[name] = action


async def async_setup_actions(hass: HomeAssistant) -> None:
    """Register the bundled actions when Home Assistant starts."""
    bundled = await hass.async_add_executor_job(lambda: json.loads(BUNDLED_FILE.read_text(encoding="utf-8")))
    async_update_actions(hass, bundled)


@callback
def async_reset_actions(hass: HomeAssistant, entry_id: str) -> None:
    """A Larder was unloaded: drop its actions (back to the bundled ones when none is left)."""
    hass.data.get(PER_ENTRY, {}).pop(entry_id, None)
    _apply(hass)
