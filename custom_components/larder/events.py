"""Larder's live events, fired in Home Assistant.

Larder's "stock.low" becomes Home Assistant's "larder_stock_low", with the
same data, so automations and Node-RED can react. Changes also refresh the
sensors straight away.
"""

from __future__ import annotations

import asyncio
import logging

from homeassistant.core import HomeAssistant

from .api import LarderAuthError, LarderClient, LarderError
from .const import EVENT_PREFIX, IGNORED_EVENTS, REFRESH_EVENTS
from .coordinator import LarderCoordinator

_LOGGER = logging.getLogger(__name__)

RETRY_MIN = 2
RETRY_MAX = 120


def ha_event_type(larder_type: str) -> str:
    """'stock.low' -> 'larder_stock_low'."""
    return EVENT_PREFIX + larder_type.replace(".", "_").replace("-", "_")


async def listen(hass: HomeAssistant, client: LarderClient, coordinator: LarderCoordinator) -> None:
    """Follow Larder's events until cancelled, reconnecting with a growing pause."""
    delay = RETRY_MIN
    while True:
        try:
            connected = False
            async for kind, data in client.events():
                if not connected:
                    connected = True
                    delay = RETRY_MIN
                    # Catch up on anything missed while disconnected.
                    await coordinator.async_request_refresh()
                if kind.startswith(IGNORED_EVENTS):
                    continue
                hass.bus.async_fire(ha_event_type(kind), data)
                if kind.startswith(REFRESH_EVENTS):
                    await coordinator.async_request_refresh()
            _LOGGER.debug("Larder closed the live connection; reconnecting")
        except asyncio.CancelledError:
            raise
        except LarderAuthError as err:
            _LOGGER.warning("Larder refused the token for live events: %s", err.message)
            delay = RETRY_MAX
        except LarderError as err:
            _LOGGER.debug("Live connection to Larder failed: %s", err.message)
        await asyncio.sleep(delay)
        delay = min(delay * 2, RETRY_MAX)
