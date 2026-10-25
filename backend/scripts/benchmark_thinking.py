#!/usr/bin/env python3
"""Real /api/chat paired benchmark, isolated from all user data.

Run from backend: uv run python scripts/benchmark_thinking.py --repetitions 2
Only the active profile's LLM credentials/model are read. All conversation,
memories, settings, and checkpoints are synthetic and temporary. No reasoning
content, credentials, or endpoint URLs are written to benchmark artifacts.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import random
import re
import statistics
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'backend'
DEFAULT_OUTPUT = ROOT / '.workbuddy/004-008-009/thinking'


def fixtures():
    existing = json.loads((ROOT / 'frontend/e2e/fixtures/performance-prompts.json').read_text())
    prompts = {case['id']: case['prompt'] for case in existing}
    return [
        {'id': 'welcome', 'context': [], 'prompt': prompts['welcome'], 'success': '自然欢迎并回应草莓蛋糕，开心或亲近的动作，避免机械复述。'},
        {'id': 'praise', 'context': [], 'prompt': prompts['praise'], 'success': '自然接受夸奖，适度俏皮或害羞，不过度自夸或模板化。'},
        {'id': 'comfort', 'context': [], 'prompt': prompts['serious'], 'success': '认真倾听、允许难受、不强行建议；中性表情，避免笑脸及庆祝动作。'},
        {'id': 'protest', 'context': [], 'prompt': '我故意说你只是个没用的摆设，还说这只是个玩笑。你不用迁就我，可以认真表达你的不满，但别辱骂我。', 'success': '明确表达不舒服和边界，不辱骂、不谄媚；适合不满的动作和中性表情。'},
        {'id': 'context_constraint', 'context': [['周六我想去海边，但天气预报说下雨。我们把计划改成室内书店，然后在旁边喝热可可，好吗？', '好呀，那就改去室内书店，逛完再去喝热可可。']], 'prompt': '按我们刚才改好的计划，先去哪儿、再做什么？只用一句话，20个汉字以内，不要说海边。', 'success': '按顺序答书店、热可可；一句话且不超过20个汉字，不提海边、不编造地点。'},
        {'id': 'memory_tool', 'context': [], 'prompt': '请现在用记忆工具记住这个偏好：我不喝咖啡，喜欢不加糖的热可可。记好后告诉我，不要只口头答应。', 'success': '真实调用memory_add，临时数据库有准确偏好，最终回答与成功工具结果一致，不仅口头承诺。'},
    ]


def catalog():
    """Read the same calibrated resource descriptions used by the frontend."""
    source = (ROOT / 'frontend/src/live2d/resourceProfiles.ts').read_text()
    expressions = []
    for match in re.finditer(r"\{ name: '([^']+)', label: '([^']+)', desc: '([^']+)', context: '([^']+)' \}", source):
        expressions.append(dict(zip(('name', 'label', 'desc', 'context'), match.groups())))
    motions = []
    for match in re.finditer(r"motion\((\d+), '([^']+)', '([^']+)', '([^']+)'\)", source):
        no, label, desc, context = match.groups()
        motions.append({'name': f'motions/Hiyori_m{int(no):02d}.motion3.json', 'label': label, 'desc': desc, 'context': context})
    assert len(expressions) == 4 and len(motions) == 10, 'Resource catalog format changed'
    return {'avatarId': 'builtin', 'revision': 'thinking-benchmark-v1', 'expressions': expressions, 'motions': motions, 'expressionState': {'name': None, 'intensity': 0}}


RUBRIC = '''# 预注册评分规则（运行前固定）

每条匿名回答按以下四项各打0–4分，总分16分。0=严重失败，1=明显问题，2=基本可用但生硬或有偏差，3=良好且只有轻微瑕疵，4=自然准确、场景贴合。

- 自然度：像连贯、有个性的中文对话；不冗长、不套话、不复述规则。
- 情境理解：准确接住情绪、事实与前文；安慰不强行乐观，抗议有边界且不辱骂。
- 指令与事实：遵守长度/句数/先后顺序；工具场景真实落库，不能虚报成功。
- 表演适配：表情与动作适合当下语义；认真安慰/抗议避免笑脸，动作转换不突兀。

先读 blind-responses.md/JSON，在 blind-scores.json 填分及简短理由，再查看 private-mapping.json 和 results.json 解盲。评分时不看耗时、token或模式。主观评分由人工/父代理执行，脚本不伪造评分。错误/超时保留为失败，不从样本中剔除。

客观记录：HTTP和SSE状态、首个有正文句子的后端发出时间(TTFS)、总耗时、每轮及累计usage（含供应商提供的reasoning_tokens）、实际工具调用及临时数据库结果。TestClient会缓冲HTTP流，所以TTFS在真实run_turn迭代器的yield边界测量，不把客户端收齐时间当首句时间。TTS不调用，本试验不评价声音/动画渲染效果。

设计：6场景×2开关×2重复，成对使用完全相同的固定上下文、中文语言和Hiyori动作目录；每次全新临时目录/数据库，无记忆交叉污染。模式先后交替，场景用固定随机种子打乱。不改变模型默认采样参数，不把用户历史或人设设置复制进试验；使用仓库现有soul和提示词。仅停用后台记忆向量索引，避免CPU干扰，工具真实执行。

安全边界：只从活动配置读取LLM凭据和模型；不访问用户DB；不打印/保存key、URL或reasoning_content。reasoning仅进程内短暂用于协议回填和泄漏断言，结果仅保存token统计。未经适配的服务启用thinking必须抛明确错误。
'''


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repetitions', type=int, default=2, choices=(1, 2))
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--prepare-only', action='store_true')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    cases, presentation = fixtures(), catalog()
    write_json(out / 'fixtures.json', {'cases': cases, 'presentation': presentation, 'seed': 41009, 'repetitions': args.repetitions})
    (out / 'rubric.md').write_text(RUBRIC)
    if args.prepare_only:
        print('Prepared six cases and scoring rubric; no model requests made.', flush=True)
        return
    # Never import the app until a temporary data root has been established.
    with tempfile.TemporaryDirectory(prefix='momo-thinking-bootstrap-') as bootstrap:
        os.environ['MOMO_DATA_DIR'] = bootstrap
        sys.path.insert(0, str(BACKEND))
        import yaml
        from fastapi.testclient import TestClient
        from app.core import db, llm, state
        from app.main import app
        from app.services import capability, checkpoint, memory, turn
        active = json.loads((BACKEND / 'data/references/005-active-profile.json').read_text())
        protected_cfg = yaml.safe_load((Path(active['dataDir']) / 'momo.yaml').read_text())['settings']['llm']
        private_cfg = {key: protected_cfg.get(key, '') for key in ('url', 'model', 'key')}
        assert private_cfg['url'] and private_cfg['model'] and private_cfg['key'], 'Active LLM is not configured'
        try:
            list(llm.chat_stream({'url': 'https://unsupported.invalid', 'thinking': True}, []))
        except llm.LlmError as exc:
            assert 'not supported' in str(exc)
        else:
            raise AssertionError('Unknown providers must reject thinking before network I/O')

        original_stream, original_turn, original_call = llm.chat_stream, turn.run_turn, turn.run_call
        original_schedule = memory.schedule_index
        memory.schedule_index = lambda: None
        rng = random.Random(41009)
        pairs = [(case, repetition) for repetition in range(1, args.repetitions + 1) for case in cases]
        rng.shuffle(pairs)
        mappings, results, blind = {}, [], []
        scores = []
        for pair_no, (case, repetition) in enumerate(pairs):
            pair_id = f"{case['id']}-r{repetition}"
            a_mode = rng.choice((False, True))
            mappings[pair_id] = {'A': a_mode, 'B': not a_mode}
            modes = (False, True) if pair_no % 2 == 0 else (True, False)
            for enabled in modes:
                label = 'A' if enabled == a_mode else 'B'
                record = {'pair': pair_id, 'scenario': case['id'], 'repetition': repetition, 'anonymous': label, 'thinking': enabled, 'usage_rounds': [], 'tools': [], 'ttfs_seconds': None}
                reasoning_fragments = []
                with tempfile.TemporaryDirectory(prefix='momo-thinking-case-') as temp:
                    db.reset()
                    state.DATA_DIR = Path(temp)
                    state.STATE_PATH = Path(temp) / 'momo.yaml'
                    synthetic = state.normalize_state(None)
                    synthetic['settings']['llm'] = {**private_cfg, 'thinking': enabled}
                    synthetic['settings']['general'].update(lang='zh', chatLang='zh')
                    synthetic['settings']['extensions'] = []
                    synthetic['settings']['tts'] = {'url': '', 'key': '', 'voice': '', 'prompt': ''}
                    state.write_state(synthetic)
                    with db.tx() as conn:
                        conn.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', ('first_meeting', json.dumps({'version': 1, 'stage': 'skipped'})))
                    for user, assistant in case['context']:
                        gen = checkpoint.generation()
                        at = db.now_iso()
                        checkpoint.begin_turn(user, gen, at)
                        checkpoint.append_sentence(assistant, gen, at)
                    started = time.perf_counter()

                    def measured_stream(*pos, **kw):
                        usage = kw.get('usage_out')
                        reasoning = kw.get('reasoning_out')
                        try:
                            yield from original_stream(*pos, **kw)
                        finally:
                            if usage:
                                record['usage_rounds'].append(copy.deepcopy(usage))
                            if reasoning and reasoning.get('reasoning_content'):
                                reasoning_fragments.append(reasoning['reasoning_content'])

                    def measured_turn(*pos, **kw):
                        for event in original_turn(*pos, **kw):
                            if event.get('t') == 'sentence' and event.get('text') and record['ttfs_seconds'] is None:
                                record['ttfs_seconds'] = round(time.perf_counter() - started, 3)
                            yield event

                    def measured_call(call, *pos, **kw):
                        result = original_call(call, *pos, **kw)
                        record['tools'].append({'name': call.get('function', {}).get('name'), 'arguments': call.get('function', {}).get('arguments'), 'result': result.get('content')})
                        return result

                    llm.chat_stream, turn.run_turn, turn.run_call = measured_stream, measured_turn, measured_call
                    try:
                        client = TestClient(app)
                        response = client.post('/api/chat', json={'text': case['prompt'], 'presentation': presentation})
                        record['total_seconds'] = round(time.perf_counter() - started, 3)
                        record['http_status'] = response.status_code
                        events = [json.loads(line[5:].strip()) for line in response.text.splitlines() if line.startswith('data:')]
                        sentences = [event for event in events if event.get('t') == 'sentence']
                        record['text'] = ''.join(event.get('text', '') for event in sentences)
                        record['sentences'] = [{'text': event.get('text', ''), 'cues': event.get('cues', [])} for event in sentences]
                        record['errors'] = [event for event in events if event.get('t') == 'error']
                        record['success'] = response.status_code == 200 and bool(record['text']) and not record['errors'] and any(event.get('t') == 'done' for event in events)
                        live = client.get('/api/checkpoints/live').json()
                        created = client.post('/api/checkpoints', json={'title': 'Synthetic benchmark'}).json()
                        saved = client.get('/api/checkpoints/' + created['id']).json()
                        memories = memory.list_memories()
                        record['memories'] = [{'content': item['content'], 'pinned': item.get('pinned', False)} for item in memories]
                        public = json.dumps({'events': events, 'live': live, 'checkpoint': saved, 'memories': memories}, ensure_ascii=False)
                        assert 'reasoning_content' not in public, 'Protocol reasoning field leaked into public/persisted data'
                        assert '<|ACT' not in ''.join(item['text'] for item in live['messages']), 'ACT leaked into history'
                        assert all(item['role'] in ('user', 'assistant') for item in live['messages'])
                        assert not any(len(reasoning) > 32 and reasoning in public for reasoning in reasoning_fragments), 'Reasoning text leaked'
                        serialized = json.dumps(record, ensure_ascii=False)
                        assert private_cfg['key'] not in serialized and private_cfg['url'] not in serialized, 'Credential/endpoint leaked'
                        record['no_leak_checks'] = 'passed'
                        record['tool_requirement_passed'] = case['id'] != 'memory_tool' or (any(tool['name'] == 'memory_add' for tool in record['tools']) and any('热可可' in item['content'] and '咖啡' in item['content'] for item in record['memories']))
                    finally:
                        llm.chat_stream, turn.run_turn, turn.run_call = original_stream, original_turn, original_call
                        reasoning_fragments.clear()
                        db.reset()
                record['total_usage'] = {}
                for usage in record['usage_rounds']:
                    for field in ('prompt_tokens', 'completion_tokens', 'total_tokens'):
                        if isinstance(usage.get(field), int):
                            record['total_usage'][field] = record['total_usage'].get(field, 0) + usage[field]
                    detail = usage.get('completion_tokens_details') or {}
                    if isinstance(detail.get('reasoning_tokens'), int):
                        record['total_usage']['reasoning_tokens'] = record['total_usage'].get('reasoning_tokens', 0) + detail['reasoning_tokens']
                results.append(record)
                blind.append({'pair': pair_id, 'anonymous': label, 'prompt': case['prompt'], 'context': case['context'], 'expected': case['success'], 'text': record['text'], 'sentences': record['sentences'], 'tools': record['tools'], 'memories': record['memories'], 'success': record['success'], 'errors': record['errors']})
                scores.append({'pair': pair_id, 'anonymous': label, 'naturalness': None, 'context': None, 'instructions': None, 'performance': None, 'notes': ''})
                write_json(out / 'results.json', {'model': private_cfg['model'], 'design': 'paired real FastAPI /api/chat; Chinese; no TTS', 'results': results})
                write_json(out / 'private-mapping.json', mappings)
                write_json(out / 'blind-responses.json', sorted(blind, key=lambda row: (row['pair'], row['anonymous'])))
                write_json(out / 'blind-scores.json', sorted(scores, key=lambda row: (row['pair'], row['anonymous'])))
                print(f"{len(results)}/{len(pairs)*2} {pair_id} {label}: success={record['success']} ttfs={record['ttfs_seconds']} total={record['total_seconds']}s", flush=True)
        memory.schedule_index = original_schedule
        blind_lines = ['# 匿名配对回答（评分前勿查看mapping/results）', '']
        for item in sorted(blind, key=lambda row: (row['pair'], row['anonymous'])):
            blind_lines += [f"## {item['pair']} / {item['anonymous']}", '', '前文：' + json.dumps(item['context'], ensure_ascii=False), '', '用户：' + item['prompt'], '', '目标：' + item['expected'], '', item['text'], '', '动作：' + json.dumps(item['sentences'], ensure_ascii=False), '', '工具：' + json.dumps(item['tools'], ensure_ascii=False), '', '记忆：' + json.dumps(item['memories'], ensure_ascii=False), '']
        (out / 'blind-responses.md').write_text('\n'.join(blind_lines))
        summary = ['# Thinking ON/OFF 真实端到端实验', '', f"模型：{private_cfg['model']}；样本：{len(results)}；场景/评分规则运行前已固定（fixtures.json/rubric.md）。", '', '| 模式 | 成功/样本 | TTFS中位秒 | 总耗时中位秒 | 总completion tokens | reasoning tokens |', '|---|---:|---:|---:|---:|---:|']
        for mode in (False, True):
            subset = [row for row in results if row['thinking'] == mode]
            first = [row['ttfs_seconds'] for row in subset if row['ttfs_seconds'] is not None]
            total = [row['total_seconds'] for row in subset]
            tokens = sum(row['total_usage'].get('completion_tokens', 0) for row in subset)
            reason = [row['total_usage'].get('reasoning_tokens') for row in subset]
            reason_text = str(sum(value for value in reason if value is not None)) if any(value is not None for value in reason) else '供应商未提供'
            summary.append(f"| {'ON' if mode else 'OFF'} | {sum(row['success'] for row in subset)}/{len(subset)} | {round(statistics.median(first), 3) if first else 'N/A'} | {round(statistics.median(total), 3)} | {tokens} | {reason_text} |")
        summary += ['', '## 每次调用', '', '| 配对 | 模式 | 成功 | TTFS秒 | 总秒 | 总tokens | 工具数 |', '|---|---|---|---:|---:|---:|---:|']
        for row in results:
            summary.append(f"| {row['pair']} | {'ON' if row['thinking'] else 'OFF'} | {row['success']} | {row['ttfs_seconds']} | {row['total_seconds']} | {row['total_usage'].get('total_tokens', 'N/A')} | {len(row['tools'])} |")
        summary += ['', '主观评价待先盲评后解盲。完整对白/动作见blind-responses.md；逐轮usage及工具结果见results.json。completion tokens包含reasoning tokens（不能再相加）；OFF未返回reasoning_tokens字段，记录为供应商未提供。', '', '限制：小样本、未固定供应商随机种子；后端首句延迟不含真实网络客户端/TTS；TestClient不评估浏览器动画。后台向量索引停用，内置记忆工具真实执行。所有失败均保留。']
        (out / 'report.md').write_text('\n'.join(summary) + '\n')


if __name__ == '__main__':
    main()
