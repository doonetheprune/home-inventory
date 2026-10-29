"""Shared bits for Larder entities."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo

from .const import CONF_ADDON_SLUG, DOMAIN
from .coordinator import LarderCoordinator


def device_info(coordinator: LarderCoordinator, version: str | None) -> DeviceInfo:
    """One Larder device per config entry, so its sensors are grouped together."""
    entry = coordinator.config_entry
    slug = entry.data.get(CONF_ADDON_SLUG)
    return DeviceInfo(
        identifiers={(DOMAIN, entry.unique_id or entry.entry_id)},
        name="Larder",
        manufacturer="Larder",
        model="Home inventory",
        sw_version=version,
        entry_type=DeviceEntryType.SERVICE,
        # The add-on opens inside Home Assistant; elsewhere, its own address.
        configuration_url=f"homeassistant://hassio/ingress/{slug}" if slug else coordinator.client.url,
    )
