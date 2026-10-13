"""Run the real app/UI on localhost with a disposable DB and synthetic BingX.

Build frontend first, then: python backend/tests/serve_bingx_fixture.py
Keys: fixture-key = success; invalid = validation failure; fail-sync = first
sync failure; cleanup-failure = validation failure plus one failed rollback.
Any secret is accepted. Never use this harness with real credentials.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.fernet import Fernet

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    with tempfile.TemporaryDirectory(prefix="bingx-ui-") as directory:
        os.environ["DATABASE_URL"] = "sqlite:///" + (Path(directory) / "test.db").as_posix()
        os.environ["SECRETS_KEY"] = Fernet.generate_key().decode()
        os.environ["SESSION_COOKIE_SECURE"] = "false"
        os.environ["REGISTRATION_ENABLED"] = "true"
        os.environ["SYNC_MIN_INTERVAL_SECONDS"] = "0"

        import uvicorn
        from starlette.exceptions import HTTPException
        from starlette.responses import JSONResponse
        from starlette.staticfiles import StaticFiles
        from app.main import app
        from app.integrations import bingx
        from app.routers import dashboard
        from bingx_fixtures import responses

        data = responses()
        balance_calls = {}
        state = {"fail_delete": False}

        def fixture_get(url, headers):
            key = headers.get("X-BX-APIKEY", "")
            if key == "cleanup-failure":
                state["fail_delete"] = True
            if key in ("invalid", "cleanup-failure"):
                return {"code": 100413, "data": None}
            path = urlsplit(url).path
            if path == bingx.FUTURES_BALANCE:
                balance_calls[key] = balance_calls.get(key, 0) + 1
                if key == "fail-sync" and balance_calls[key] > 1:
                    return {"code": 100413, "data": []}
            return {"code": 0, "data": data[path]}

        bingx._http_get = fixture_get
        bingx._pace = lambda *_: None
        dashboard.fetch_lowest_usd_myr_rate = lambda **_: 4.0

        @app.middleware("http")
        async def fixture_cleanup_failure(request, call_next):
            if request.method == "DELETE" and request.url.path.startswith("/api/accounts/") and state["fail_delete"]:
                state["fail_delete"] = False
                return JSONResponse({"detail": "Synthetic cleanup failure"}, status_code=503)
            return await call_next(request)

        class SPAFiles(StaticFiles):
            async def get_response(self, path, scope):
                try:
                    return await super().get_response(path, scope)
                except HTTPException as error:
                    if error.status_code == 404 and "." not in path and not path.startswith("api/"):
                        return await super().get_response("index.html", scope)
                    raise

        dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
        app.mount("/", SPAFiles(directory=str(dist), html=True), name="fixture-ui")
        try:
            uvicorn.run(app, host="127.0.0.1", port=8017, log_level="warning")
        finally:
            from app.db import engine
            engine.dispose()  # Release Windows SQLite handles before temp cleanup.


if __name__ == "__main__":
    main()
