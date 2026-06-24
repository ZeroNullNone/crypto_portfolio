"""Account CRUD + detail endpoints (per-user)."""
from __future__ import annotations

import uuid
from datetime import timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import db_models as m
from ..auth import current_user
from ..db import get_db
from ..models import (
    Account,
    AccountCreate,
    AccountDetail,
    AccountHistoryPointIn,
    AccountSnapshot,
    AccountUpdate,
)
from ..services import sync as sync_service
from ..services.mappers import account_to_detail, account_to_model

router = APIRouter(prefix="/api/accounts", tags=["accounts"])


def _get_owned(db: Session, user_id: str, account_id: str) -> m.AccountRow:
    row = db.get(m.AccountRow, account_id)
    if row is None or row.user_id != user_id:
        raise HTTPException(status_code=404, detail="Account not found")
    return row


def _utc_naive(dt):
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _as_utc(dt):
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _get_editable_history_row(
    db: Session,
    user_id: str,
    account_id: str,
    snapshot_id: int,
) -> m.AccountSnapshotHistoryRow:
    _get_owned(db, user_id, account_id)
    row = db.get(m.AccountSnapshotHistoryRow, snapshot_id)
    if row is None or row.user_id != user_id or row.account_id != account_id:
        raise HTTPException(status_code=404, detail="History point not found")
    if row.provider != "manual":
        raise HTTPException(status_code=403, detail="Synced history is read-only")
    return row


def _snapshot_out(row: m.AccountSnapshotHistoryRow) -> AccountSnapshot:
    return AccountSnapshot(
        id=row.id,
        bal=float(row.bal or 0.0),
        d=float(row.d or 0.0),
        synced_at=_as_utc(row.synced_at),
        provider=row.provider,
        editable=row.provider == "manual",
        holdings=row.holdings or [],
    )


UNASSIGNED = "unassigned"


def _ensure_name_available(
    db: Session, user_id: str, name: str, *, exclude_id: Optional[str] = None
) -> None:
    q = db.query(m.AccountRow.id).filter(
        m.AccountRow.user_id == user_id, m.AccountRow.name == name
    )
    if exclude_id is not None:
        q = q.filter(m.AccountRow.id != exclude_id)
    if q.first() is not None:
        raise HTTPException(
            status_code=409,
            detail=f"You already have an account named '{name}'.",
        )


def _resolve_group(db: Session, user_id: str, name: str) -> str:
    """Normalize the account's group. Empty/whitespace (or the literal
    'unassigned') means the account has no group — stored as
    `UNASSIGNED`. Any other value must match one of the user's groups."""
    key = (name or "").strip().lower()
    if not key or key == UNASSIGNED:
        return UNASSIGNED
    exists = (
        db.query(m.GroupRow)
        .filter(m.GroupRow.user_id == user_id, m.GroupRow.name == key)
        .first()
    )
    if exists is None:
        raise HTTPException(
            status_code=400,
            detail=f"Group '{name}' does not exist — create it first.",
        )
    return key


@router.get("", response_model=list[Account])
def list_accounts(
    source: Optional[str] = None,
    group: Optional[str] = None,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[Account]:
    q = db.query(m.AccountRow).filter(m.AccountRow.user_id == user.id)
    if source:
        q = q.filter(m.AccountRow.source == source)
    if group:
        q = q.filter(m.AccountRow.group_name == group)
    return [account_to_model(r) for r in q.all()]


@router.get("/{account_id}", response_model=AccountDetail)
def get_account(
    account_id: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> AccountDetail:
    return account_to_detail(_get_owned(db, user.id, account_id))


@router.get("/{account_id}/snapshots", response_model=list[AccountSnapshot])
def account_snapshots(
    account_id: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[AccountSnapshot]:
    _get_owned(db, user.id, account_id)
    rows = (
        db.query(m.AccountSnapshotHistoryRow)
        .filter(
            m.AccountSnapshotHistoryRow.user_id == user.id,
            m.AccountSnapshotHistoryRow.account_id == account_id,
        )
        .order_by(m.AccountSnapshotHistoryRow.synced_at.asc())
        .all()
    )
    return [_snapshot_out(row) for row in rows]


@router.post("/{account_id}/snapshots", response_model=AccountSnapshot, status_code=201)
def create_account_snapshot(
    account_id: str,
    body: AccountHistoryPointIn,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> AccountSnapshot:
    _get_owned(db, user.id, account_id)
    row = m.AccountSnapshotHistoryRow(
        user_id=user.id,
        account_id=account_id,
        bal=round(body.bal, 2),
        d=0.0,
        synced_at=_utc_naive(body.synced_at),
        provider="manual",
        holdings=[],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _snapshot_out(row)


@router.patch("/{account_id}/snapshots/{snapshot_id}", response_model=AccountSnapshot)
def update_account_snapshot(
    account_id: str,
    snapshot_id: int,
    body: AccountHistoryPointIn,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> AccountSnapshot:
    row = _get_editable_history_row(db, user.id, account_id, snapshot_id)
    row.bal = round(body.bal, 2)
    row.synced_at = _utc_naive(body.synced_at)
    db.commit()
    db.refresh(row)
    return _snapshot_out(row)


@router.delete("/{account_id}/snapshots/{snapshot_id}", status_code=204)
def delete_account_snapshot(
    account_id: str,
    snapshot_id: int,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    row = _get_editable_history_row(db, user.id, account_id, snapshot_id)
    db.delete(row)
    db.commit()


@router.post("", response_model=Account, status_code=201)
def create_account(
    body: AccountCreate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> Account:
    _ensure_name_available(db, user.id, body.name)
    group_name = _resolve_group(db, user.id, body.group)
    row = m.AccountRow(
        id=f"acc_{uuid.uuid4().hex[:8]}",
        user_id=user.id,
        name=body.name,
        source=body.source,
        addr=body.addr,
        group_name=group_name,
        chain=body.chain,
        note=body.note,
    )
    db.add(row)
    db.flush()
    if body.custom_assets is not None:
        sync_service.apply_custom_assets(
            db, row, [a.model_dump() for a in body.custom_assets]
        )
    db.commit()
    db.refresh(row)
    return account_to_model(row)


_SYNC_RELEVANT_FIELDS = ("source", "addr", "chain")


@router.patch("/{account_id}", response_model=Account)
def update_account(
    account_id: str,
    body: AccountUpdate,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> Account:
    row = _get_owned(db, user.id, account_id)
    patch = body.model_dump(exclude_unset=True)
    custom_assets = patch.pop("custom_assets", None)
    excluded_keys = patch.pop("excluded_keys", None)
    needs_validation = any(
        f in patch and patch[f] != getattr(row, f)
        for f in _SYNC_RELEVANT_FIELDS
    )
    if "name" in patch and patch["name"] != row.name:
        _ensure_name_available(db, user.id, patch["name"], exclude_id=row.id)
    if "group" in patch:
        row.group_name = _resolve_group(db, user.id, patch.pop("group"))
    for k, v in patch.items():
        setattr(row, k, v)
    if needs_validation:
        try:
            sync_service.validate_account(db, row)
        except sync_service.ValidationFailed as exc:
            db.rollback()
            raise HTTPException(
                status_code=400,
                detail=f"Can't load data with the new settings: {exc}",
            )
    if custom_assets is not None:
        sync_service.apply_custom_assets(db, row, custom_assets)
    if excluded_keys is not None:
        # De-dup + clamp to strings; the column is JSON so we keep this
        # defensively typed even though Pydantic already validated it.
        row.excluded_keys = sorted({str(k) for k in excluded_keys if k})
        sync_service.recompute_balance_from_snapshot(db, row)
    db.commit()
    db.refresh(row)
    return account_to_model(row)


@router.delete("/{account_id}", status_code=204)
def delete_account(
    account_id: str,
    user: m.UserRow = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    row = _get_owned(db, user.id, account_id)
    db.delete(row)
    db.commit()
