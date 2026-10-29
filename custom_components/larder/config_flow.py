"""Setting up Larder in Home Assistant.

- The Larder add-on announces itself (Supervisor discovery) with its address
  and a token, so it only needs confirming.
- Larder running elsewhere: enter its address and an access token made in
  Larder under Settings → Access tokens.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
import voluptuous as vol

from .api import LarderAuthError, LarderClient, LarderError
from .const import (
    CONF_ADDON_SLUG,
    CONF_BATTERY_THRESHOLD,
    CONF_FORWARD_TAGS,
    CONF_TOKEN,
    CONF_URL,
    DEFAULT_BATTERY_THRESHOLD,
    DEFAULT_FORWARD_TAGS,
    DOMAIN,
)


class LarderConfigFlow(ConfigFlow, domain=DOMAIN):
    """Connect Home Assistant to a Larder."""

    VERSION = 1

    def __init__(self) -> None:
        self._discovered: dict[str, Any] = {}

    async def _check(self, url: str, token: str) -> tuple[dict[str, Any] | None, str | None]:
        """Ask Larder who the token belongs to. Returns its status, or an error key."""
        try:
            return await LarderClient(async_get_clientsession(self.hass), url, token).status(), None
        except LarderAuthError:
            return None, "invalid_auth"
        except LarderError:
            return None, "cannot_connect"

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Larder's address and an access token."""
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            status, error = await self._check(url, user_input[CONF_TOKEN].strip())
            if status:
                await self.async_set_unique_id(status["instanceId"])
                self._abort_if_unique_id_configured(updates={CONF_URL: url, CONF_TOKEN: user_input[CONF_TOKEN].strip()})
                return self.async_create_entry(title="Larder", data={CONF_URL: url, CONF_TOKEN: user_input[CONF_TOKEN].strip()})
            errors["base"] = error or "unknown"
        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(
                vol.Schema({vol.Required(CONF_URL): str, vol.Required(CONF_TOKEN): str}),
                user_input or {CONF_URL: "http://larder.local:8080"},
            ),
            errors=errors,
        )

    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        """The Larder add-on said where it is."""
        config = discovery_info.config
        url = f"http://{config['host']}:{config['port']}"
        status, error = await self._check(url, config["token"])
        if not status:
            return self.async_abort(reason=error or "cannot_connect")
        await self.async_set_unique_id(status["instanceId"])
        self._abort_if_unique_id_configured(updates={CONF_URL: url, CONF_TOKEN: config["token"], CONF_ADDON_SLUG: discovery_info.slug})
        self._discovered = {CONF_URL: url, CONF_TOKEN: config["token"], CONF_ADDON_SLUG: discovery_info.slug}
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Confirm setting up the add-on."""
        if user_input is not None:
            return self.async_create_entry(title="Larder", data=self._discovered)
        self._set_confirm_only()
        return self.async_show_form(step_id="hassio_confirm")

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """Larder stopped accepting the token."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """A new access token."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            status, error = await self._check(entry.data[CONF_URL], user_input[CONF_TOKEN].strip())
            if status:
                return self.async_update_reload_and_abort(entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN].strip()})
            errors["base"] = error or "unknown"
        return self.async_show_form(step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_TOKEN): str}), errors=errors, description_placeholders={"url": entry.data[CONF_URL]})

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Larder moved, or has a new token."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            status, error = await self._check(url, user_input[CONF_TOKEN].strip())
            if status:
                await self.async_set_unique_id(status["instanceId"])
                self._abort_if_unique_id_mismatch(reason="wrong_larder")
                return self.async_update_reload_and_abort(entry, data_updates={CONF_URL: url, CONF_TOKEN: user_input[CONF_TOKEN].strip()})
            errors["base"] = error or "unknown"
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=self.add_suggested_values_to_schema(vol.Schema({vol.Required(CONF_URL): str, vol.Required(CONF_TOKEN): str}), user_input or {CONF_URL: entry.data[CONF_URL]}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> LarderOptionsFlow:
        """Options: battery threshold and NFC forwarding."""
        return LarderOptionsFlow()


class LarderOptionsFlow(OptionsFlow):
    """Battery threshold and NFC tag forwarding."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """The options form."""
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        options = self.config_entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                vol.Required(CONF_BATTERY_THRESHOLD, default=options.get(CONF_BATTERY_THRESHOLD, DEFAULT_BATTERY_THRESHOLD)): vol.All(vol.Coerce(int), vol.Range(min=1, max=99)),
                vol.Required(CONF_FORWARD_TAGS, default=options.get(CONF_FORWARD_TAGS, DEFAULT_FORWARD_TAGS)): bool,
            }),
        )
