"""Battery linking: tells Larder which devices have batteries, and when one runs low.

Every device with a battery sensor (a percentage, or a "battery low" binary
sensor) is sent to Larder's battery module with its level. When a device
drops below the threshold (20% unless changed in the integration's options),
Larder is told, and answers with what to do: swap in a charged spare, charge
some flat ones, use a spare, or put batteries on the shopping list. That
answer arrives as the "larder_batteries_low" event.

If the Battery Notes integration is installed, its battery type and count
are sent too, so Larder can suggest which battery product a device takes.
"""

from __future__ import annotations

from datetime import timedelta
import logging
from typing import Any

from homeassistant.const import STATE_ON, STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_interval

from .api import LarderClient, LarderError

_LOGGER = logging.getLogger(__name__)

RESYNC_EVERY = timedelta(hours=6)
RETRY_AFTER = 60
# A device counts as recovered a little above the threshold, so a level hovering around it doesn't flap.
HYSTERESIS = 5


class BatteryWatcher:
    """Keeps Larder's device list up to date and reports low batteries."""

    def __init__(self, hass: HomeAssistant, client: LarderClient, threshold: float) -> None:
        self.hass = hass
        self.client = client
        self.threshold = threshold
        self._low: dict[str, bool] = {}
        self._loaded = False
        self._retry: CALLBACK_TYPE | None = None
        self._unsubs: list[CALLBACK_TYPE] = []
        self._track: CALLBACK_TYPE | None = None
        self._debounced = Debouncer(hass, _LOGGER, cooldown=30, immediate=False, function=self.async_sync)

    async def async_start(self) -> None:
        """Send the first list, then follow changes."""
        await self.async_sync(first=True)
        self._unsubs.append(async_track_time_interval(self.hass, self._on_timer, RESYNC_EVERY))
        self._unsubs.append(self.hass.bus.async_listen(er.EVENT_ENTITY_REGISTRY_UPDATED, self._on_registry))
        self._unsubs.append(self.hass.bus.async_listen(dr.EVENT_DEVICE_REGISTRY_UPDATED, self._on_registry))

    @callback
    def async_stop(self) -> None:
        """Stop watching."""
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self._track:
            self._track()
            self._track = None
        if self._retry:
            self._retry()
            self._retry = None
        self._debounced.async_cancel()

    async def _on_timer(self, _now: Any) -> None:
        self._retry = None
        await self.async_sync()

    async def _on_registry(self, _event: Event) -> None:
        await self._debounced.async_call()

    def _battery_entities(self) -> dict[str, list[er.RegistryEntry]]:
        """Battery sensors, grouped by the device they belong to."""
        out: dict[str, list[er.RegistryEntry]] = {}
        for entry in er.async_get(self.hass).entities.values():
            if not entry.device_id or entry.disabled_by or entry.domain not in ("sensor", "binary_sensor"):
                continue
            if (entry.device_class or entry.original_device_class) != "battery":
                continue
            out.setdefault(entry.device_id, []).append(entry)
        return out

    def _level(self, entities: list[er.RegistryEntry]) -> float | None:
        for entry in entities:
            if entry.domain != "sensor":
                continue
            state = self.hass.states.get(entry.entity_id)
            if state is None or state.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
                continue
            try:
                return max(0.0, min(100.0, float(state.state)))
            except ValueError:
                continue
        return None

    def _is_low(self, device_id: str, entities: list[er.RegistryEntry], level: float | None) -> bool:
        was_low = self._low.get(device_id, False)
        binary_seen = False
        for entry in entities:
            if entry.domain == "binary_sensor":
                state = self.hass.states.get(entry.entity_id)
                if state is None or state.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
                    continue
                if state.state == STATE_ON:
                    return True
                binary_seen = True
        if level is None:
            # No reading right now (a sleepy device, or just after a restart): nothing has changed.
            return False if binary_seen else was_low
        return level < (self.threshold + HYSTERESIS if was_low else self.threshold)

    def _battery_notes(self, device_id: str) -> tuple[str | None, int | None]:
        """Battery type and count from the Battery Notes integration, if it's installed."""
        for entry in er.async_entries_for_device(er.async_get(self.hass), device_id):
            state = self.hass.states.get(entry.entity_id)
            if state is None or "battery_type" not in state.attributes:
                continue
            kind = state.attributes.get("battery_type")
            try:
                count = int(state.attributes.get("battery_quantity") or 0) or None
            except (TypeError, ValueError):
                count = None
            if count is not None and not 1 <= count <= 50:
                count = None
            return (str(kind)[:40] if kind else None), count
        return None, None

    def _devices(self, grouped: dict[str, list[er.RegistryEntry]]) -> list[dict[str, Any]]:
        devices = dr.async_get(self.hass)
        areas = ar.async_get(self.hass)
        out = []
        for device_id, entities in grouped.items():
            device = devices.async_get(device_id)
            if device is None:
                continue
            level = self._level(entities)
            area_id = device.area_id
            area = areas.async_get_area(area_id) if area_id else None
            kind, count = self._battery_notes(device_id)
            out.append({
                "id": device_id[:100],
                "name": (device.name_by_user or device.name or device_id)[:120],
                "area": area.name[:120] if area else None,
                "level": round(level) if level is not None else None,
                "low": self._is_low(device_id, entities, level),
                "batteryType": kind,
                "batteryQuantity": count,
            })
        return out

    async def async_sync(self, first: bool = False) -> None:
        """Send the device list to Larder and report any device that has gone low."""
        grouped = self._battery_entities()
        # Follow the readings whatever happens below, so a low battery is never missed.
        self._follow([e.entity_id for entities in grouped.values() for e in entities])
        try:
            if first or not self._loaded:
                # Larder remembers which were low, so a restart doesn't report them again.
                known = await self.client.battery_devices()
                self._low = {d["id"]: bool(d.get("low")) for d in known} | self._low
                self._loaded = True
            devices = self._devices(grouped)
            await self.client.sync_battery_devices(devices)
        except LarderError as err:
            _LOGGER.warning("Couldn't send the battery devices to Larder (trying again in a minute): %s", err.message)
            self._retry = async_call_later(self.hass, RETRY_AFTER, self._on_timer)
            return
        for d in devices:
            if d["low"] and not self._low.get(d["id"], False):
                await self._report_low(d["id"], d["level"])
            self._low[d["id"]] = d["low"]

    def _follow(self, entity_ids: list[str]) -> None:
        if self._track:
            self._track()
        self._track = async_track_state_change_event(self.hass, entity_ids, self._on_state) if entity_ids else None

    async def _report_low(self, device_id: str, level: float | None) -> None:
        try:
            await self.client.battery_low(device_id, level)
        except LarderError as err:
            _LOGGER.warning("Couldn't tell Larder a battery is low: %s", err.message)

    async def _on_state(self, event: Event[EventStateChangedData]) -> None:
        """A battery reading changed: report a new low straight away, and send levels soon."""
        entry = er.async_get(self.hass).async_get(event.data["entity_id"])
        if entry is None or entry.device_id is None:
            return
        entities = self._battery_entities().get(entry.device_id, [])
        level = self._level(entities)
        low = self._is_low(entry.device_id, entities, level)
        if low and not self._low.get(entry.device_id, False):
            self._low[entry.device_id] = True
            await self._report_low(entry.device_id, round(level) if level is not None else None)
        elif not low:
            self._low[entry.device_id] = False
        await self._debounced.async_call()
