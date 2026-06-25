from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.integrations.bnm import _lowest_usd_myr_from_payload  # noqa: E402


def test_bnm_usd_myr_payload_uses_lowest_rate() -> None:
    payload = {
        "data": {
            "date": "2026-06-24",
            "highest_rate": 4.149,
            "lowest_rate": 4.1334999999999997,
        }
    }

    assert _lowest_usd_myr_from_payload(payload) == 4.1334999999999997


if __name__ == "__main__":
    test_bnm_usd_myr_payload_uses_lowest_rate()
