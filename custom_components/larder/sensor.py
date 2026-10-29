"""Larder sensors: running low, use soon, out of place, shopping list, deliveries, and any a module adds.

Larder says which sensors exist (GET /api/v1/automation), so a module that
adds one, such as battery linking, appears here without changing this file.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import LarderConfigEntry
from .coordinator import LarderCoordinator
from .entity import device_info


async def async_setup_entry(hass: HomeAssistant, entry: LarderConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    """Add a sensor for each one Larder offers, now and whenever a new one appears."""
    coordinator = entry.runtime_data.coordinator
    added: set[str] = set()

    @callback
    def add_new() -> None:
        new = [s for s in coordinator.data.sensors if s["id"] not in added]
        added.update(s["id"] for s in new)
        if new:
            async_add_entities(LarderSensor(coordinator, s, entry.runtime_data.version) for s in new)

    add_new()
    entry.async_on_unload(coordinator.async_add_listener(add_new))


class LarderSensor(CoordinatorEntity[LarderCoordinator], SensorEntity):
    """One of Larder's sensors."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: LarderCoordinator, info: dict[str, Any], version: str | None) -> None:
        super().__init__(coordinator)
        self._key = info["id"]
        entry = coordinator.config_entry
        self._attr_unique_id = f"{entry.unique_id or entry.entry_id}_{self._key}"
        self._attr_name = info["name"]
        self._attr_icon = info.get("icon")
        self._attr_native_unit_of_measurement = info.get("unit")
        self._attr_device_info = device_info(coordinator, version)
        # Lists of items change all the time; don't record them in history.
        self._unrecorded_attributes = frozenset({"items", "devices", "deliveries", "shops"})
        self._attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def _reading(self) -> dict[str, Any] | None:
        return self.coordinator.data.state.get(self._key)

    @property
    def available(self) -> bool:
        """Unavailable when Larder can't be reached, or the module that adds it is switched off."""
        return super().available and self._reading is not None and self._reading.get("state") is not None

    @property
    def native_value(self) -> Any:
        """The sensor's number."""
        reading = self._reading
        return reading.get("state") if reading else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """The items behind the number."""
        reading = self._reading
        return reading.get("attributes") if reading else None
