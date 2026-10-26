import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest

path = Path(__file__).resolve().parents[2] / 'scripts' / 'wechat-bridge.py'
spec = importlib.util.spec_from_file_location('bridge', path)
bridge = importlib.util.module_from_spec(spec)

class MacBridgeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec.loader.exec_module(bridge)

    def test_strict_binding_and_no_startup_history_import(self):
        with tempfile.TemporaryDirectory() as temp:
            journal = bridge.Journal(Path(temp) / 'journal.sqlite3')
            self.assertEqual(journal.observe('self', 'peer', [('OTHER', 'old')]), [])
            first = journal.observe('self', 'peer', [('OTHER', 'old'), ('OTHER', 'hello'), ('OTHER', 'hello')])
            self.assertEqual(len(first), 2)
            self.assertNotEqual(first[0]['externalMessageId'], first[1]['externalMessageId'])
            self.assertEqual(journal.observe('self', 'peer', [('OTHER', 'old'), ('OTHER', 'hello'), ('OTHER', 'hello')]), [])
            journal.close()
            reopened = bridge.Journal(Path(temp) / 'journal.sqlite3')
            self.assertEqual(len(reopened.inbox('0')['events']), 2)
            self.assertNotIn('hello', reopened.db.execute('SELECT rows FROM snapshots').fetchone()[0])
            reopened.ack('2')
            self.assertEqual(reopened.inbox('0')['events'], [])
            with self.assertRaises(bridge.BridgeError): reopened.observe('self', 'peer', [('OTHER', 'unrelated window')])
            reopened.close()

    def test_unknown_command_is_never_reexecuted_even_after_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'journal.sqlite3'
            journal = bridge.Journal(path)
            command = {'commandId': 'cmd', 'expectedSelfId': 'self', 'peerId': 'peer', 'text': 'hi'}
            self.assertTrue(journal.claim(command))
            self.assertFalse(journal.claim(command))
            journal.close()
            reopened = bridge.Journal(path)
            self.assertFalse(reopened.claim(command))
            with self.assertRaises(bridge.BridgeError): reopened.claim({**command, 'text': 'changed'})
            self.assertEqual(reopened.command('cmd')['status'], 'unknown')
            reopened.close()

    def test_unique_ax_locator_and_private_scope_fail_closed(self):
        class Node:
            def __init__(self, identifier, value='', children=()): self.identifier, self.value, self.children = identifier, value, children
        driver = bridge.MacAXDriver.__new__(bridge.MacAXDriver)
        driver.attr = lambda node, key: {'AXIdentifier': node.identifier, 'AXValue': node.value, 'AXChildren': node.children}.get(key)
        root = Node('root', children=[Node('id', 'wxid_peer'), Node('id', 'wxid_peer')])
        with self.assertRaises(bridge.BridgeError): driver.unique(root, {'identifier': 'id', 'value': 'wxid_peer'})
        one = Node('root', children=[Node('id', 'wxid_peer')])
        self.assertEqual(driver.unique(one, {'identifier': 'id', 'value': 'wxid_peer'}).value, 'wxid_peer')


    def test_peer_identity_outside_active_chat_cannot_authorize_other_editor(self):
        class Node:
            def __init__(self, identifier, value='', children=(), role='AXGroup'):
                self.identifier, self.value, self.children, self.role = identifier, value, children, role
        driver = bridge.MacAXDriver.__new__(bridge.MacAXDriver)
        driver.config = {'expectedSelfId': 'self', 'peers': [{'peerId': 'peer-A', 'privateConfirmed': True, 'identity': {'identifier': 'peer-id', 'value': 'peer-A'}}]}
        driver.attr = lambda node, key: {'AXIdentifier': node.identifier, 'AXValue': node.value, 'AXChildren': node.children, 'AXRole': node.role}.get(key)
        profile_a = Node('profile-panel', children=[Node('peer-id', 'peer-A')])
        actual_chat_b = Node('chat_detail_view', children=[Node('chat_header', children=[Node('peer-id', 'peer-B')]), Node('chat_message_list'), Node('chat_input_text_view'), Node('chat_send_button')])
        root = Node('app', children=[profile_a, actual_chat_b], role='AXApplication')
        with self.assertRaises(bridge.BridgeError) as failure: driver.binding(root, 'peer-A')
        self.assertEqual(failure.exception.code, 'AX_IDENTITY_UNAVAILABLE')
        actual_chat_b.children.append(profile_a)
        with self.assertRaises(bridge.BridgeError) as failure: driver.binding(root, 'peer-A')
        self.assertEqual(failure.exception.code, 'AX_IDENTITY_UNAVAILABLE')

    def test_chat_switch_after_draft_write_never_presses_other_send_button(self):
        class Node:
            def __init__(self, identifier, value='', children=()): self.identifier, self.value, self.children = identifier, value, children
        driver = bridge.MacAXDriver.__new__(bridge.MacAXDriver)
        driver.config = {'peers': [{'peerId': 'peer-A', 'privateConfirmed': True, 'identity': {'identifier': 'peer-id', 'value': 'peer-A'}}]}
        editor_a, button_a = Node('chat_input_text_view'), Node('chat_send_button')
        editor_b, button_b = Node('chat_input_text_view'), Node('chat_send_button')
        def root(peer, editor, button):
            return Node('app', children=[Node('chat_detail_view', children=[Node('chat_header', children=[Node('peer-id', peer)]), Node('chat_message_list'), editor, button])])
        roots = iter([root('peer-A', editor_a, button_a), root('peer-B', editor_b, button_b)])
        driver.root = lambda: next(roots)
        driver.attr = lambda node, key: {'AXIdentifier': node.identifier, 'AXValue': node.value, 'AXChildren': node.children}.get(key)
        driver.messages = lambda chat: []
        pressed = []
        class AX:
            @staticmethod
            def AXUIElementCopyActionNames(button, _): return 0, ['AXPress']
            @staticmethod
            def AXUIElementSetAttributeValue(editor, _, text): editor.value = text; return 0
            @staticmethod
            def AXUIElementPerformAction(button, _): pressed.append(button); return 0
        driver.AX = AX
        with self.assertRaises(bridge.BridgeError):
            driver.send({'peerId': 'peer-A', 'text': 'owner secret'}, threading.Event())
        self.assertEqual(pressed, [])

    def test_stop_fences_a_delayed_pre_stop_request_and_requires_explicit_fresh_grant(self):
        class Driver:
            def __init__(self): self.sent = []
            def send(self, command, cancelled): self.sent.append(command['text']); return 'client_observed'
            def health(self): return {'status': 'connected', 'capabilities': {'receive': True, 'reply': True}}
        with tempfile.TemporaryDirectory() as temp:
            journal = bridge.Journal(Path(temp) / 'journal.sqlite3')
            driver = Driver(); instance = bridge.Bridge({'expectedSelfId': 'self'}, journal, driver)
            # Capture admission as the HTTP handler must, before reading a delayed body.
            generation = instance.grant(instance.admission())['executionGeneration']
            admission = instance.admission()
            command = {'commandId': 'old', 'expectedSelfId': 'self', 'peerId': 'peer', 'text': 'never after stop', 'executionGeneration': generation}
            body_ready, release_body = threading.Event(), threading.Event()
            observed = []
            def delayed_http_handler():
                body_ready.set()
                release_body.wait(2)  # Simulates a POST handler delayed during body read.
                try: instance.send(command, admission_generation=admission)
                except bridge.BridgeError as error: observed.append(error.code)
            thread = threading.Thread(target=delayed_http_handler)
            thread.start(); self.assertTrue(body_ready.wait(2))
            self.assertTrue(instance.stop()['executorQuiescent'])
            release_body.set(); thread.join(2)
            self.assertEqual(observed, ['STALE_GENERATION'])
            fresh = instance.grant(instance.admission())['executionGeneration']
            with self.assertRaises(bridge.BridgeError): instance.send(command, admission_generation=admission)
            new_command = {**command, 'commandId': 'new', 'text': 'new authorized task', 'executionGeneration': fresh}
            self.assertEqual(instance.send(new_command, admission_generation=instance.admission())['status'], 'client_observed')
            self.assertEqual(driver.sent, ['new authorized task'])
            journal.close()

if __name__ == '__main__': unittest.main()
