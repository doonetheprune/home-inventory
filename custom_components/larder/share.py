"""Sharing: links shared to the Home Assistant app go on Larder's wish list.

On Android, sharing to Home Assistant (the share menu, then Home Assistant)
fires "mobile_app.share" with the link and any text. This sends it to
Larder's sharing module, which reads the page and adds the item to the wish
list, then tells the phone that shared it what happened, with a tap that
opens the item in Larder.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.util import slugify

from .api import LarderClient, LarderError

_LOGGER = logging.getLogger(__name__)

EVENT_SHARE = "mobile_app.share"
LINK = re.compile(r"https?://\S+", re.IGNORECASE)


def _phone(hass: HomeAssistant, device_id: str | None) -> tuple[str | None, str | None]:
    """The phone's name, and its notify action (notify.mobile_app_<name>) if there is one."""
    if not device_id:
        return None, None
    device = dr.async_get(hass).async_get(device_id)
    if device is None:
        return None, None
    name = device.name_by_user or device.name
    for entry_id in device.config_entries:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is not None and entry.domain == "mobile_app" and entry.data.get("device_name"):
            service = f"mobile_app_{slugify(entry.data['device_name'])}"
            if hass.services.has_service("notify", service):
                return name, service
    return name, None


@callback
def async_track_shares(hass: HomeAssistant, client: LarderClient):
    """Send every shared link to Larder. Returns the function that stops it."""

    async def forward(event: Event) -> None:
        data = event.data
        url, text, subject = data.get("url"), data.get("text"), data.get("subject")
        # Some apps share only text, with the link inside it; shares without a link aren't for Larder.
        if not any(isinstance(v, str) and LINK.search(v) for v in (url, text, subject)):
            return
        name, notify = _phone(hass, data.get("device_id"))
        body: dict[str, Any] = {"url": url, "text": text, "subject": subject, "app": data.get("caller"), "device": name}
        try:
            result = await client.share_link(body)
        except LarderError as err:
            # The sharing module may be switched off in Larder: then shares aren't for it.
            if err.status != 404:
                _LOGGER.warning("Couldn't put a shared link on Larder's wish list: %s", err.message)
                if notify:
                    await _tell(hass, notify, f"Larder couldn't add that: {err.message}", None)
            return
        if notify:
            await _tell(hass, notify, result.get("message", "Added to the wish list."), result.get("appLink"))

    return hass.bus.async_listen(EVENT_SHARE, forward)


async def _tell(hass: HomeAssistant, service: str, message: str, link: str | None) -> None:
    """A notification on the phone that shared; tapping it opens the item in Larder."""
    data: dict[str, Any] = {"tag": "larder-share", "group": "larder"}
    if link:
        data.update({"clickAction": link, "url": link})
    try:
        await hass.services.async_call("notify", service, {"title": "Larder", "message": message, "data": data}, blocking=False)
    except Exception as err:  # noqa: BLE001 - a failed notification mustn't break sharing
        _LOGGER.warning("Couldn't tell the phone about a shared link: %s", err)
