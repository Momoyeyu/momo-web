"""Local HTTP protocol smoke, not a load test or semantic-quality evaluation."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from app.core import state
from app.services import checkpoint, compress, turn
from conftest import add_turn


def test_openai_http_chat_compact_continue(monkeypatch):
    requests=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self):
            payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(payload)
            self.send_response(200)
            if payload['stream']:
                self.send_header('Content-Type','text/event-stream'); self.end_headers()
                chunks=[{'choices':[{'delta':{'content':'Welcome back.'}}]},
                        {'choices':[], 'usage':{'prompt_tokens':100,'completion_tokens':4}}, '[DONE]']
                for item in chunks:
                    self.wfile.write(('data: '+(item if isinstance(item,str) else json.dumps(item))+'\n\n').encode())
            else:
                self.send_header('Content-Type','application/json'); self.end_headers()
                self.wfile.write(json.dumps({'choices':[{'message':{'role':'assistant','content':'We discussed a shared day.'}}], 'usage':{'prompt_tokens':150,'completion_tokens':12}}).encode())
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=Thread(target=server.serve_forever,daemon=True); thread.start()
    cfg=state.load(); cfg['settings']['llm'].update(url=f'http://127.0.0.1:{server.server_port}',model='smoke')
    monkeypatch.setattr(turn,'load_state',lambda:cfg)
    monkeypatch.setattr(compress,'load_state',lambda:cfg)
    try:
        for i in range(9): add_turn(f'We discussed the activities of day {i}.','I remember those activities.',at=str(i))
        events=list(turn.run_turn('Hello again.'))
        assert any(e.get('t')=='sentence' and e.get('text')=='Welcome back.' for e in events)
        assert compress.compress_once()
        assert checkpoint.live_summary()=='We discussed a shared day.'
        events=list(turn.run_turn('Continue our conversation.'))
        assert any(e.get('t')=='sentence' for e in events)
        assert requests[-1]['stream'] is True
        assert any('We discussed a shared day.' in m['content'] for m in requests[-1]['messages'])
        assert all(r['max_tokens']==4096 for r in requests)
        assert next(r for r in requests if not r['stream']).get('tools') is None
    finally:
        server.shutdown(); server.server_close(); thread.join(2)
