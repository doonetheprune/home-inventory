"""Keeps Larder's sensor readings and its list of sensors and actions."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import LarderAuthError, LarderClient, LarderError
from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

# Live events trigger refreshes; this is only a safety net.
UPDATE_INTERVAL = timedelta(minutes=10)


@dataclass
class LarderData:
    """What Larder offers right now, and the latest readings."""

    sensors: list[dict[str, Any]] = field(default_factory=list)
    actions: list[dict[str, Any]] = field(default_factory=list)
    state: dict[str, dict[str, Any]] = field(default_factory=dict)
    modules: dict[str, bool] = field(default_factory=dict)


class LarderCoordinator(DataUpdateCoordinator[LarderData]):
    """Reads Larder's automation endpoints."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, client: LarderClient) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=UPDATE_INTERVAL,
            # Many changes arrive together (a shopping trip); read once they settle.
            request_refresh_debouncer=Debouncer(hass, _LOGGER, cooldown=2, immediate=False),
        )
        self.client = client

    async def _async_update_data(self) -> LarderData:
        try:
            manifest = await self.client.manifest()
            state = await self.client.state()
            modules = {m["id"]: bool(m["enabled"]) for m in await self.client.modules()}
        except LarderAuthError as err:
            raise ConfigEntryAuthFailed(err.message) from err
        except LarderError as err:
            raise UpdateFailed(err.message) from err
        return LarderData(sensors=manifest["sensors"], actions=manifest["actions"], state=state, modules=modules)
