#!/usr/bin/env python3
"""Narrow, local macOS WeChat AX bridge. Never exposes arbitrary UI/MCP actions.

Requires a dedicated user-authorized WeChat session and verified, unique AX
identity locators. Missing/changed UI identity fails closed. This implementation
is experimental until the exact WeChat build and account pass the login spike.
"""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import sqlite3
import threading
import time


class BridgeError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Journal:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.lock = threading.RLock()
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS snapshots (scope TEXT PRIMARY KEY, rows TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS inbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL);
        ''')
        self.db.commit()

    def observe(self, self_id, peer_id, rows):
        """Stitch only overlapping visible windows; never invent IDs for lost history."""
        scope = json.dumps([self_id, peer_id], separators=(',', ':'))
        raw_rows = [list(item) for item in rows]
        rows = [[sender, hashlib.sha256(text.encode()).hexdigest()] for sender, text in raw_rows]
        with self.lock, self.db:
            previous = self.db.execute('SELECT rows FROM snapshots WHERE scope=?', (scope,)).fetchone()
            old = json.loads(previous[0]) if previous else None
            if old is None:
                self.db.execute('INSERT INTO snapshots VALUES (?,?)', (scope, json.dumps(rows)))
                return []  # Initial history is baseline, not new incoming messages.
            overlap = next((size for size in range(min(len(old), len(rows)), 0, -1) if old[-size:] == rows[:size]), 0)
            if old and rows and not overlap:
                raise BridgeError('SYNC_REQUIRED')
            events = []
            if self.db.execute('SELECT COUNT(*) FROM inbox').fetchone()[0] + len(raw_rows[overlap:]) > 4096:
                raise BridgeError('INBOX_CAPACITY')
            for sender, text in raw_rows[overlap:]:
                if sender != 'OTHER' or not text.strip():
                    continue
                event = {'selfId': self_id, 'peerId': peer_id, 'senderId': peer_id, 'conversationKind': 'private', 'text': text}
                cursor = self.db.execute('INSERT INTO inbox(body) VALUES (?)', (json.dumps(event, ensure_ascii=False),)).lastrowid
                event['externalMessageId'] = f'wxax:{self_id}:{peer_id}:{cursor}'
                self.db.execute('UPDATE inbox SET body=? WHERE seq=?', (json.dumps(event, ensure_ascii=False), cursor))
                events.append(event)
            self.db.execute('INSERT OR REPLACE INTO snapshots VALUES (?,?)', (scope, json.dumps(rows, ensure_ascii=False)))
            return events

    def inbox(self, cursor):
        try:
            after = int(cursor or '0')
        except ValueError:
            raise BridgeError('INVALID_CURSOR')
        if after < 0:
            raise BridgeError('INVALID_CURSOR')
        with self.lock:
            rows = self.db.execute('SELECT seq,body FROM inbox WHERE seq>? ORDER BY seq LIMIT 100', (after,)).fetchall()
        return {'events': [json.loads(row[1]) for row in rows], 'cursor': str(rows[-1][0] if rows else after)}

    def ack(self, cursor):
        if not str(cursor).isdigit():
            raise BridgeError('INVALID_CURSOR')
        with self.lock, self.db:
            self.db.execute('DELETE FROM inbox WHERE seq<=?', (int(cursor),))
        return {'acknowledged': True}

    def claim(self, command):
        value = {key: command.get(key) for key in ['commandId', 'expectedSelfId', 'peerId', 'text']}
        digest = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.lock, self.db:
            old = self.db.execute('SELECT digest FROM commands WHERE id=?', (value['commandId'],)).fetchone()
            if old:
                if old[0] != digest:
                    raise BridgeError('COMMAND_MISMATCH')
                return False
            body = {'commandId': value['commandId'], 'actualSelfId': value['expectedSelfId'], 'peerId': value['peerId'], 'status': 'unknown', 'executorQuiescent': True}
            self.db.execute('INSERT INTO commands VALUES (?,?,?)', (value['commandId'], digest, json.dumps(body)))
            return True

    def command(self, command_id):
        with self.lock:
            row = self.db.execute('SELECT body FROM commands WHERE id=?', (command_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def finish(self, result):
        with self.lock, self.db:
            self.db.execute('UPDATE commands SET body=? WHERE id=?', (json.dumps(result), result['commandId']))
        return result

    def close(self):
        self.db.close()


class MacAXDriver:
    """Targets AX elements directly; no global clicks, keyboard, search or eval."""
    def __init__(self, config):
        self.config = config
        self.import_error = None
        try:
            import AppKit
            import ApplicationServices as AX
            import Quartz
            from PIL import Image, ImageChops
            self.AppKit, self.AX, self.Q, self.Image, self.ImageChops = AppKit, AX, Quartz, Image, ImageChops
        except ImportError:
            self.import_error = 'DEPENDENCY_REQUIRED'

    def attr(self, element, name):
        err, value = self.AX.AXUIElementCopyAttributeValue(element, name, None)
        return value if err == 0 else None

    def walk(self, root):
        todo, count = [(root, 0)], 0
        while todo:
            node, depth = todo.pop()
            count += 1
            if count > 20000:
                raise BridgeError('AX_TREE_CHANGED')
            yield node
            if depth < 30:
                todo.extend((child, depth + 1) for child in (self.attr(node, 'AXChildren') or []))

    def unique(self, root, locator):
        # Identity must be a concrete UI value, never a caller-supplied display name.
        if not isinstance(locator, dict) or not locator.get('identifier') or not isinstance(locator.get('value'), str):
            raise BridgeError('AX_BINDING_REQUIRED')
        matches = [node for node in self.walk(root)
                   if self.attr(node, 'AXIdentifier') == locator['identifier']
                   and str(self.attr(node, locator.get('attribute', 'AXValue')) or '') == locator['value']]
        if len(matches) != 1:
            raise BridgeError('AX_IDENTITY_AMBIGUOUS' if matches else 'AX_IDENTITY_UNAVAILABLE')
        return matches[0]

    def root(self):
        if self.import_error:
            raise BridgeError(self.import_error)
        if self.config.get('dedicatedSessionAcknowledged') is not True:
            raise BridgeError('DEDICATED_SESSION_REQUIRED')
        if not self.AX.AXIsProcessTrusted():
            raise BridgeError('ACCESSIBILITY_REQUIRED')
        apps = self.AppKit.NSRunningApplication.runningApplicationsWithBundleIdentifier_('com.tencent.xinWeChat')
        if len(apps) != 1:
            raise BridgeError('WECHAT_LOGIN_REQUIRED')
        self.pid = int(apps[0].processIdentifier())
        if self.config.get('expectedProcessId') and self.pid != self.config['expectedProcessId']:
            raise BridgeError('WECHAT_SESSION_CHANGED')
        root = self.AX.AXUIElementCreateApplication(self.pid)
        locator = self.config.get('selfIdentity')
        if not isinstance(locator, dict) or locator.get('value') != self.config.get('expectedSelfId'):
            raise BridgeError('AX_ACCOUNT_BINDING_REQUIRED')
        self.unique(root, locator)
        return root

    def binding(self, root, peer_id):
        peers = [peer for peer in self.config.get('peers', []) if peer.get('peerId') == peer_id]
        if len(peers) != 1 or peers[0].get('privateConfirmed') is not True:
            raise BridgeError('PEER_UNVERIFIED')
        peer = peers[0]
        locator = peer.get('identity')
        if not isinstance(locator, dict) or locator.get('value') != peer_id:
            raise BridgeError('PEER_UNVERIFIED')
        chat_id = self.config.get('chatIdentifier', 'chat_detail_view')
        chats = [node for node in self.walk(root) if self.attr(node, 'AXIdentifier') == chat_id]
        if len(chats) != 1:
            raise BridgeError('AX_CHAT_CHANGED')
        chat = chats[0]
        # All authority and controls must belong to this one active conversation.
        header_id = self.config.get('headerIdentifier', 'chat_header')
        headers = [node for node in self.walk(chat) if self.attr(node, 'AXIdentifier') == header_id]
        if len(headers) != 1:
            raise BridgeError('AX_CHAT_CHANGED')
        self.unique(headers[0], locator)
        for identifier in ('chat_message_list', self.config.get('editorIdentifier', 'chat_input_text_view'), self.config.get('sendIdentifier', 'chat_send_button')):
            if sum(self.attr(node, 'AXIdentifier') == identifier for node in self.walk(chat)) != 1:
                raise BridgeError('AX_CHAT_CHANGED')
        return chat

    def health(self):
        try:
            root = self.root()
            peers = []
            for peer in self.config.get('peers', []):
                try:
                    self.binding(root, peer.get('peerId'))
                    peers.append({'peerId': peer['peerId'], 'verified': True})
                except BridgeError:
                    pass
            screen = bool(self.Q.CGPreflightScreenCaptureAccess())
            return {'status': 'connected', 'actualSelfId': self.config['expectedSelfId'], 'identityKind': 'personal', 'identityVerified': True,
                    'capabilities': {'receive': bool(peers) and screen, 'reply': bool(peers) and screen, 'durableAck': True}, 'peers': peers}
        except BridgeError as error:
            return {'status': 'setup_required', 'error': error.code, 'actualSelfId': None, 'identityKind': 'personal', 'identityVerified': False,
                    'capabilities': {'receive': False, 'reply': False}, 'peers': []}

    def position(self, element):
        value = self.attr(element, 'AXPosition')
        ok, point = self.AX.AXValueGetValue(value, self.AX.kAXValueCGPointType, None) if value else (False, None)
        return (point.x, point.y) if ok else None

    def size(self, element):
        value = self.attr(element, 'AXSize')
        ok, size = self.AX.AXValueGetValue(value, self.AX.kAXValueCGSizeType, None) if value else (False, None)
        return (size.width, size.height) if ok else None

    def messages(self, root):
        if not self.Q.CGPreflightScreenCaptureAccess():
            raise BridgeError('SCREEN_RECORDING_REQUIRED')
        panes = [n for n in self.walk(root) if self.attr(n, 'AXIdentifier') == 'chat_message_list']
        if len(panes) != 1:
            raise BridgeError('AX_CHAT_CHANGED')
        pane = panes[0]
        ppos, psize = self.position(pane), self.size(pane)
        if not ppos or not psize:
            raise BridgeError('AX_CHAT_CHANGED')
        windows = [w for w in self.Q.CGWindowListCopyWindowInfo(self.Q.kCGWindowListOptionOnScreenOnly, 0)
                   if w.get('kCGWindowOwnerPID') == self.pid and w.get('kCGWindowLayer') == 0]
        if len(windows) != 1:
            raise BridgeError('AX_WINDOW_AMBIGUOUS')
        window = windows[0]
        image = self.Q.CGWindowListCreateImage(self.Q.CGRectNull, self.Q.kCGWindowListOptionIncludingWindow,
                                             int(window['kCGWindowNumber']), self.Q.kCGWindowImageBoundsIgnoreFraming | self.Q.kCGWindowImageNominalResolution)
        if image is None:
            raise BridgeError('SCREEN_RECORDING_REQUIRED')
        width, height = self.Q.CGImageGetWidth(image), self.Q.CGImageGetHeight(image)
        pixels = self.Q.CGDataProviderCopyData(self.Q.CGImageGetDataProvider(image))
        screenshot = self.Image.frombuffer('RGBA', (width, height), pixels, 'raw', 'BGRA', self.Q.CGImageGetBytesPerRow(image), 1).convert('RGB')
        bounds = window['kCGWindowBounds']
        result = []
        # A top-level message row is classified from its pixels, not AX row width.
        for row in self.attr(pane, 'AXChildren') or []:
            if self.attr(row, 'AXIdentifier') not in ('chat_bubble_item_view', 'virtual_cell'):
                continue
            texts = [str(self.attr(n, 'AXValue') or self.attr(n, 'AXTitle') or '') for n in self.walk(row) if self.attr(n, 'AXRole') == 'AXStaticText']
            text = '\n'.join(t for t in texts if t).strip()
            if not text or len(text) > 32000:
                continue
            pos, size = self.position(row), self.size(row)
            if not pos or not size:
                raise BridgeError('AX_MESSAGE_AMBIGUOUS')
            box = (int(ppos[0] - bounds['X']), int(pos[1] - bounds['Y']), int(ppos[0] - bounds['X'] + psize[0] - 28), int(pos[1] - bounds['Y'] + size[1]))
            if box[0] < 0 or box[1] < 0 or box[2] > width or box[3] > height or box[2] <= box[0] or box[3] <= box[1]:
                raise BridgeError('AX_WINDOW_CHANGED')
            crop = screenshot.crop(box)
            colors = crop.getcolors(crop.width * crop.height)
            background = max(colors, key=lambda entry: entry[0])[1]
            content = self.ImageChops.difference(crop, self.Image.new('RGB', crop.size, background)).getbbox()
            if not content:
                continue
            left, right = content[0], crop.width - content[2]
            if abs(left - right) < 10:
                raise BridgeError('AX_SENDER_AMBIGUOUS')
            result.append(('OTHER' if left < right else 'ME', text))
        return result

    def read_current(self):
        root = self.root()
        matching = []
        for peer in self.config.get('peers', []):
            try:
                chat = self.binding(root, peer.get('peerId'))
                matching.append((peer['peerId'], chat))
            except BridgeError:
                pass
        if len(matching) != 1:
            raise BridgeError('AX_CHAT_IDENTITY_UNAVAILABLE')
        return matching[0][0], self.messages(matching[0][1])

    def send(self, command, cancelled):
        root = self.root()
        chat = self.binding(root, command['peerId'])
        editor_id = self.config.get('editorIdentifier', 'chat_input_text_view')
        button_id = self.config.get('sendIdentifier', 'chat_send_button')
        editors = [n for n in self.walk(chat) if self.attr(n, 'AXIdentifier') == editor_id]
        buttons = [n for n in self.walk(chat) if self.attr(n, 'AXIdentifier') == button_id]
        if len(editors) != 1 or len(buttons) != 1:
            raise BridgeError('AX_SEND_CONTROL_UNAVAILABLE')
        editor, button = editors[0], buttons[0]
        if str(self.attr(editor, 'AXValue') or '').strip():
            raise BridgeError('WECHAT_DRAFT_PRESENT')
        err, actions = self.AX.AXUIElementCopyActionNames(button, None)
        if err != 0 or 'AXPress' not in (actions or []):
            raise BridgeError('AX_SEND_CONTROL_UNAVAILABLE')
        before = self.messages(chat)
        if cancelled.is_set():
            raise BridgeError('CANCELLED')
        if self.AX.AXUIElementSetAttributeValue(editor, 'AXValue', command['text']) != 0:
            raise BridgeError('AX_EDITOR_UNAVAILABLE')
        # Re-read identity and gate immediately before the external side effect.
        root = self.root()
        chat = self.binding(root, command['peerId'])
        editor = next(n for n in self.walk(chat) if self.attr(n, 'AXIdentifier') == editor_id)
        button = next(n for n in self.walk(chat) if self.attr(n, 'AXIdentifier') == button_id)
        if self.attr(editor, 'AXValue') != command['text']:
            raise BridgeError('AX_CHAT_CHANGED')
        if cancelled.is_set():
            self.AX.AXUIElementSetAttributeValue(editor, 'AXValue', '')
            raise BridgeError('CANCELLED')
        if self.AX.AXUIElementPerformAction(button, 'AXPress') != 0:
            return 'unknown'
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if cancelled.wait(0.08):
                return 'unknown'
            root = self.root()
            chat = self.binding(root, command['peerId'])
            after = self.messages(chat)
            if after != before and after[-1:] == [('ME', command['text'])]:
                return 'client_observed'
        return 'unknown'


class Bridge:
    def __init__(self, config, journal, driver):
        self.config, self.journal, self.driver = config, journal, driver
        self.executor = threading.Lock()
        self.cancelled = threading.Event()
        self.done = threading.Event()
        self.active = False
        self.closed = threading.Event()
        self.state_lock = threading.Lock()
        self.generation = 0
        self.granted = False
        self.stopping = 0

    def admission(self):
        with self.state_lock:
            return self.generation

    def grant(self, admission_generation):
        with self.state_lock:
            if admission_generation != self.generation or self.stopping or self.active:
                raise BridgeError('STALE_GENERATION')
            self.generation += 1
            self.granted = True
            self.cancelled.clear()
            return {'executionGeneration': self.generation, 'executorQuiescent': not self.active}

    def health(self):
        result = self.driver.health()
        with self.state_lock:
            result['executorQuiescent'] = not self.active
            result['executionGeneration'] = self.generation if self.granted else None
            result.setdefault('capabilities', {})['executionFence'] = True
        return result

    def send(self, command, admission_generation=None):
        if not isinstance(command, dict) or not all(isinstance(command.get(key), str) and 0 < len(command[key]) <= limit for key, limit in [('commandId', 200), ('expectedSelfId', 200), ('peerId', 200), ('text', 32000)]):
            raise BridgeError('INVALID_COMMAND')
        if command['expectedSelfId'] != self.config.get('expectedSelfId'):
            raise BridgeError('ACCOUNT_MISMATCH')
        if not self.executor.acquire(blocking=False):
            raise BridgeError('BUSY')
        try:
            with self.state_lock:
                if not self.granted or admission_generation != self.generation or command.get('executionGeneration') != self.generation:
                    raise BridgeError('STALE_GENERATION')
                self.active = True
            if not self.journal.claim(command):
                return self.journal.command(command['commandId'])
            status = 'unknown'
            try:
                status = self.driver.send(command, self.cancelled)
            except BridgeError:
                # Without an action-stage proof, retain unknown rather than resend.
                pass
            return self.journal.finish({'commandId': command['commandId'], 'actualSelfId': command['expectedSelfId'], 'peerId': command['peerId'], 'status': status, 'executorQuiescent': True})
        finally:
            with self.state_lock:
                self.active = False
            self.executor.release()

    def stop(self):
        with self.state_lock:
            self.stopping += 1
            self.granted = False
            self.generation += 1
            self.cancelled.set()
        acquired = self.executor.acquire(timeout=3)
        if acquired:
            self.executor.release()
        with self.state_lock:
            quiescent = acquired and not self.active
            self.stopping -= 1
            return {'executorQuiescent': quiescent, 'executionGeneration': self.generation}

    def watch(self):
        while not self.closed.wait(1):
            if not self.executor.acquire(blocking=False):
                continue
            try:
                peer_id, rows = self.driver.read_current()
                self.journal.observe(self.config['expectedSelfId'], peer_id, rows)
            except BridgeError:
                pass
            finally:
                self.executor.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=9848)
    parser.add_argument('--doctor', action='store_true', help='Read readiness only; never activate/click the client')
    args = parser.parse_args()
    if args.config.stat().st_mode & 0o077:
        parser.error('Private bridge configuration must have permissions 600')
    config = json.loads(args.config.read_text())
    if not isinstance(config.get('token'), str) or len(config['token']) < 24:
        parser.error('Set a private random bridge token of at least 24 characters')
    driver = MacAXDriver(config)
    if args.doctor:
        print(json.dumps(driver.health(), ensure_ascii=False))
        return
    bridge = Bridge(config, Journal(args.state_dir / 'journal.sqlite3'), driver)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Request URLs, content and bearer tokens never enter logs.

        def handle_request(self):
            token = self.headers.get('Authorization', '')
            if not secrets.compare_digest(token, 'Bearer ' + config['token']):
                self.respond(401, {'error': 'UNAUTHORIZED'})
                return
            try:
                from urllib.parse import urlparse, parse_qs
                path = urlparse(self.path)
                if self.command == 'GET' and path.path == '/v1/health':
                    self.respond(200, bridge.health())
                elif self.command == 'GET' and path.path == '/v1/inbox':
                    self.respond(200, bridge.journal.inbox(parse_qs(path.query).get('cursor', ['0'])[0]))
                elif self.command == 'POST' and path.path in ('/v1/send', '/v1/stop', '/v1/ack', '/v1/grant'):
                    admission_generation = bridge.admission() if path.path in ('/v1/send', '/v1/grant') else None
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= 128 * 1024:
                        raise BridgeError('INVALID_COMMAND')
                    command = json.loads(self.rfile.read(length))
                    if command.get('expectedSelfId') != config.get('expectedSelfId'):
                        raise BridgeError('ACCOUNT_MISMATCH')
                    if path.path == '/v1/ack':
                        self.respond(200, bridge.journal.ack(command.get('cursor')))
                    elif path.path == '/v1/grant':
                        self.respond(200, bridge.grant(admission_generation))
                    else:
                        self.respond(200, bridge.stop() if path.path == '/v1/stop' else bridge.send(command, admission_generation=admission_generation))
                else:
                    self.respond(404, {'error': 'METHOD_UNAVAILABLE'})
            except (BridgeError, ValueError, TypeError) as error:
                self.respond(409, {'error': error.code if isinstance(error, BridgeError) else 'INVALID_COMMAND', 'status': 'not_sent', 'executorQuiescent': not bridge.active})
            except Exception:
                self.respond(500, {'error': 'BRIDGE_FAILURE', 'status': 'unknown', 'executorQuiescent': not bridge.active})

        def respond(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        do_GET = do_POST = handle_request

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.daemon_threads = True
    threading.Thread(target=bridge.watch, daemon=True).start()
    print(f'momo WeChat bridge listening on 127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.closed.set()
        bridge.stop()
        server.server_close()


if __name__ == '__main__':
    main()
