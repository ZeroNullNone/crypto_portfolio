"""Manual cashflow ledger endpoints."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import CashflowEntry, CashflowEntryCreate, CashflowSummary

router = APIRouter(prefix="/api/cashflow", tags=["cashflow"])

_RANGE_DAYS = {
    "24H": 1,
    "7D": 7,
    "30D": 30,
    "90D": 90,
    "YTD": 0,
    "ALL": -1,
}


def _cutoff_for_range(value: str) -> datetime | None:
    now = datetime.now(timezone.utc)
    key = value.upper()
    if key == "ALL":
        return None
    if key == "YTD":
        return datetime(now.year, 1, 1, tzinfo=timezone.utc).replace(tzinfo=None)
    return (now - timedelta(days=_RANGE_DAYS.get(key, 30))).replace(tzinfo=None)


def _entry_out(row: m.CashflowEntryRow, account_name: str | None = None) -> CashflowEntry:
    return CashflowEntry(
        id=row.id,
        kind=row.kind,  # type: ignore[arg-type]
        amount_usd=float(row.amount_usd or 0.0),
        t=row.t,
        account_id=row.account_id,
        account_name=account_name,
        note=row.note,
    )


def _owned_account_name(db: Session, user_id: str, account_id: str | None) -> str | None:
    if not account_id:
        return None
    row = db.get(m.AccountRow, account_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=400, detail="Account not found")
    return row.name


@router.get("", response_model=CashflowSummary)
def summary(
    range: str = Query("30D"),
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> CashflowSummary:
    cutoff = _cutoff_for_range(range)
    q = db.query(m.CashflowEntryRow).filter(m.CashflowEntryRow.user_id == user.id)
    if cutoff is not None:
        q = q.filter(m.CashflowEntryRow.t >= cutoff)
    rows = q.order_by(m.CashflowEntryRow.t.desc(), m.CashflowEntryRow.id.desc()).all()
    account_names = {
        account.id: account.name
        for account in db.query(m.AccountRow)
        .filter(m.AccountRow.user_id == user.id)
        .all()
    }
    inflows = sum(float(r.amount_usd or 0.0) for r in rows if r.kind == "deposit")
    outflows = sum(float(r.amount_usd or 0.0) for r in rows if r.kind == "withdraw")
    return CashflowSummary(
        inflows_30d=round(inflows, 2),
        outflows_30d=round(-outflows, 2),
        net_30d=round(inflows - outflows, 2),
        pending=0,
        entries=[_entry_out(r, account_names.get(r.account_id or "")) for r in rows],
    )


@router.post("", response_model=CashflowEntry, status_code=201)
def create_entry(
    body: CashflowEntryCreate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> CashflowEntry:
    account_name = _owned_account_name(db, user.id, body.account_id)
    row = m.CashflowEntryRow(
        user_id=user.id,
        account_id=body.account_id or None,
        kind=body.kind,
        amount_usd=round(float(body.amount_usd), 2),
        t=body.t.astimezone(timezone.utc).replace(tzinfo=None)
        if body.t.tzinfo
        else body.t,
        note=body.note,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _entry_out(row, account_name)


@router.delete("/{entry_id}", status_code=204)
def delete_entry(
    entry_id: int,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(m.CashflowEntryRow, entry_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(status_code=404, detail="Cashflow entry not found")
    db.delete(row)
    db.commit()


def _demo() -> None:
    now = datetime(2026, 1, 2, tzinfo=timezone.utc)
    assert _cutoff_for_range("ALL") is None
    assert _cutoff_for_range("YTD") is not None
    assert now.isoformat().startswith("2026")


if __name__ == "__main__":
    _demo()
