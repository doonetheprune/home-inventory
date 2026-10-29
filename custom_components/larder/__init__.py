"""The Larder integration: sensors, actions and events for a Larder home inventory.

Larder runs as a Home Assistant add-on or anywhere on the network. This
integration talks to it only through its REST API with an access token:

- sensors: running low, use soon, out of place, shopping list, deliveries,
  plus any a Larder module adds (battery linking adds "Batteries low");
- actions: larder.add_stock, larder.use_stock, larder.move_item and the
  rest, taking names ("loo roll", "G2-4") and returning Larder's answer;
- events: Larder's changes fired as larder_stock_changed, larder_stock_low,
  larder_stock_expiring, larder_nfc_scanned, larder_batteries_low…;
- NFC: tags scanned with the Home Assistant app are sent to Larder;
- batteries: devices with batteries are sent to Larder, and low ones reported;
- MCP: Larder's tools for AI assistants at /api/larder/mcp, so they work
  wherever Home Assistant is reachable (Nabu Casa included).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.typing import ConfigType

from .api import LarderAuthError, LarderClient, LarderError
from .batteries import BatteryWatcher
from .const import (
    BATTERIES_MODULE,
    CONF_BATTERY_THRESHOLD,
    CONF_FORWARD_TAGS,
    CONF_TOKEN,
    CONF_URL,
    DEFAULT_BATTERY_THRESHOLD,
    DEFAULT_FORWARD_TAGS,
    DOMAIN,
)
from .coordinator import LarderCoordinator
from .events import listen
from .mcp import LarderMcpView
from .nfc import async_track_tags
from .services import async_reset_actions, async_setup_actions, async_update_actions

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


@dataclass
class LarderRuntime:
    """Everything one connected Larder needs while it's loaded."""

    client: LarderClient
    coordinator: LarderCoordinator
    version: str | None
    batteries: BatteryWatcher | None = None
    unsubs: list[CALLBACK_TYPE] = field(default_factory=list)


type LarderConfigEntry = ConfigEntry[LarderRuntime]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register Larder's actions (so automations can use them even before Larder is reachable) and the MCP pass-through."""
    await async_setup_actions(hass)
    hass.http.register_view(LarderMcpView(hass))
    return True


async def async_setup_entry(hass: HomeAssistant, entry: LarderConfigEntry) -> bool:
    """Connect to Larder."""
    client = LarderClient(async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_TOKEN])
    try:
        status = await client.status()
    except LarderAuthError as err:
        raise ConfigEntryAuthFailed(err.message) from err
    except LarderError as err:
        raise ConfigEntryNotReady(err.message) from err

    coordinator = LarderCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    runtime = LarderRuntime(client=client, coordinator=coordinator, version=status.get("version"))
    entry.runtime_data = runtime

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Actions follow Larder's list, which changes when modules are switched on or off.
    async_update_actions(hass, coordinator.data.actions, entry.entry_id)
    runtime.unsubs.append(coordinator.async_add_listener(lambda: async_update_actions(hass, coordinator.data.actions, entry.entry_id)))

    entry.async_create_background_task(hass, listen(hass, client, coordinator), f"{DOMAIN} live events")

    if entry.options.get(CONF_FORWARD_TAGS, DEFAULT_FORWARD_TAGS):
        runtime.unsubs.append(async_track_tags(hass, client))

    @callback
    def batteries_follow_module() -> None:
        """Watch batteries only while Larder's battery module is on."""
        on = coordinator.data.modules.get(BATTERIES_MODULE, False)
        if on and runtime.batteries is None:
            runtime.batteries = BatteryWatcher(hass, client, entry.options.get(CONF_BATTERY_THRESHOLD, DEFAULT_BATTERY_THRESHOLD))
            entry.async_create_background_task(hass, runtime.batteries.async_start(), f"{DOMAIN} batteries")
        elif not on and runtime.batteries is not None:
            runtime.batteries.async_stop()
            runtime.batteries = None

    # Battery sensors from other integrations may still be loading; wait until Home Assistant has started.
    @callback
    def started(_hass: HomeAssistant) -> None:
        batteries_follow_module()
        runtime.unsubs.append(coordinator.async_add_listener(batteries_follow_module))

    runtime.unsubs.append(async_at_started(hass, started))

    entry.async_on_unload(entry.add_update_listener(_options_updated))
    return True


async def _options_updated(hass: HomeAssistant, entry: LarderConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: LarderConfigEntry) -> bool:
    """Disconnect from Larder."""
    runtime = entry.runtime_data
    for unsub in runtime.unsubs:
        unsub()
    if runtime.batteries:
        runtime.batteries.async_stop()
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        async_reset_actions(hass, entry.entry_id)
    return unloaded
