"""API/database integration checks with synthetic exchange transport only."""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Tests never open the operator's database or use the operator's secrets.
os.environ["DATABASE_URL"] = "sqlite://"
os.environ["SECRETS_KEY"] = Fernet.generate_key().decode()
os.environ["SESSION_COOKIE_SECURE"] = "false"
os.environ["REGISTRATION_ENABLED"] = "true"

from app.main import app
from app.db import Base, get_db
from app import db_models as m
from app.integrations import bingx
from app.services import sync
from app.jobs import auto_sync_loop
from bingx_fixtures import responses


class BingXAccountTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, autoflush=False, expire_on_commit=False)
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.addCleanup(app.dependency_overrides.clear)
        self.addCleanup(self.engine.dispose)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.data = responses()
        self.failed_path = None
        self.failed_key = None
        self.headers = []
        self.paths = []
        def http_get(url, headers):
            self.headers.append(headers)
            path = urlsplit(url).path
            self.paths.append(path)
            if headers.get("X-BX-APIKEY") == "invalid":
                return {"code": 100413, "msg": "invalid"}
            if path == self.failed_path and (self.failed_key is None or headers.get("X-BX-APIKEY") == self.failed_key):
                return {"code": 100413, "msg": "query failed", "data": []}
            return {"code": 0, "data": self.data[path]}
        for target, kwargs in [
            ("app.integrations.bingx._http_get", {"side_effect": http_get}),
            ("app.integrations.bingx._pace", {}),
            ("app.ratelimit.check_sync_allowed", {}),
            ("app.routers.dashboard.fetch_lowest_usd_myr_rate", {"return_value": 4.0}),
        ]:
            mock = patch(target, **kwargs)
            mock.start()
            self.addCleanup(mock.stop)
        bingx._price_cache = (0, {})
        response = self.client.post("/api/auth/signup", json={"email": "owner@example.com", "password": "test-password-123"})
        self.assertEqual(response.status_code, 201, response.text)
        self.user_id = response.json()["id"]
        self.account_id = self.create_account("BingX fixture")

    def create_account(self, name):
        response = self.client.post("/api/accounts", json={"name": name, "source": "exchange", "addr": "bingx"})
        self.assertEqual(response.status_code, 201, response.text)
        account_id = response.json()["id"]
        response = self.client.put(f"/api/credentials/cex/{account_id}", json={
            "exchange": "bingx", "api_key": "fixture-key", "api_secret": "fixture-secret"})
        self.assertEqual(response.status_code, 200, response.text)
        return account_id

    def sync_account(self):
        response = self.client.post(f"/api/sync/account/{self.account_id}")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def detail(self):
        return self.client.get(f"/api/accounts/{self.account_id}").json()

    def test_sync_wallet_equity_dashboard_and_history_without_positions(self):
        result = self.sync_account()
        self.assertEqual(result["status"], "ok", result)
        self.assertEqual(result["balance"], 250)
        detail = self.detail()
        positions = [h for h in detail["holdings"] if h["kind"] == "pos"]
        self.assertEqual(positions, [])
        self.assertEqual(len(detail["holdings"]), 3)
        self.assertNotIn("/openApi/swap/v2/user/positions", self.paths)
        snapshots = self.client.get(f"/api/accounts/{self.account_id}/snapshots").json()
        self.assertTrue(all(h["kind"] == "tok" for snap in snapshots for h in snap["holdings"]))
        top = self.client.get("/api/dashboard/top-assets").json()
        self.assertEqual(sum(h["bal"] for h in top), 250)
        history = self.client.get("/api/balance/history").json()
        self.assertNotIn("BINGX", history["by_asset"])
        self.assertEqual(self.client.get("/api/dashboard/summary").json()["total"], 250)

    def test_wallet_exclusions_and_custom_edits_preserve_equity(self):
        self.sync_account()
        detail = self.detail()
        spot = next(h for h in detail["holdings"] if h["chain"] == "bingx-spot" and h["sym"] == "USDT")
        response = self.client.patch(f"/api/accounts/{self.account_id}", json={"excluded_keys": [spot["key"]]})
        self.assertEqual(response.json()["bal"], 150)
        response = self.client.patch(f"/api/accounts/{self.account_id}", json={
            "custom_assets": [{"symbol": "MANUAL", "amount": 2, "unit_price": 5}], "excluded_keys": []})
        self.assertEqual(response.json()["bal"], 260)
        self.assertEqual(self.sync_account()["balance"], 260)
        response = self.client.patch(f"/api/accounts/{self.account_id}", json={"custom_assets": []})
        self.assertEqual(response.json()["bal"], 250)

    def test_subcent_assets_survive_excluding_every_wallet_and_restoring(self):
        self.data[bingx.SPOT_BALANCE] = {"balances": [{"asset": "USDT", "free": "0.006", "locked": "0"}]}
        self.data[bingx.FUTURES_BALANCE] = [{"asset": "USDT", "equity": "0.006"}]
        self.assertEqual(self.sync_account()["balance"], 0.01)
        keys = [h["key"] for h in self.detail()["holdings"]]
        self.assertEqual(len(keys), 2)
        for _ in range(3):
            for selected, expected in [(keys, 0), ([], 0.01)]:
                response = self.client.patch(f"/api/accounts/{self.account_id}", json={"excluded_keys": selected})
                self.assertEqual(response.json()["bal"], expected)

    def test_failed_sync_preserves_snapshot_and_failed_key_edit_rolls_back(self):
        self.sync_account()
        before = self.detail()
        with self.sessions() as db:
            count = db.query(m.AccountSnapshotHistoryRow).count()
        self.failed_path = bingx.FUTURES_BALANCE
        self.assertEqual(self.sync_account()["status"], "error")
        self.assertEqual(self.detail(), before)
        with self.sessions() as db:
            self.assertEqual(db.query(m.AccountSnapshotHistoryRow).count(), count)
        self.failed_path = None
        response = self.client.put(f"/api/credentials/cex/{self.account_id}", json={"api_key": "invalid"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.sync_account()["status"], "ok")
        self.assertEqual(self.headers[-1]["X-BX-APIKEY"], "fixture-key")
        status = self.client.get("/api/credentials").text
        self.assertNotIn("fixture-key", status)
        self.assertNotIn("fixture-secret", status)
        with self.engine.connect() as conn:
            raw = conn.execute(text("SELECT api_key, api_secret FROM cex_credentials")).one()
            self.assertTrue(all(value.startswith("enc:v1:") for value in raw))

    def test_other_user_cannot_read_or_sync_account(self):
        with TestClient(app) as other:
            other.post("/api/auth/signup", json={"email": "other@example.com", "password": "test-password-456"})
            self.assertEqual(other.get(f"/api/accounts/{self.account_id}").status_code, 404)
            self.assertEqual(other.post(f"/api/sync/account/{self.account_id}").status_code, 404)
            self.assertEqual(other.get("/api/credentials").json()["cex"], [])

    def test_sync_all_and_scheduled_worker_use_same_adapter(self):
        result = self.client.post("/api/sync/all").json()
        self.assertEqual(result["ok_count"], 1, result)
        self.assertEqual(result["total"], 250)
        with self.sessions() as db:
            db.add(m.UserAutoSyncRow(user_id=self.user_id, enabled=True, timezone="Asia/Singapore", local_time="08:00"))
            db.commit()
        with patch.object(auto_sync_loop, "SessionLocal", self.sessions):
            auto_sync_loop._run_user(self.user_id)
        with self.sessions() as db:
            setting = db.get(m.UserAutoSyncRow, self.user_id)
            self.assertEqual(setting.last_status, "ok=1 skipped=0 error=0")
            self.assertEqual(db.query(m.AccountSnapshotHistoryRow).count(), 2)

    def test_legacy_defi_position_still_counts_as_equity(self):
        holding = {"kind": "pos", "chain": "eth", "proto": "Aave", "sym": "USDT", "usd": 40}
        self.assertEqual(sync.holding_equity(holding), 40)
        self.assertEqual(sync._excluded_usd([holding], [sync.holding_key(holding)]), 40)

    def test_sync_all_failure_does_not_prevent_other_account(self):
        self.sync_account()
        other_id = self.create_account("Other BingX")
        self.client.put(f"/api/credentials/cex/{other_id}", json={"api_key": "other-key"})
        before = self.detail()
        self.failed_path, self.failed_key = bingx.SPOT_BALANCE, "fixture-key"
        result = self.client.post("/api/sync/all").json()
        self.assertEqual((result["ok_count"], result["error_count"], result["total"]), (1, 1, 500))
        self.assertEqual(self.detail(), before)
        with self.sessions() as db:
            self.assertEqual(db.query(m.AccountSnapshotHistoryRow).count(), 2)

    def test_previous_bingx_positions_are_hidden_without_changing_equity(self):
        self.sync_account()
        with self.sessions() as db:
            account = db.get(m.AccountRow, self.account_id)
            legacy = {"kind": "pos", "chain": "bingx", "proto": "BingX", "sym": "BTC-USDT",
                      "name": "BTC-USDT LONG", "amt": "0.01", "price": "$50,000", "usd": 500,
                      "d": 0, "c": "#000000", "balance_included": False,
                      "position_id": "9007199254740993"}
            account.snapshot.holdings = [*account.snapshot.holdings, legacy]
            history = db.query(m.AccountSnapshotHistoryRow).filter_by(account_id=self.account_id).one()
            history.holdings = [*history.holdings, legacy]
            db.commit()
        self.assertTrue(all(h["kind"] == "tok" for h in self.detail()["holdings"]))
        snapshots = self.client.get(f"/api/accounts/{self.account_id}/snapshots").json()
        self.assertTrue(all(h["kind"] == "tok" for snap in snapshots for h in snap["holdings"]))
        self.assertEqual(sum(h["bal"] for h in self.client.get("/api/dashboard/top-assets").json()), 250)
        self.assertNotIn("BINGX", self.client.get("/api/balance/history").json()["by_asset"])
        response = self.client.patch(f"/api/accounts/{self.account_id}", json={
            "custom_assets": [{"symbol": "MANUAL", "amount": 2, "unit_price": 5}]})
        self.assertEqual(response.json()["bal"], 260)
        self.assertEqual(self.sync_account()["balance"], 260)
        self.assertTrue(all(h["kind"] == "tok" for h in self.detail()["holdings"]))

    def test_other_provider_authoritative_balance_survives_edits(self):
        with self.sessions() as db:
            account = db.get(m.AccountRow, self.account_id)
            holding = {"kind": "tok", "chain": "binance-spot", "sym": "USDT", "usd": 90}
            # Provider total has another $10 not represented in rendered holdings.
            sync._persist_snapshot(db, account, 100, "binance", [holding])
            db.commit()  # A previous sync has committed before a later edit.
            account.excluded_keys = [sync.holding_key(holding)]
            sync.recompute_balance_from_snapshot(db, account, previous_excluded_keys=[])
            self.assertEqual(account.bal, 10)
            sync.apply_custom_assets(db, account, [{"symbol": "MANUAL", "amount": 1, "unit_price": 5}])
            self.assertEqual(account.bal, 15)
            previous = account.excluded_keys
            account.excluded_keys = []
            sync.recompute_balance_from_snapshot(db, account, previous_excluded_keys=previous)
            self.assertEqual(account.bal, 105)


if __name__ == "__main__":
    unittest.main()
