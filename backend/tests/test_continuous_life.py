"""Permanent ledger and bounded prompt projection contract."""

import sqlite3
import pytest
from fastapi.testclient import TestClient
from app.core import db, llm, state
from app.main import app
from app.services import checkpoint, compress, memory


def add(user="q", reply="a", at="t"):
    gen = checkpoint.generation()
    checkpoint.begin_turn(user, gen, at)
    checkpoint.append_sentence(reply, gen, at)
    checkpoint.acknowledge(checkpoint.current_run(gen, at), reply, gen)
    checkpoint.finish_turn(gen, at)


def test_permanent_history_bounded_projection_restart():
    for i in range(120):
        add(f"q{i}", f"a{i}", str(i))
    before = checkpoint.live_messages()
    assert len(before) == 240
    assert len({m["eventId"] for m in before}) == 240
    assert before[0]["runId"] == before[1]["runId"]
    assert len(checkpoint.context_messages(limit=20)) <= 20
    db.reset()
    assert checkpoint.live_messages() == before
    page = checkpoint.history_page(before_seq=before[-1]["seq"], limit=10)
    assert len(page["messages"]) == 10 and page["hasMore"]


def test_compaction_non_destructive_versioned(monkeypatch):
    for i in range(8):
        add(f"q{i}", f"a{i}", str(i))
    before = checkpoint.live_messages()
    monkeypatch.setattr(llm, "chat_completion", lambda *a, **k: {"content": "summary"})
    assert compress.compress_once()
    assert checkpoint.live_messages() == before
    assert len(checkpoint.context_messages()) < len(before)
    version = checkpoint.summary_state()["version"]

    def late(*a, **k):
        with db.tx() as c:
            c.execute(
                "UPDATE sessions SET summary_version=summary_version+1,summary='newer' WHERE id='live'"
            )
        return {"content": "stale"}

    monkeypatch.setattr(llm, "chat_completion", late)
    assert not compress.compress_once()
    assert checkpoint.live_summary() == "newer"
    assert checkpoint.summary_state()["version"] == version + 1


def test_failed_attempt_hidden_generated_not_shown_partial_retained():
    gen = checkpoint.generation()
    checkpoint.begin_turn("unanswered", gen, "failure")
    rid = checkpoint.current_run(gen, "failure")
    checkpoint.finish_turn(gen, "failure", status="failed")
    checkpoint.discard_unanswered_turn(gen, "failure")
    assert checkpoint.live_messages() == []
    assert (
        db.query("SELECT status FROM runs WHERE id=?", (rid,))[0]["status"] == "failed"
    )
    assert (
        db.query("SELECT text FROM messages WHERE run_id=?", (rid,))[0]["text"]
        == "unanswered"
    )
    checkpoint.begin_turn("question", gen, "partial")
    checkpoint.append_sentence("the full answer", gen, "partial")
    assert checkpoint.live_messages() == []
    checkpoint.interrupt_turn("question", "the full")
    assert [m["text"] for m in checkpoint.live_messages()] == ["question", "the full"]
    assert (
        db.query("SELECT text FROM messages WHERE role='assistant'")[0]["text"]
        == "the full answer"
    )


def test_snapshot_mutations_gone():
    client = TestClient(app)
    for method, url in [
        ("post", "/api/checkpoints"),
        ("put", "/api/checkpoints/old"),
        ("delete", "/api/checkpoints/old"),
        ("post", "/api/checkpoints/old/load"),
        ("post", "/api/checkpoints/live/new"),
        ("post", "/api/checkpoints/auto"),
    ]:
        assert getattr(client, method)(url).status_code == 410
    with pytest.raises(checkpoint.CheckpointError):
        checkpoint.new_session()


def legacy(path):
    with sqlite3.connect(path) as c:
        c.executescript("""CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE memories(id TEXT PRIMARY KEY,content TEXT NOT NULL,created_at TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE sessions(id TEXT PRIMARY KEY,slot INTEGER,auto INTEGER NOT NULL DEFAULT 0,title TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE messages(session_id TEXT NOT NULL,seq INTEGER NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,at TEXT NOT NULL DEFAULT '',PRIMARY KEY(session_id,seq));
        INSERT INTO sessions(id,created_at,updated_at) VALUES('live','t','t');
        INSERT INTO sessions(id,slot,title,created_at,updated_at) VALUES('old',1,'old','t','t');
        INSERT INTO messages VALUES('live',0,'user','current','t');
        INSERT INTO messages VALUES('live',1,'assistant','reply','t');
        INSERT INTO messages VALUES('old',0,'user','old only','t');
        INSERT INTO memories VALUES('pin','stable','t',1);
        INSERT INTO meta VALUES('first_meeting','{"stage":"completed"}');""")


def test_migration_backup_idempotent_preserves_legacy():
    db.reset()
    legacy(state.DATA_DIR / "momo.db")
    assert [m["text"] for m in checkpoint.live_messages()] == ["current", "reply"]
    assert checkpoint.get_checkpoint("old")["messages"][0]["text"] == "old only"
    assert memory.pins() == ["stable"]
    backups = list((state.DATA_DIR / "migrations").glob("pre-v3-*.sqlite3"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as c:
        assert c.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 3
        assert "run_id" not in {r[1] for r in c.execute("PRAGMA table_info(messages)")}
    before = checkpoint.live_messages()
    db.reset()
    assert checkpoint.live_messages() == before
    assert len(list((state.DATA_DIR / "migrations").glob("pre-v3-*.sqlite3"))) == 1


def test_failed_migration_keeps_original(monkeypatch):
    db.reset()
    legacy(state.DATA_DIR / "momo.db")

    def fail(c):
        c.execute("DELETE FROM messages")
        raise RuntimeError("migration fault")

    monkeypatch.setattr(db, "_migrate_continuous", fail)
    with pytest.raises(RuntimeError, match="migration fault"):
        db.conn()
    with sqlite3.connect(state.DATA_DIR / "momo.db") as c:
        assert c.execute("SELECT COUNT(*) FROM messages").fetchone()[0] == 3


def test_forgetting_suppresses_old_sources_new_sources_can_relearn():
    add("I like strawberries", "remembered", "old")
    sources = checkpoint.run_event_ids(checkpoint.generation(), "old")
    with memory.source_scope(sources):
        m = memory.add_memory("User likes strawberries")
    with db.tx() as c:
        c.execute(
            "UPDATE sessions SET summary='strawberries',summary_cursor=1 WHERE id='live'"
        )
    memory.delete_memory(m["id"])
    assert checkpoint.live_summary() == ""
    assert checkpoint.context_messages() == []
    assert len(checkpoint.live_messages()) == 2
    with (
        memory.source_scope(sources),
        pytest.raises(memory.MemoryError, match="forgotten"),
    ):
        memory.add_memory("User likes strawberries")
    memory.rebuild_index()
    assert memory.list_memories() == []
    add("I like strawberries again", "okay", "new")
    with memory.source_scope(checkpoint.run_event_ids(checkpoint.generation(), "new")):
        assert memory.add_memory("User likes strawberries")


def test_restore_retires_generation_and_pending_attempts():
    from app.services import archive

    add("before", "reply", "done")
    gen = checkpoint.generation()
    raw = archive.export_data()
    checkpoint.begin_turn("pending", gen, "pending")
    archive.import_data(raw)
    assert checkpoint.generation() > gen
    assert not checkpoint.append_sentence("late reply", gen, "pending")
    assert [m["text"] for m in checkpoint.live_messages()] == ["before", "reply"]


def test_ack_is_monotonic_authenticated_to_run_generation():
    gen = checkpoint.generation()
    checkpoint.begin_turn("q", gen, "one", run_id="r1")
    checkpoint.append_sentence("first. second.", gen, "one", run_id="r1")
    assert checkpoint.acknowledge("r1", "first.", gen)
    assert not checkpoint.acknowledge("r1", "first", gen)
    assert not checkpoint.acknowledge("r1", "invented", gen)
    assert not checkpoint.acknowledge("r1", "first. second.", gen + 1)
    assert [m["text"] for m in checkpoint.live_messages()] == ["q", "first."]


def test_unheard_source_memory_not_listed_or_recalled_until_ack():
    gen = checkpoint.generation()
    checkpoint.begin_turn("I like pears", gen, "pending-memory")
    sources = checkpoint.run_event_ids(gen, "pending-memory")
    with memory.source_scope(sources):
        m = memory.add_memory("User likes pears")
    assert memory.list_memories() == []
    assert memory.search_memories("pears") == []
    checkpoint.append_sentence("I remember.", gen, "pending-memory")
    checkpoint.acknowledge(
        checkpoint.current_run(gen, "pending-memory"), "I remember.", gen
    )
    assert memory.list_memories()[0]["id"] == m["id"]


def test_cancelled_source_cannot_mutate_memory():
    gen = checkpoint.generation()
    m = memory.add_memory("original")
    checkpoint.interrupt_turn("", "")
    with memory.source_scope([], generation=gen):
        for call in [
            lambda: memory.add_memory("late"),
            lambda: memory.update_memory(m["id"], "late"),
            lambda: memory.delete_memory(m["id"]),
            lambda: memory.set_pinned(m["id"], True),
        ]:
            with pytest.raises(memory.MemoryError, match="cancelled"):
                call()
    assert memory.list_memories()[0]["content"] == "original"


@pytest.mark.parametrize("operation", ["update", "delete", "pin"])
def test_tool_mutations_apply_only_after_display_ack(operation):
    original = memory.add_memory("original")
    gen = checkpoint.generation()
    checkpoint.begin_turn("change it", gen, "mutation")
    with memory.source_scope(checkpoint.run_event_ids(gen, "mutation"), generation=gen):
        if operation == "update":
            memory.update_memory(original["id"], "updated")
        elif operation == "delete":
            memory.delete_memory(original["id"])
        else:
            memory.set_pinned(original["id"], True)
    assert memory.list_memories() == [original]
    checkpoint.append_sentence("Done.", gen, "mutation")
    checkpoint.acknowledge(checkpoint.current_run(gen, "mutation"), "Done.", gen)
    rows = memory.list_memories()
    if operation == "update":
        assert rows[0]["content"] == "updated"
    elif operation == "delete":
        assert rows == []
    else:
        assert rows[0]["pinned"]


def test_source_bound_memory_edit_replaces_old_provenance_and_stays_active():
    add("old preference", "okay", "old-pref")
    with memory.source_scope(
        checkpoint.run_event_ids(checkpoint.generation(), "old-pref")
    ):
        item = memory.add_memory("User likes pears")
    add("new preference", "okay", "new-pref")
    with memory.source_scope(
        checkpoint.run_event_ids(checkpoint.generation(), "new-pref")
    ):
        memory.update_memory(item["id"], "User likes apples")
    assert memory.list_memories()[0]["content"] == "User likes apples"


def test_manual_forget_invalidates_generation_that_holds_old_prompt():
    add("old private fact", "okay", "old-source")
    with memory.source_scope(
        checkpoint.run_event_ids(checkpoint.generation(), "old-source")
    ):
        item = memory.add_memory("private fact")
    gen = checkpoint.generation()
    checkpoint.begin_turn("question", gen, "old-prompt")
    sources = checkpoint.run_event_ids(gen, "old-prompt")
    memory.delete_memory(item["id"])
    with (
        memory.source_scope(sources, generation=gen),
        pytest.raises(memory.MemoryError, match="cancelled"),
    ):
        memory.add_memory("private fact")


def test_migration_can_preserve_existing_vector_extension_tables():
    from app.models import vectors

    if db.sqlite_vec is None:
        pytest.skip("sqlite-vec unavailable")
    memory.add_memory("legacy fact")
    assert vectors.ensure(2, "legacy")
    with db.tx() as c:
        c.execute("DELETE FROM meta WHERE key='continuous_schema'")
    db.reset()
    assert memory.list_memories()[0]["content"] == "legacy fact"
    assert vectors.dim() == 2


@pytest.mark.parametrize("pinned", [False, True])
def test_forgetting_one_fact_preserves_other_memories_from_the_same_event(pinned):
    add("My name is Yeyu and I like strawberries.", "I understand.", "two-facts")
    source = checkpoint.run_event_ids(checkpoint.generation(), "two-facts")
    with memory.source_scope(source):
        name = memory.add_memory("The player name is Yeyu", pinned=pinned)
        food = memory.add_memory("The player likes strawberries")
    memory.delete_memory(food["id"])
    assert memory.list_memories() == [name]
    assert memory.search_memories("Yeyu") == [
        {"id": name["id"], "content": name["content"]}
    ]
    if pinned:
        assert memory.pins() == [name["content"]]
    assert checkpoint.context_messages() == []
    assert len(checkpoint.live_messages()) == 2
    with (
        memory.source_scope(source),
        pytest.raises(memory.MemoryError, match="forgotten"),
    ):
        memory.add_memory("The player likes strawberries")
