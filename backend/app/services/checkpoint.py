"""One continuous relationship: durable events, bounded context, immutable legacy slots.

Generated events are not conversation until the client acknowledges displayed text.
No compaction, interruption or failed request deletes the original event payload.
"""

from __future__ import annotations
import sqlite3
from typing import Any
from ..core import db
from ..models import StoredMessage, CheckpointDetail, CheckpointMeta

LIVE_ID = db.LIVE_ID
PREVIEW_LEN = 40
now_iso = db.now_iso


class CheckpointError(Exception):
    def __init__(self, message: str, kind: str = "gone") -> None:
        super().__init__(message)
        self.kind = kind


def generation() -> int:
    return int(
        db.query("SELECT generation FROM sessions WHERE id=?", (LIVE_ID,))[0][
            "generation"
        ]
    )


def summary_state() -> dict[str, Any]:
    r = db.query(
        "SELECT summary,summary_cursor,summary_version,generation FROM sessions WHERE id=?",
        (LIVE_ID,),
    )[0]
    return {
        "summary": r["summary"],
        "cursor": int(r["summary_cursor"]),
        "version": int(r["summary_version"]),
        "generation": int(r["generation"]),
    }


def live_summary() -> str:
    return str(summary_state()["summary"])


def _message(r: sqlite3.Row) -> StoredMessage:
    return {
        "role": r["role"],
        "text": r["display_text"] if r["display_text"] is not None else r["text"],
        "at": r["at"],
        "seq": int(r["seq"]),
        "eventId": r["event_id"],
        "runId": r["run_id"],
        "source": r["source"],
        "externalMessageId": r["external_message_id"],
    }


def live_messages() -> list[StoredMessage]:
    return [
        _message(r)
        for r in db.query(
            "SELECT * FROM messages WHERE session_id=? AND visible=1 ORDER BY seq",
            (LIVE_ID,),
        )
    ]


def history_page(before_seq: int | None = None, limit: int = 100) -> dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    bound = int(before_seq) if before_seq is not None else 9223372036854775807
    rows = db.query(
        "SELECT * FROM messages WHERE session_id=? AND visible=1 AND seq<? ORDER BY seq DESC LIMIT ?",
        (LIVE_ID, bound, limit + 1),
    )
    more = len(rows) > limit
    selected = list(reversed(rows[:limit]))
    return {
        "messages": [_message(r) for r in selected],
        "hasMore": more,
        "nextBefore": int(selected[0]["seq"]) if more and selected else None,
    }


def context_rows(
    *, after_summary: bool = True, limit: int = 80, oldest: bool = True
) -> list[dict[str, Any]]:
    cursor = summary_state()["cursor"] if after_summary else -1
    rows = db.query(
        """SELECT m.* FROM messages m WHERE m.session_id=? AND m.visible=1 AND m.seq>?
        AND NOT EXISTS (SELECT 1 FROM messages excluded JOIN suppressed_sources s ON s.event_id=excluded.event_id
                        WHERE excluded.run_id=m.run_id AND excluded.session_id=?) ORDER BY m.seq """
        + ("ASC" if oldest else "DESC")
        + " LIMIT ?",
        (LIVE_ID, cursor, LIVE_ID, max(1, min(limit, 200))),
    )
    if not oldest:
        rows = list(reversed(rows))
    return [
        dict(r)
        | {"text": r["display_text"] if r["display_text"] is not None else r["text"]}
        for r in rows
    ]


def context_messages(limit: int = 40, max_chars: int = 24000) -> list[StoredMessage]:
    # Slice by explicit run boundaries; oversized individual text is clipped only
    # in this prompt projection. The player's original history remains untouched.
    rows = context_rows(limit=max(1, limit) + 1, oldest=False)
    selected = []
    size = 0
    for r in reversed(rows):
        if len(selected) >= max(1, limit) or size + len(r["text"]) > max_chars:
            break
        selected.append(r)
        size += len(r["text"])
    selected.reverse()
    if selected:
        first = selected[0]["run_id"]
        if rows and any(
            r["run_id"] == first for r in rows[: len(rows) - len(selected)]
        ):
            selected = [r for r in selected if r["run_id"] != first]
    return [_message(r) for r in selected]


def _next_seq(c: sqlite3.Connection, sid: str) -> int:
    return int(
        c.execute(
            "SELECT COALESCE(MAX(seq)+1,0) FROM messages WHERE session_id=?", (sid,)
        ).fetchone()[0]
    )


def current_run(gen: int, at: str) -> str | None:
    rows = db.query(
        "SELECT id FROM runs WHERE generation=? AND at=? ORDER BY rowid DESC LIMIT 1",
        (gen, at),
    )
    return str(rows[0]["id"]) if rows else None


def _run(c, gen, at, run_id=None):
    if run_id:
        return c.execute(
            "SELECT * FROM runs WHERE id=? AND generation=?", (run_id, gen)
        ).fetchone()
    return c.execute(
        "SELECT * FROM runs WHERE generation=? AND at=? ORDER BY rowid DESC LIMIT 1",
        (gen, at),
    ).fetchone()


def _insert(
    c, role, text, at, run_id, source="meeting", external_message_id=None, visible=False
):
    eid = db.new_id(32)
    c.execute(
        """INSERT INTO messages(session_id,seq,role,text,at,event_id,run_id,source,external_message_id,status,visible)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (
            LIVE_ID,
            _next_seq(c, LIVE_ID),
            role,
            text,
            at,
            eid,
            run_id,
            source,
            external_message_id,
            "shown" if visible else "generated",
            int(visible),
        ),
    )
    c.execute("UPDATE sessions SET updated_at=? WHERE id=?", (at, LIVE_ID))
    return eid


def begin_turn(
    text: str,
    gen: int,
    at: str,
    *,
    run_id: str | None = None,
    source: str = "meeting",
    external_message_id: str | None = None,
) -> bool:
    with db.tx() as c:
        if (
            int(
                c.execute(
                    "SELECT generation FROM sessions WHERE id=?", (LIVE_ID,)
                ).fetchone()[0]
            )
            != gen
        ):
            return False
        rid = run_id or db.new_id(32)
        if (
            external_message_id
            and c.execute(
                "SELECT 1 FROM runs WHERE source=? AND external_message_id=?",
                (source, external_message_id),
            ).fetchone()
        ):
            return False
        if c.execute("SELECT 1 FROM runs WHERE id=?", (rid,)).fetchone():
            return False
        c.execute(
            "INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)",
            (
                rid,
                gen,
                at,
                source,
                external_message_id,
                "processing",
                now_iso(),
                now_iso(),
            ),
        )
        _insert(c, "user", text, at, rid, source, external_message_id)
        return True


def append_sentence(
    text: str, gen: int, at: str, *, run_id: str | None = None, visible: bool = False
) -> bool:
    with db.tx() as c:
        if (
            int(
                c.execute(
                    "SELECT generation FROM sessions WHERE id=?", (LIVE_ID,)
                ).fetchone()[0]
            )
            != gen
        ):
            return False
        run = _run(c, gen, at, run_id)
        if run is None or run["status"] not in {"processing", "generated"}:
            return False
        _insert(
            c,
            "assistant",
            text,
            at,
            run["id"],
            run["source"],
            run["external_message_id"],
            visible,
        )
        if visible:
            c.execute(
                "UPDATE messages SET visible=1,status='shown' WHERE run_id=? AND role='user'",
                (run["id"],),
            )
        return True


def append_opening(
    c: sqlite3.Connection, text: str, at: str, *, run_id: str, source: str = "meeting"
) -> str:
    gen = int(
        c.execute("SELECT generation FROM sessions WHERE id=?", (LIVE_ID,)).fetchone()[
            0
        ]
    )
    c.execute(
        "INSERT OR IGNORE INTO runs VALUES(?,?,?,?,NULL,'generated',?,?)",
        (run_id, gen, at, source, at, at),
    )
    return _insert(c, "assistant", text, at, run_id, source)


def _ack(c, run_id: str, seen: str, *, allow_shrink=False) -> bool:
    rows = c.execute(
        "SELECT * FROM messages WHERE session_id=? AND run_id=? AND role='assistant' ORDER BY seq",
        (LIVE_ID, run_id),
    ).fetchall()
    full = "".join(r["text"] for r in rows)
    prior = "".join(
        (r["display_text"] if r["display_text"] is not None else r["text"])
        for r in rows
        if r["visible"]
    )
    if not full.startswith(seen) or (not allow_shrink and len(seen) < len(prior)):
        return False
    remaining = len(seen)
    for r in rows:
        shown = r["text"][:remaining]
        remaining = max(0, remaining - len(r["text"]))
        c.execute(
            "UPDATE messages SET visible=?,display_text=?,status=? WHERE event_id=?",
            (int(bool(shown)), shown, "shown" if shown else "generated", r["event_id"]),
        )
    c.execute(
        "UPDATE messages SET visible=?,status=? WHERE run_id=? AND role='user'",
        (int(bool(seen)), "delivered" if seen else "accepted", run_id),
    )
    if seen:
        from .memory import apply_pending

        apply_pending(c, run_id)
    from .onboarding import apply_displayed

    apply_displayed(c, run_id, allow_retired=allow_shrink)
    return True


def acknowledge(run_id: str | None, seen_text: str, gen: int) -> bool:
    if not run_id:
        return False
    with db.tx() as c:
        if (
            int(
                c.execute(
                    "SELECT generation FROM sessions WHERE id=?", (LIVE_ID,)
                ).fetchone()[0]
            )
            != gen
        ):
            return False
        run = c.execute(
            "SELECT * FROM runs WHERE id=? AND generation=?", (run_id, gen)
        ).fetchone()
        if run is None or run["status"] == "interrupted":
            return False
        accepted = _ack(c, run_id, str(seen_text or ""))
        if accepted and run["status"] == "generated":
            full = "".join(
                r["text"]
                for r in c.execute(
                    "SELECT text FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq",
                    (run_id,),
                )
            )
            if full == seen_text:
                c.execute(
                    "UPDATE runs SET status='shown',updated_at=? WHERE id=?",
                    (now_iso(), run_id),
                )
        return accepted


def finish_turn(
    gen: int, at: str, status: str = "completed", *, run_id: str | None = None
) -> None:
    with db.tx() as c:
        run = _run(c, gen, at, run_id)
        if run is None or run["status"] == "interrupted":
            return
        count = c.execute(
            "SELECT COUNT(*) FROM messages WHERE run_id=? AND role='assistant'",
            (run["id"],),
        ).fetchone()[0]
        unseen = c.execute(
            "SELECT 1 FROM messages WHERE run_id=? AND role='assistant' AND (visible=0 OR (display_text IS NOT NULL AND display_text!=text)) LIMIT 1",
            (run["id"],),
        ).fetchone()
        result = ("generated" if unseen else "shown") if count else "failed"
        if status != "completed":
            result = status
        c.execute(
            "UPDATE runs SET status=?,updated_at=? WHERE id=?",
            (result, now_iso(), run["id"]),
        )


def discard_unanswered_turn(gen: int, at: str) -> None:
    with db.tx() as c:
        run = _run(c, gen, at)
        if run is None:
            return
        if not c.execute(
            "SELECT 1 FROM messages WHERE run_id=? AND role='assistant'", (run["id"],)
        ).fetchone():
            c.execute(
                "UPDATE messages SET visible=0,status='failed' WHERE run_id=?",
                (run["id"],),
            )
            c.execute(
                "UPDATE runs SET status='failed',updated_at=? WHERE id=?",
                (now_iso(), run["id"]),
            )


def run_event_ids(gen: int, at: str) -> list[str]:
    rid = current_run(gen, at)
    return (
        [
            str(r["event_id"])
            for r in db.query("SELECT event_id FROM messages WHERE run_id=?", (rid,))
        ]
        if rid
        else []
    )


def interrupt_turn(user: str, assistant: str, *, run_id: str | None = None) -> None:
    user, assistant = str(user or ""), str(assistant or "")
    with db.tx() as c:
        gen = int(
            c.execute(
                "SELECT generation FROM sessions WHERE id=?", (LIVE_ID,)
            ).fetchone()[0]
        )
        c.execute("UPDATE sessions SET generation=generation+1 WHERE id=?", (LIVE_ID,))
        if run_id:
            run = c.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        else:
            run = c.execute(
                "SELECT r.* FROM runs r JOIN messages m ON m.run_id=r.id WHERE m.role='user' AND m.session_id=? ORDER BY m.seq DESC LIMIT 1",
                (LIVE_ID,),
            ).fetchone()
            if (
                run
                and not c.execute(
                    "SELECT 1 FROM messages WHERE run_id=? AND role='user' AND text=?",
                    (run["id"], user),
                ).fetchone()
            ):
                run = None
        if run:
            if assistant:
                rows = c.execute(
                    "SELECT text FROM messages WHERE run_id=? AND role='assistant' ORDER BY seq",
                    (run["id"],),
                ).fetchall()
                full = "".join(r["text"] for r in rows)
                if not full and assistant:
                    _insert(
                        c, "assistant", assistant, run["at"], run["id"], run["source"]
                    )
            _ack(c, run["id"], assistant, allow_shrink=True)
            c.execute(
                "UPDATE runs SET status='interrupted',updated_at=? WHERE id=?",
                (now_iso(), run["id"]),
            )
        elif user and assistant:
            rid = db.new_id(32)
            at = now_iso()
            c.execute(
                "INSERT INTO runs VALUES(?,?,?,'meeting',NULL,'interrupted',?,?)",
                (rid, gen, at, at, at),
            )
            _insert(c, "user", user, at, rid, visible=True)
            _insert(c, "assistant", assistant, at, rid, visible=True)


def _messages_of(c, sid):
    return [
        _message(r)
        for r in c.execute(
            "SELECT * FROM messages WHERE session_id=? AND visible=1 ORDER BY seq",
            (sid,),
        )
    ]


def _entry(c, r) -> CheckpointDetail:
    return {
        "id": r["id"],
        "slot": r["slot"],
        "auto": bool(r["auto"]),
        "title": r["title"],
        "summary": r["summary"],
        "createdAt": r["created_at"],
        "updatedAt": r["updated_at"],
        "messages": _messages_of(c, r["id"]),
    }


def meta(entry) -> CheckpointMeta:
    return {
        k: entry[k] for k in ("id", "slot", "auto", "title", "createdAt", "updatedAt")
    } | {
        "preview": entry["messages"][-1]["text"][:PREVIEW_LEN]
        if entry["messages"]
        else ""
    }


def list_checkpoints() -> list[CheckpointMeta]:
    with db.tx() as c:
        return [
            meta(_entry(c, r))
            for r in c.execute(
                "SELECT * FROM sessions WHERE id!=? ORDER BY auto DESC,slot", (LIVE_ID,)
            ).fetchall()
        ]


def get_checkpoint(sid: str) -> CheckpointDetail:
    with db.tx() as c:
        r = c.execute(
            "SELECT * FROM sessions WHERE id!=? AND id=?", (LIVE_ID, sid)
        ).fetchone()
        if r is None:
            raise CheckpointError("Legacy archive not found", "not_found")
        return _entry(c, r)


def _gone(*args, **kwargs):
    raise CheckpointError(
        "Multiple save slots were retired. Your continuous history is saved automatically; use full-profile backup for recovery."
    )


create_checkpoint = overwrite_checkpoint = delete_checkpoint = load_checkpoint = (
    save_auto
) = new_session = _gone


def event_metadata(gen: int, at: str, *, run_id: str | None = None) -> dict[str, Any]:
    rid = run_id or current_run(gen, at)
    rows = db.query(
        "SELECT role,event_id,seq FROM messages WHERE run_id=? ORDER BY seq", (rid,)
    )
    result = {"runId": rid}
    for r in rows:
        if r["role"] == "user" and "userEventId" not in result:
            result.update(userEventId=r["event_id"], userSeq=int(r["seq"]))
        elif r["role"] == "assistant":
            result.update(eventId=r["event_id"], seq=int(r["seq"]))
    return result
