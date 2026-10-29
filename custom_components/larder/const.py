"""Constants for the Larder integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "larder"

CONF_TOKEN: Final = "token"
CONF_URL: Final = "url"
CONF_ADDON_SLUG: Final = "addon_slug"

# Options
CONF_BATTERY_THRESHOLD: Final = "battery_threshold"
CONF_FORWARD_TAGS: Final = "forward_tags"
DEFAULT_BATTERY_THRESHOLD: Final = 20
DEFAULT_FORWARD_TAGS: Final = True

# Larder events arrive as "stock.low" and are fired in Home Assistant as "larder_stock_low".
EVENT_PREFIX: Final = "larder_"
# Internal Larder events that mean nothing outside it.
IGNORED_EVENTS: Final = ("search.",)
# Events after which sensors should be read again.
REFRESH_EVENTS: Final = ("stock.", "product.", "place.", "shop.", "category.", "settings.", "shopping.", "batteries.")

ATTR_CONFIG_ENTRY_ID: Final = "config_entry_id"

BATTERIES_MODULE: Final = "batteries"
