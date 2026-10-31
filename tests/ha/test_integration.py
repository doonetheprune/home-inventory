"""The Larder integration against a real Larder server."""

from __future__ import annotations

import asyncio
from typing import Any
import uuid

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
import pytest
from pytest_homeassistant_custom_component.common import async_capture_events

from custom_components.larder.const import CONF_ADDON_SLUG, CONF_TOKEN, CONF_URL, DOMAIN

from .conftest import Larder


def unique(name: str) -> str:
    """Product names unique to a test, since the Larder server is shared."""
    return f"{name} {uuid.uuid4().hex[:6]}"


async def wait_for(check, timeout: float = 5.0) -> Any:
    """Poll until check() returns something truthy."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        result = await check()
        if result:
            return result
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.1)


async def test_set_up_by_hand(hass: HomeAssistant, larder: Larder) -> None:
    """Address and token: bad ones are explained, a good one creates the entry."""
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_URL: larder.url, CONF_TOKEN: "lrd_wrong"})
    assert result["errors"] == {"base": "invalid_auth"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_URL: "http://127.0.0.1:1", CONF_TOKEN: "lrd_x"})
    assert result["errors"] == {"base": "cannot_connect"}

    token = await larder.new_token()
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_URL: f"{larder.url}/", CONF_TOKEN: token})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_URL: larder.url, CONF_TOKEN: token}
    status = await larder.call("GET", "/auth/status")
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    assert entry.unique_id == status["instanceId"]
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED

    # The same Larder again is refused.
    again = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    again = await hass.config_entries.flow.async_configure(again["flow_id"], {CONF_URL: larder.url, CONF_TOKEN: token})
    assert again["type"] is FlowResultType.ABORT
    assert again["reason"] == "already_configured"
    await hass.config_entries.async_unload(entry.entry_id)


async def test_add_on_discovery(hass: HomeAssistant, larder: Larder) -> None:
    """The add-on announces itself; it only needs confirming."""
    host, port = larder.url.removeprefix("http://").split(":")
    info = HassioServiceInfo(config={"host": host, "port": int(port), "token": await larder.new_token()}, name="Larder", slug="abc123_larder", uuid="1234")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=info)
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_ADDON_SLUG] == "abc123_larder"
    await hass.async_block_till_done()
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    await hass.config_entries.async_unload(entry.entry_id)


async def test_sensors_follow_larder(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """Core sensors appear, with their items, and update when stock changes."""
    state = hass.states.get("sensor.larder_running_low")
    assert state is not None
    assert state.attributes["unit_of_measurement"] == "items"
    assert state.attributes["icon"] == "mdi:cart-arrow-down"
    for entity in ("sensor.larder_use_soon", "sensor.larder_out_of_place", "sensor.larder_shopping_list", "sensor.larder_deliveries_on_the_way", "sensor.larder_batteries_low"):
        assert hass.states.get(entity) is not None, entity

    before = int(state.state)
    name = unique("Kitchen roll")
    await larder.call("POST", "/products", {"name": name, "minQuantity": 2})

    async def low_went_up():
        s = hass.states.get("sensor.larder_running_low")
        return s and int(s.state) == before + 1 and any(i["item"] == name for i in s.attributes["items"])

    # The live event from Larder refreshes the sensor without waiting for the poll.
    await wait_for(low_went_up)


async def test_actions_take_names_and_answer(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """larder.add_stock and friends work by name and return Larder's message."""
    name = unique("Baked beans")
    await larder.call("POST", "/products", {"name": name, "unit": "tin"})
    response = await hass.services.async_call(DOMAIN, "add_stock", {"item": name.lower(), "quantity": 3}, blocking=True, return_response=True)
    assert response["message"] == f"{name}: added 3 tins. 3 tins in stock."
    assert response["in_stock"] == 3

    response = await hass.services.async_call(DOMAIN, "use_stock", {"item": name}, blocking=True, return_response=True)
    assert response["in_stock"] == 2

    # Without asking for a response it still works.
    await hass.services.async_call(DOMAIN, "add_to_shopping_list", {"item": name}, blocking=True)
    summary = (await larder.call("GET", "/search?q=" + name.replace(" ", "%20")))["sections"]
    assert any(s["id"] == "shopping" for s in summary)

    # Dates from the UI are sent as YYYY-MM-DD.
    response = await hass.services.async_call(DOMAIN, "add_stock", {"item": name, "expires_on": "2030-01-31"}, blocking=True, return_response=True)
    assert response["next_expiry"] == "2030-01-31"


async def test_unclear_names_are_explained(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """A name that matches two things says which, instead of guessing."""
    tag = uuid.uuid4().hex[:6]
    await larder.call("POST", "/products", {"name": f"AA cells {tag}"})
    await larder.call("POST", "/products", {"name": f"AAA cells {tag}"})
    with pytest.raises(ServiceValidationError, match="could be"):
        await hass.services.async_call(DOMAIN, "use_stock", {"item": f"cells {tag}"}, blocking=True)


async def test_actions_have_descriptions(hass: HomeAssistant, setup_larder) -> None:
    """Each action shows Larder's name, description and fields in Home Assistant."""
    from homeassistant.helpers.service import async_get_all_descriptions

    descriptions = (await async_get_all_descriptions(hass))[DOMAIN]
    add = descriptions["add_stock"]
    assert add["name"] == "Add stock"
    assert add["fields"]["item"]["required"] is True
    assert add["fields"]["expires_on"]["selector"] == {"date": {}}
    assert add["fields"]["quantity"]["default"] == 1
    # A module's action is there too.
    assert "batteries_replaced" in descriptions


async def test_larder_events_fire_in_home_assistant(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """stock.changed in Larder arrives as larder_stock_changed."""
    changed = async_capture_events(hass, "larder_stock_changed")
    low = async_capture_events(hass, "larder_stock_low")
    name = unique("Eggs")
    product = await larder.call("POST", "/products", {"name": name, "minQuantity": 6})
    await larder.call("POST", "/stock/add", {"productId": product["id"], "quantity": 12})
    await larder.call("POST", "/stock/use", {"productId": product["id"], "quantity": 8})

    async def arrived():
        return [e for e in changed if e.data.get("name") == name] and [e for e in low if e.data.get("name") == name]

    await wait_for(arrived)
    event = next(e for e in low if e.data["name"] == name)
    assert event.data["inStock"] == 4
    assert event.data["low"] is True


async def test_nfc_tags_are_sent_to_larder(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """A tag scanned with the app reaches Larder, which says what it is."""
    resolved = async_capture_events(hass, "larder_nfc_scanned")
    place = await larder.call("POST", "/places", {"name": unique("Camping box")})
    tag = f"tag-{uuid.uuid4().hex[:8]}"
    await larder.call("POST", "/nfc/link", {"tagId": tag, "placeId": place["id"]})

    hass.bus.async_fire("tag_scanned", {"tag_id": tag, "device_id": None})

    async def back():
        return [e for e in resolved if e.data.get("tagId") == tag]

    event = (await wait_for(back))[0]
    assert event.data["kind"] == "place"
    assert event.data["name"] == place["name"]


async def test_batteries_are_watched(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """Devices with battery sensors are sent to Larder; a low one gets advice."""
    from homeassistant.helpers import device_registry as dr, entity_registry as er
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    other = MockConfigEntry(domain="test")
    other.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(config_entry_id=other.entry_id, identifiers={("test", uuid.uuid4().hex)}, name="Hall smoke alarm")
    entity = er.async_get(hass).async_get_or_create("sensor", "test", uuid.uuid4().hex, device_id=device.id, original_device_class="battery")
    hass.states.async_set(entity.entity_id, "55", {"device_class": "battery", "unit_of_measurement": "%"})

    # The watcher starts once Home Assistant is running; re-sync now that the device exists.
    watcher = setup_larder.runtime_data.batteries
    assert watcher is not None
    await watcher.async_sync()

    devices = await larder.call("GET", "/modules/batteries/devices")
    mine = next(d for d in devices if d["id"] == device.id)
    assert mine["name"] == "Hall smoke alarm"
    assert mine["level"] == 55
    assert mine["low"] is False

    name = unique("9V batteries")
    battery = await larder.call("POST", "/products", {"name": name, "haDeviceIds": [device.id]})
    await larder.call("POST", "/stock/add", {"productId": battery["id"], "quantity": 2})

    advice = async_capture_events(hass, "larder_batteries_low")
    hass.states.async_set(entity.entity_id, "12", {"device_class": "battery", "unit_of_measurement": "%"})

    async def told():
        return [e for e in advice if e.data.get("deviceId") == device.id]

    event = (await wait_for(told))[0]
    assert event.data["kind"] == "spare"
    assert event.data["level"] == 12
    assert "There are 2 spares" in event.data["message"]


async def test_options_and_unload(hass: HomeAssistant, setup_larder) -> None:
    """Options change the battery threshold; actions stay after unloading and say Larder isn't connected."""
    result = await hass.config_entries.options.async_init(setup_larder.entry_id)
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"battery_threshold": 30, "forward_tags": False})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert setup_larder.runtime_data.batteries.threshold == 30

    assert hass.services.has_service(DOMAIN, "add_stock")
    await hass.config_entries.async_unload(setup_larder.entry_id)
    await hass.async_block_till_done()
    assert hass.services.has_service(DOMAIN, "add_stock")
    with pytest.raises(ServiceValidationError, match="isn't connected"):
        await hass.services.async_call(DOMAIN, "add_stock", {"item": "milk"}, blocking=True)


async def test_revoked_token_asks_for_a_new_one(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """When Larder stops accepting the token, Home Assistant asks to re-authenticate."""
    tokens = await larder.call("GET", "/auth/tokens")
    mine = next(t for t in tokens if t["prefix"] == setup_larder.data[CONF_TOKEN][:8])
    await larder.call("DELETE", f"/auth/tokens/{mine['id']}")
    await setup_larder.runtime_data.coordinator.async_refresh()
    await hass.async_block_till_done()
    flows = hass.config_entries.flow.async_progress()
    assert any(f["context"]["source"] == config_entries.SOURCE_REAUTH for f in flows)

    new = await larder.new_token()
    flow = next(f for f in flows if f["context"]["source"] == config_entries.SOURCE_REAUTH)
    result = await hass.config_entries.flow.async_configure(flow["flow_id"], {CONF_TOKEN: new})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    await hass.async_block_till_done()
    assert setup_larder.state is ConfigEntryState.LOADED
    assert setup_larder.data[CONF_TOKEN] == new


async def test_actions_exist_before_larder_is_connected(hass: HomeAssistant) -> None:
    """Automations that use Larder's actions load even if Larder is down when Home Assistant starts."""
    from homeassistant.setup import async_setup_component

    assert await async_setup_component(hass, DOMAIN, {})
    for name in ("add_stock", "use_stock", "move_item", "mark_arrived", "batteries_replaced"):
        assert hass.services.has_service(DOMAIN, name), name
    with pytest.raises(ServiceValidationError, match="isn't connected"):
        await hass.services.async_call(DOMAIN, "use_stock", {"item": "milk"}, blocking=True)


async def test_mcp_through_home_assistant(hass: HomeAssistant, hass_client, larder: Larder, setup_larder) -> None:
    """AI assistants reach Larder's tools through Home Assistant (and so through Nabu Casa)."""
    client = await hass_client()
    headers = {"accept": "application/json, text/event-stream", "content-type": "application/json"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}}
    resp = await client.post("/api/larder/mcp", json=init, headers=headers)
    assert resp.status == 200
    assert (await resp.json())["result"]["serverInfo"]["name"] == "larder"

    name = unique("Porridge oats")
    await larder.call("POST", "/products", {"name": name, "unit": "kg"})
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "add_stock", "arguments": {"item": name, "quantity": 2}}}
    resp = await client.post("/api/larder/mcp", json=call, headers={**headers, "mcp-protocol-version": "2025-06-18"})
    body = await resp.json()
    assert body["result"]["content"][0]["text"] == f"{name}: added 2 kg. 2 kg in stock."


async def test_mcp_needs_signing_in(hass: HomeAssistant, aiohttp_client, setup_larder) -> None:
    """Without a token, or with one neither Home Assistant nor Larder knows, the pass-through says where to sign in."""
    client = await aiohttp_client(hass.http.app)
    for headers in ({}, {"authorization": "Bearer lrd_not_a_real_token"}):
        resp = await client.post("/api/larder/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=headers)
        assert resp.status == 401
        assert resp.headers["WWW-Authenticate"].startswith('Bearer resource_metadata="http')
        assert resp.headers["WWW-Authenticate"].endswith('/.well-known/oauth-protected-resource/api/larder/mcp"')


async def _connector_sign_in(hass: HomeAssistant, client, credential, approve: str = "yes") -> tuple[str, dict[str, str]]:
    """What the Claude app does: find out how to sign in, register, sign in through Home Assistant, and say yes (or no)."""
    import base64
    import hashlib
    import re
    import secrets
    from urllib.parse import parse_qs, urlparse

    from homeassistant.components import auth as ha_auth

    resp = await client.post("/api/larder/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    resource_url = re.search(r'resource_metadata="([^"]+)"', resp.headers["WWW-Authenticate"]).group(1)
    resource = await (await client.get(urlparse(resource_url).path)).json()
    issuer = resource["authorization_servers"][0]
    # Home Assistant's address as the person reached it: its own idea of it (here http://127.0.0.1:8123, for Nabu Casa the cloud address).
    assert urlparse(resource["resource"]).path == "/api/larder/mcp"
    assert urlparse(issuer).path == "/api/larder/oauth"
    server = await (await client.get(f"/.well-known/oauth-authorization-server{urlparse(issuer).path}")).json()
    assert server["issuer"] == issuer
    assert server["code_challenge_methods_supported"] == ["S256"]

    redirect = "https://claude.ai/api/mcp/auth_callback"
    resp = await client.post(urlparse(server["registration_endpoint"]).path, json={"redirect_uris": [redirect], "client_name": "Claude"})
    assert resp.status == 201
    client_id = (await resp.json())["client_id"]
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = {"response_type": "code", "client_id": client_id, "redirect_uri": redirect, "code_challenge": challenge, "code_challenge_method": "S256", "state": "claude-state"}
    resp = await client.get(urlparse(server["authorization_endpoint"]).path, params=query, allow_redirects=False)
    # On to Home Assistant's own login, as a client on Home Assistant's own address.
    assert resp.status == 302
    login = urlparse(resp.headers["location"])
    assert login.path == "/auth/authorize"
    login_query = {k: v[0] for k, v in parse_qs(login.query).items()}
    assert urlparse(login_query["redirect_uri"]).path == "/api/larder/oauth/callback"
    assert login_query["client_id"] == f"{issuer}/"

    # Home Assistant's login page hands back a code for the person who logged in.
    ha_code = hass.data[ha_auth.DATA_STORE](login_query["client_id"], credential)
    resp = await client.get("/api/larder/oauth/callback", params={"code": ha_code, "state": login_query["state"]})
    page = await resp.text()
    assert resp.status == 200, page
    assert "Allow Claude to use Larder?" in page
    assert "claude.ai" in page
    key = re.search(r'name="key" value="([^"]+)"', page).group(1)
    resp = await client.post("/api/larder/oauth/approve", data={"key": key, "approve": approve}, allow_redirects=False)
    assert resp.status == 302, await resp.text()
    back = urlparse(resp.headers["location"])
    assert f"{back.scheme}://{back.netloc}{back.path}" == redirect
    answer = {k: v[0] for k, v in parse_qs(back.query).items()}
    assert answer["state"] == "claude-state"
    assert answer["iss"] == issuer
    if approve != "yes":
        return "", answer
    resp = await client.post(urlparse(server["token_endpoint"]).path, data={"grant_type": "authorization_code", "code": answer["code"], "code_verifier": verifier, "redirect_uri": redirect, "client_id": client_id})
    token = await resp.json()
    assert resp.status == 200, token
    return token["access_token"], answer


async def test_claude_app_signs_in_through_home_assistant(hass: HomeAssistant, aiohttp_client, larder: Larder, setup_larder, hass_admin_user, hass_admin_credential, monkeypatch) -> None:
    """Connectors that can't take a pasted token (the Claude app) sign in with Home Assistant's login and get a Larder token."""
    from homeassistant.setup import async_setup_component

    from custom_components.larder import oauth

    assert await async_setup_component(hass, "auth", {})
    await hass.auth.async_link_user(hass_admin_user, hass_admin_credential)
    client = await aiohttp_client(hass.http.app)
    monkeypatch.setattr(oauth, "_token_endpoints", lambda _hass, _request: [(str(client.make_url("/auth/token")), True)])
    before = {t.id for t in hass_admin_user.refresh_tokens.values()}

    token, _ = await _connector_sign_in(hass, client, hass_admin_credential)
    # Claude holds a Larder token, not a Home Assistant one; the Home Assistant session used to check who it was is gone.
    assert token.startswith("lrd_")
    assert {t.id for t in hass_admin_user.refresh_tokens.values()} == before
    names = [t["name"] for t in await larder.call("GET", "/auth/tokens")]
    assert "Claude (via claude.ai)" in names

    headers = {"authorization": f"Bearer {token}", "accept": "application/json, text/event-stream", "content-type": "application/json"}
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "claude", "version": "1"}}}
    resp = await client.post("/api/larder/mcp", json=init, headers=headers)
    assert resp.status == 200
    name = unique("Oat milk")
    await larder.call("POST", "/products", {"name": name, "unit": "carton"})
    call = {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "add_stock", "arguments": {"item": name, "quantity": 3}}}
    body = await (await client.post("/api/larder/mcp", json=call, headers={**headers, "mcp-protocol-version": "2025-06-18"})).json()
    assert body["result"]["content"][0]["text"] == f"{name}: added 3 cartons. 3 cartons in stock."


async def test_claude_app_sign_in_can_be_refused_and_expires(hass: HomeAssistant, aiohttp_client, setup_larder, hass_admin_user, hass_admin_credential, monkeypatch) -> None:
    """Cancel sends the assistant away empty-handed; an old or made-up sign-in is turned away."""
    from homeassistant.setup import async_setup_component

    from custom_components.larder import oauth

    assert await async_setup_component(hass, "auth", {})
    await hass.auth.async_link_user(hass_admin_user, hass_admin_credential)
    client = await aiohttp_client(hass.http.app)
    monkeypatch.setattr(oauth, "_token_endpoints", lambda _hass, _request: [(str(client.make_url("/auth/token")), True)])
    _, answer = await _connector_sign_in(hass, client, hass_admin_credential, approve="no")
    assert answer["error"] == "access_denied"
    assert "code" not in answer

    resp = await client.get("/api/larder/oauth/callback", params={"code": "made-up", "state": "made-up"})
    assert resp.status == 400
    assert "expired" in await resp.text()
    resp = await client.post("/api/larder/oauth/approve", data={"key": "made-up", "approve": "yes"}, allow_redirects=False)
    assert resp.status == 400


async def _battery_device(hass: HomeAssistant, name: str, level: str):
    from homeassistant.helpers import device_registry as dr, entity_registry as er
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    other = MockConfigEntry(domain="test")
    other.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(config_entry_id=other.entry_id, identifiers={("test", uuid.uuid4().hex)}, name=name)
    entity = er.async_get(hass).async_get_or_create("sensor", "test", uuid.uuid4().hex, device_id=device.id, original_device_class="battery")
    hass.states.async_set(entity.entity_id, level, {"device_class": "battery", "unit_of_measurement": "%"})
    return device, entity


async def test_low_battery_is_reported_once_even_if_the_sensor_drops_out(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """A sleepy device going unavailable and coming back doesn't report the same low battery twice."""
    device, entity = await _battery_device(hass, unique("Door sensor"), "55")
    watcher = setup_larder.runtime_data.batteries
    await watcher.async_sync()
    advice = async_capture_events(hass, "larder_batteries_low")

    def mine():
        return [e for e in advice if e.data.get("deviceId") == device.id]

    async def reported():
        return mine()

    hass.states.async_set(entity.entity_id, "12", {"device_class": "battery"})
    await wait_for(reported)
    hass.states.async_set(entity.entity_id, "unavailable", {"device_class": "battery"})
    await hass.async_block_till_done()
    await watcher.async_sync()
    devices = await larder.call("GET", "/modules/batteries/devices")
    assert next(d for d in devices if d["id"] == device.id)["low"] is True
    hass.states.async_set(entity.entity_id, "12", {"device_class": "battery"})
    await hass.async_block_till_done()
    await watcher.async_sync()
    await asyncio.sleep(0.3)
    assert len(mine()) == 1


async def test_a_restart_keeps_a_low_battery_low(hass: HomeAssistant, larder: Larder, setup_larder) -> None:
    """After a restart, a device Larder knows is low stays low while it's still within the hysteresis band."""
    from custom_components.larder.batteries import BatteryWatcher

    device, _entity = await _battery_device(hass, unique("Remote"), "22")
    await setup_larder.runtime_data.batteries.async_sync()
    await larder.call("POST", "/modules/batteries/low", {"deviceId": device.id, "level": 15})
    fresh = BatteryWatcher(hass, setup_larder.runtime_data.client, 20)
    await fresh.async_sync(first=True)
    fresh.async_stop()
    devices = await larder.call("GET", "/modules/batteries/devices")
    assert next(d for d in devices if d["id"] == device.id)["low"] is True


async def test_reloading_is_clean(hass: HomeAssistant, setup_larder, caplog: pytest.LogCaptureFixture) -> None:
    """Changing options (which reloads) leaves no errors in the log."""
    result = await hass.config_entries.options.async_init(setup_larder.entry_id)
    await hass.config_entries.options.async_configure(result["flow_id"], {"battery_threshold": 25, "forward_tags": True})
    await hass.async_block_till_done()
    assert "Unable to remove unknown" not in caplog.text
    assert setup_larder.state is ConfigEntryState.LOADED


async def test_actions_from_two_larders_are_combined(hass: HomeAssistant) -> None:
    """With two Larders, one module's action doesn't come and go as each one refreshes."""
    from custom_components.larder.services import async_reset_actions, async_update_actions

    base = {"name": "x", "description": "x", "schema": {"type": "object", "properties": {}}}
    async_update_actions(hass, [{**base, "id": "add_stock"}], "one")
    async_update_actions(hass, [{**base, "id": "add_stock"}, {**base, "id": "batteries_replaced"}], "two")
    async_update_actions(hass, [{**base, "id": "add_stock"}], "one")
    assert hass.services.has_service(DOMAIN, "batteries_replaced")
    async_reset_actions(hass, "two")
    assert not hass.services.has_service(DOMAIN, "batteries_replaced")
    assert hass.services.has_service(DOMAIN, "add_stock")
