"""NFC: tags scanned with the Home Assistant app are sent to Larder.

Larder says what the tag belongs to (a product or a place) and fires
"nfc.scanned", which arrives back here as the Home Assistant event
"larder_nfc_scanned" with the product or place. Unknown tags can then be
linked from the product or place page in Larder.
"""

from __future__ import annotations

import logging

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr

from .api import LarderClient, LarderError

_LOGGER = logging.getLogger(__name__)

EVENT_TAG_SCANNED = "tag_scanned"


@callback
def async_track_tags(hass: HomeAssistant, client: LarderClient):
    """Forward every tag scan to Larder. Returns the function that stops it."""

    async def forward(event: Event) -> None:
        tag_id = event.data.get("tag_id")
        if not tag_id:
            return
        device = None
        if device_id := event.data.get("device_id"):
            entry = dr.async_get(hass).async_get(device_id)
            device = (entry.name_by_user or entry.name) if entry else None
        try:
            await client.nfc_scanned(str(tag_id), device)
        except LarderError as err:
            _LOGGER.warning("Couldn't tell Larder about tag %s: %s", tag_id, err.message)

    return hass.bus.async_listen(EVENT_TAG_SCANNED, forward)
