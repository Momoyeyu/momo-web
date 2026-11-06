"""Local inference and index lifetime regressions; never use the user database."""
from app.core import db, embed
from app.models import vectors
from app.services import memory

_real_schedule_index = memory.schedule_index


def test_same_dimension_new_model_discards_old_vectors():
    assert vectors.ensure(2, 'model-a')
    with db.tx() as c:
        vectors.put(c, 'old', [1., 0.])
    assert vectors.ensure(2, 'model-b')
    assert vectors.have_ids() == set()


def test_first_search_does_not_embed_history(monkeypatch):
    monkeypatch.setattr(memory, 'schedule_index', lambda: None, raising=False)
    calls = []
    def fake(text, cfg=None):
        calls.append(text)
        return [1., 0.]
    monkeypatch.setattr(embed, 'embed', fake)
    memory.add_memory('用户喜欢草莓蛋糕')
    assert memory.search_memories('草莓蛋糕')[0]['content'] == '用户喜欢草莓蛋糕'
    assert '用户喜欢草莓蛋糕' not in calls


def test_inference_never_holds_database_transaction(monkeypatch):
    monkeypatch.setattr(memory, 'schedule_index', lambda: None, raising=False)
    m = memory.add_memory('用户喜欢草莓蛋糕')
    def fake(text, cfg=None):
        assert not db.conn().in_transaction
        return [1., 0.]
    monkeypatch.setattr(embed, 'embed', fake)
    memory.rebuild_index()
    assert m['id'] in vectors.have_ids()


def test_deleted_memory_cannot_receive_stale_embedding(monkeypatch):
    monkeypatch.setattr(memory, 'schedule_index', lambda: None, raising=False)
    old = memory.add_memory('用户喜欢草莓蛋糕')
    def fake(text, cfg=None):
        if text == '用户喜欢草莓蛋糕':
            memory.delete_memory(old['id'])
        return [1., 0.]
    monkeypatch.setattr(embed, 'embed', fake)
    memory.rebuild_index()
    assert old['id'] not in vectors.have_ids()
    assert memory.list_memories() == []


def test_local_default_ignores_legacy_remote_settings():
    assert memory.embedding_config() == {'kind': 'local'}


def test_direct_restore_invalidates_old_text_and_recovers(monkeypatch):
    monkeypatch.setattr(memory, 'schedule_index', lambda: None)
    monkeypatch.setattr(embed, 'embed', lambda text, cfg=None: [1., 0.])
    m = memory.add_memory('喜欢草莓')
    memory.rebuild_index()
    with db.tx() as c:
        c.execute('UPDATE memories SET content=? WHERE id=?', ('喜欢香蕉', m['id']))
    assert vectors.have_ids() == set()
    assert memory.index_status()['indexed'] == 0
    memory.rebuild_index()
    assert memory.index_status()['indexed'] == 1
    assert memory.search_memories('香蕉')[0]['content'] == '喜欢香蕉'


def test_inflight_model_generation_is_discarded(monkeypatch):
    monkeypatch.setattr(memory, 'schedule_index', lambda: None)
    memory.add_memory('喜欢草莓')
    def fake(text, cfg=None):
        vectors.ensure(2, 'different-model')
        return [1., 0.]
    monkeypatch.setattr(embed, 'embed', fake)
    memory.rebuild_index()
    assert vectors.have_ids() == set()
    assert memory.list_memories()[0]['content'] == '喜欢草莓'


def test_rewrite_during_inference_cannot_commit_old_text(monkeypatch):
    monkeypatch.setattr(memory, 'schedule_index', lambda: None)
    m = memory.add_memory('喜欢草莓')
    def fake(text, cfg=None):
        with db.tx() as c:
            c.execute('UPDATE memories SET content=? WHERE id=?', ('喜欢香蕉', m['id']))
        return [1., 0.]
    monkeypatch.setattr(embed, 'embed', fake)
    memory.rebuild_index()
    assert vectors.have_ids() == set()
    assert memory.list_memories()[0]['content'] == '喜欢香蕉'


def test_relevance_beats_recency_with_compressed_e5_cosines(monkeypatch):
    """E5 similarities cluster around .7-.9; old relevant facts must survive."""
    import math
    monkeypatch.setattr(memory, 'schedule_index', lambda: None)
    def fake(text, cfg=None):
        if text == 'question': return [1., 0.]
        similarity = .86 if text == 'old relevant memory' else .75
        return [similarity, math.sqrt(1-similarity**2)]
    monkeypatch.setattr(embed, 'embed', fake)
    relevant = memory.add_memory('old relevant memory')
    for text in ['新年一起看烟花', '周末去图书馆', '正在学习游泳', '下个月去旅行', '晚上早点睡觉', '今天去买鲜花']:
        memory.add_memory(text)
    memory.rebuild_index()
    assert memory.search_memories('question')[0]['id'] == relevant['id']


def test_legacy_vector_database_still_allows_edit_before_migration(monkeypatch):
    monkeypatch.setattr(memory, 'schedule_index', lambda: None)
    m = memory.add_memory('原来的偏好')
    with db.tx() as c:
        c.execute('CREATE VIRTUAL TABLE memory_vec USING vec0(id TEXT PRIMARY KEY, vec float[2] distance_metric=cosine)')
        c.execute("INSERT INTO meta(key,value) VALUES('vec_dim','2')")
        vectors.put(c,m['id'],[1.,0.])
    assert memory.update_memory(m['id'], '新的偏好')['content'] == '新的偏好'
    assert vectors.have_ids() == set()


def test_add_during_worker_exit_is_eventually_indexed(monkeypatch):
    """A request made while the old job exits must wake a replacement job."""
    import threading
    memory.shutdown_index()
    original_rebuild = memory.rebuild_index
    first_empty_batch = threading.Event()
    release = threading.Event()
    indexed = threading.Event()
    def slow_exit(connection=None):
        if not first_empty_batch.is_set():
            first_empty_batch.set()
            release.wait(timeout=3)
        else:
            original_rebuild(connection)
            indexed.set()
    monkeypatch.setattr(memory, 'rebuild_index', slow_exit)
    monkeypatch.setattr(embed, 'embed', lambda text, cfg=None: [1.,0.])
    # Use the real scheduler even when the global unit fixture disables scheduling.
    monkeypatch.setattr(memory, 'schedule_index', _real_schedule_index)
    first = memory.add_memory('用户喜欢巧克力')
    try:
        assert first_empty_batch.wait(timeout=3)
        second = memory.add_memory('用户在学习钢琴')
        release.set()
        assert indexed.wait(timeout=3)
        assert {first['id'], second['id']} <= vectors.have_ids()
    finally:
        release.set()
        memory.shutdown_index()


def test_search_and_external_index_schedule_do_not_reverse_locks(monkeypatch):
    """Timed lock bounds the historical deadlock so a regression cannot hang pytest."""
    import threading
    memory.shutdown_index()
    memory.add_memory('用户喜欢草莓蛋糕')
    monkeypatch.setattr(embed, 'embed', lambda text, cfg=None: [1., 0.])
    real_conn = db.conn
    real_missing = vectors.missing
    external_at_connection = threading.Event()
    release_external = threading.Event()
    start_external = threading.Event()
    timed_out = []
    errors = []
    result = []
    class TimedIndexLock:
        def __init__(self): self.lock = threading.Lock()
        def __enter__(self):
            if not self.lock.acquire(timeout=.5):
                timed_out.append(True)
                raise TimeoutError('index lock blocked by reversed database lock order')
            return self
        def __exit__(self, *args): self.lock.release()
    def observed_conn():
        if threading.current_thread().name == 'external-index-request':
            external_at_connection.set()
            if not release_external.wait(timeout=3):
                raise TimeoutError('test coordination timed out')
        return real_conn()
    def controlled_missing(limit=16):
        if threading.current_thread().name == 'semantic-search':
            start_external.set()
            if not external_at_connection.wait(timeout=3):
                raise TimeoutError('external scheduler did not reach connection acquisition')
            release_external.set()
        return real_missing(limit)
    monkeypatch.setattr(memory, '_index_lock', TimedIndexLock())
    monkeypatch.setattr(db, 'conn', observed_conn)
    monkeypatch.setattr(vectors, 'missing', controlled_missing)
    monkeypatch.setattr(memory, 'schedule_index', _real_schedule_index)
    def external():
        try:
            assert start_external.wait(timeout=3)
            memory.schedule_index()
        except Exception as exc: errors.append(exc)
    def search():
        try: result.extend(memory.search_memories('草莓蛋糕'))
        except Exception as exc: errors.append(exc)
    threads = [threading.Thread(target=external, name='external-index-request', daemon=True),
               threading.Thread(target=search, name='semantic-search', daemon=True)]
    try:
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=5)
        assert not any(thread.is_alive() for thread in threads)
        assert not errors
        assert not timed_out
        assert result[0]['content'] == '用户喜欢草莓蛋糕'
    finally:
        release_external.set()
        memory.shutdown_index()


def test_replaced_database_request_survives_old_worker_empty_exit(monkeypatch, tmp_path):
    import threading
    from app.core import state
    memory.shutdown_index()
    original_rebuild = memory.rebuild_index
    old_worker_exiting = threading.Event()
    release_old = threading.Event()
    new_indexed = threading.Event()
    def controlled_exit(connection=None):
        if not old_worker_exiting.is_set():
            old_worker_exiting.set()
            release_old.wait(timeout=3)
        else:
            original_rebuild(connection)
            new_indexed.set()
    monkeypatch.setattr(memory, 'rebuild_index', controlled_exit)
    monkeypatch.setattr(embed, 'embed', lambda text, cfg=None: [1., 0.])
    monkeypatch.setattr(memory, 'schedule_index', _real_schedule_index)
    old = memory.add_memory('旧数据库的记忆')
    try:
        assert old_worker_exiting.wait(timeout=3)
        db.reset()
        monkeypatch.setattr(state, 'DATA_DIR', tmp_path / 'restored-database')
        new = memory.add_memory('恢复后的新记忆')
        release_old.set()
        assert new_indexed.wait(timeout=1)
        assert vectors.have_ids() == {new['id']}
        assert old['id'] not in vectors.have_ids()
    finally:
        release_old.set()
        memory.shutdown_index()
