"""ACT stream: chunk boundaries, invalid controls and independent channels."""
from app.core.performance import ActStream
from app.core.sentences import SentenceStream


def parse(text, size=1):
    stream = ActStream()
    out = []
    for i in range(0, len(text), size):
        out.extend(stream.push(text[i:i + size]))
    out.extend(stream.flush())
    plain = ''.join(token for token in out if isinstance(token, str))
    return plain, [token for token in out if isinstance(token, dict)]


def test_act_is_removed_from_text_for_any_chunk_size():
    source = '前😊<|ACT {"expression":{"name":"happy","intensity":0.8},"motion":"TapBody/0"}|>后。'
    for size in (1, 2, 7, len(source)):
        plain, acts = parse(source, size)
        assert plain == '前😊后。'
        assert acts == [{'expression': {'name': 'happy', 'intensity': 0.8}, 'motion': 'TapBody/0'}]


def test_invalid_channel_does_not_discard_valid_expression():
    assert parse('<|ACT {"expression":null,"motion":42}|>')[1] == [{'expression': None}]
    assert parse('<|ACT {"expression":{"name":"x","intensity":9}}|>')[1] == [
        {'expression': {'name': 'x', 'intensity': 1.0}}
    ]


def test_malformed_truncated_and_oversize_controls_do_not_leak():
    assert parse('甲<|ACT bad|>乙')[0] == '甲乙'
    assert parse('甲<|ACT {')[0] == '甲'
    assert parse('甲<|ACT ' + 'x' * 3000 + '|>乙')[0] == '甲乙'
    assert parse('甲<|ACT {"x":"bad<|ACT {"expression":null}|>乙') == ('甲乙', [{'expression': None}])
    assert parse('a < b')[0] == 'a < b'


def test_act_json_string_can_contain_delimiter():
    assert parse('<|ACT {"expression":{"name":"a|>b"}}|>')[1] == [
        {'expression': {'name': 'a|>b', 'intensity': 1.0}}
    ]


def test_sentence_cues_keep_codepoint_offsets_and_control_only_tail():
    text = '前😊<|ACT {"expression":{"name":"happy"}}|>后。<|ACT {"expression":null}|>'
    whole = None
    for size in (1, 2, 13, len(text)):
        stream = SentenceStream()
        out = []
        for i in range(0, len(text), size):
            out.extend(stream.push(text[i:i + size]))
        out.extend(stream.flush())
        result = [(s.text, [(c.offset, c.payload) for c in s.cues]) for s in out]
        assert result == [('前😊后。', [(2, {'expression': {'name': 'happy', 'intensity': 1.0}})]),
                          ('', [(0, {'expression': None})])]
        assert result == (whole or result)
        whole = result


def test_prompt_uses_only_runtime_catalog_not_stored_avatar():
    from app.core.state import normalize_state
    from app.services.prompt import build_system_prompt
    state = normalize_state({})
    assert 'ACT' not in build_system_prompt(state, [])
    catalog = {'avatarId': 'fallback', 'revision': 'r1', 'expressions': [{'name': 'happy', 'desc': '开心'}],
               'motions': [], 'expressionState': {'name': None, 'intensity': 0}}
    prompt = build_system_prompt(state, [], catalog)
    assert '<|ACT ' in prompt and 'happy' in prompt and '开心' in prompt
    assert 'Idle/4' not in prompt


def test_control_only_round_is_not_written_as_empty_history(monkeypatch):
    from app.core import llm
    from app.services import turn, checkpoint
    def fake(*args, **kwargs):
        yield {'type': 'text', 'delta': '<|ACT {"expression":null}|>'}
    monkeypatch.setattr(llm, 'chat_stream', fake)
    catalog = {'avatarId': 'a', 'revision': 'r', 'expressions': [], 'motions': [],
               'expressionState': {'name': None, 'intensity': 0}}
    events = list(turn.run_turn('你好', catalog))
    assert events[0]['text'] == '' and events[0]['cues'][0]['expression'] is None
    # Controls alone do not constitute a spoken reply or keep an unanswered input.
    assert checkpoint.live_messages() == []


def test_surrounding_whitespace_does_not_erase_control_only_output():
    from app.core.sentences import split_sentences
    out = split_sentences('\n<|ACT {"expression":null}|>\n')
    assert len(out) == 1 and out[0].text == ''
    assert out[0].cues[0].payload == {'expression': None}


def test_performance_reminder_is_after_old_dialogue_without_changing_stored_history():
    from app.core.state import normalize_state
    from app.services import checkpoint, turn
    checkpoint.begin_turn('before', checkpoint.generation(), '')
    checkpoint.append_sentence('previous plain reply', checkpoint.generation(), '')
    catalog = {'avatarId': 'a', 'revision': 'r', 'expressions': [{'name': 'happy', 'desc': '开心'}],
               'motions': [], 'expressionState': {'name': None, 'intensity': 0}}
    messages = turn.build_messages(normalize_state({}), 'now', catalog)
    assert messages[-2]['role'] == 'system' and '<|ACT ' in messages[-2]['content']
    assert messages[-1] == {'role': 'user', 'content': 'now'}
    assert checkpoint.live_messages()[-1]['text'] == 'previous plain reply'


def test_catalog_keeps_visual_fact_separate_from_context_and_uses_file_ids():
    from app.api.chat import ControlIn
    from app.core.state import normalize_state
    from app.services.prompt import build_system_prompt
    control = ControlIn(name='motions/wave.motion3.json', label='挥手', desc='右手抬起左右摆动', context='欢迎；安慰时避免', duration=2.5)
    catalog = {'avatarId': 'a', 'revision': 'r', 'expressions': [], 'motions': [control.model_dump()], 'expressionState': {'name': None, 'intensity': 0}}
    prompt = build_system_prompt(normalize_state({}), [], catalog)
    assert 'visual appearance' in prompt and 'usage context' in prompt
    assert '右手抬起左右摆动' in prompt and '欢迎；安慰时避免' in prompt
    assert 'motions/wave.motion3.json' in prompt
