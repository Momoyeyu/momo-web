import copy
import pytest
from app.services import plugins


@pytest.fixture
def bundle(tmp_path, monkeypatch):
    monkeypatch.setattr(plugins.state, 'DATA_DIR', tmp_path)
    return {'manifest': {'schemaVersion': 1, 'id': 'example', 'version': '1.0.0', 'name': 'Example', 'description': 'Test plugin', 'entry': 'main.mjs', 'capabilities': []}, 'files': {'main.mjs': 'throw new Error("must not execute on import")'}}


def test_import_data_only_and_persistence(bundle):
    assert plugins.install(bundle)['enabled'] is False
    assert plugins.listing()[0]['manifest'] == bundle['manifest']
    assert plugins.extensions() == []
    with pytest.raises(ValueError):
        plugins.install(bundle)


@pytest.mark.parametrize('path', ['../bad.mjs', '/bad.mjs', 'a//bad.mjs', 'a/../bad.mjs', 'a\\bad.mjs'])
def test_reject_paths(bundle, path):
    bundle['files'][path] = ''
    with pytest.raises(ValueError):
        plugins.install(bundle)
    assert plugins.listing() == []


def test_enable_disable_remove(bundle, monkeypatch):
    from app.services import extend
    calls = []
    monkeypatch.setattr(extend, 'configure', lambda _: calls.append(plugins.extensions()) or True)
    plugins.install(bundle)
    assert plugins.change('example', True)['runtimeSynced']
    assert calls[-1][0]['args'][0].endswith('/example/main.mjs')
    plugins.change('example', False)
    assert calls[-1] == []
    assert plugins.change('example', remove=True)['removed']
    assert plugins.listing() == []


def test_size_limit(bundle):
    bundle['files']['main.mjs'] = 'x' * (2 * 1024 * 1024)
    with pytest.raises(ValueError):
        plugins.install(bundle)


@pytest.mark.parametrize('remove', [False, True])
@pytest.mark.parametrize('throws', [False, True])
def test_failed_stop_retains_disabled_record_and_files(bundle, monkeypatch, remove, throws):
    from app.services import extend
    plugins.install(bundle)
    monkeypatch.setattr(extend, 'configure', lambda _: True)
    plugins.change('example', True)

    def fail(_):
        if throws:
            raise RuntimeError('private transport detail')
        return False

    monkeypatch.setattr(extend, 'configure', fail)
    with pytest.raises(plugins.PluginRuntimeError, match='stop is unconfirmed'):
        plugins.change('example', False, remove=remove)
    record = plugins.listing()[0]
    assert record['enabled'] is False
    assert record['runtimeSynced'] is False
    assert record['runtimeStatus'] == 'stop-unconfirmed'
    assert record['pendingAction'] == ('remove' if remove else 'disable')
    assert 'private transport detail' not in record['runtimeError']
    assert (plugins._root() / 'example/main.mjs').is_file()
    monkeypatch.setattr(extend, 'configure', lambda _: True)
    result = plugins.change('example', False, remove=remove)
    assert result['runtimeSynced'] is True
    if remove:
        assert plugins.listing() == []
    else:
        assert 'runtimeError' not in plugins.listing()[0]


from test_extend import live_hub


def test_import_through_live_cordis_mcp_lifecycle(bundle, monkeypatch, live_hub):
    from app.services import extend
    facade, runtime, events = live_hub
    monkeypatch.setattr(extend, 'hub', facade)
    bundle['files']['main.mjs'] = '''
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === 'initialize') result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'bundled-fixture', version: '1.0.0' }
  };
  if (request.method === 'tools/list') result = { tools: [
    { name: 'echo', description: 'Bundled echo', inputSchema: { type: 'object' } }
  ] };
  if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'bundle-ok' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});
'''
    plugins.install(bundle)
    assert not facade.open([], set()).decls
    plugins.change('example', True)
    tools = facade.open([], set())
    assert tools.has('plugin_example_echo')
    assert tools.call('plugin_example_echo', {}) == 'bundle-ok'
    plugins.change('example', False)
    assert not facade.open([], set()).decls
    assert 'bundle-ok' != tools.call('plugin_example_echo', {})
    plugins.change('example', remove=True)
    assert plugins.listing() == []


def test_shipped_example_survives_startup_reconstruction(bundle, monkeypatch, live_hub):
    import json
    from pathlib import Path
    from app.services import extend
    from app.core.mcp import McpHub
    facade, runtime, events = live_hub
    monkeypatch.setattr(extend, 'hub', facade)
    example = json.loads((Path(__file__).resolve().parents[2] / 'plugin-host/examples/hello-plugin.json').read_text())
    plugins.install(example)
    plugins.change('hello-plugin', True)
    # Simulate a fresh Python facade loading desired state from disk, as lifespan
    # does. Previously active transport is reconciled using its new fingerprint.
    restarted = McpHub()
    monkeypatch.setattr(extend, 'hub', restarted)
    from app.core import mcp
    monkeypatch.setattr(mcp, 'hub', restarted)
    assert extend.configure([])
    tools = restarted.open([], set())
    assert tools.call('plugin_hello_plugin_greet', {'name': 'Momo'}) == 'Hello, Momo!'
    plugins.change('hello-plugin', False)
    assert not restarted.open([], set()).decls
    plugins.change('hello-plugin', remove=True)
    assert plugins.listing() == []
    restarted.close()


@pytest.mark.parametrize('capabilities', [['unknown.access'], ['files.read', 'files.read'], [1], 'files.read'])
def test_invalid_capability_declarations_rejected(bundle, capabilities):
    bundle['manifest']['capabilities'] = capabilities
    with pytest.raises(ValueError, match='capabilities'):
        plugins.install(bundle)

@pytest.mark.parametrize('rollback_succeeds',[True,False])
def test_failed_enable_withdraws_enabled_desired_catalog(bundle,monkeypatch,rollback_succeeds):
    from app.services import extend
    plugins.install(bundle)
    published=[]
    def configure(_):
        published.append(plugins.extensions())
        return rollback_succeeds if len(published)>1 else False
    monkeypatch.setattr(extend,'configure',configure)
    with pytest.raises(plugins.PluginRuntimeError): plugins.change('example',True)
    assert published[0][0]['enabled'] is True
    assert published[-1] == []
    assert plugins.listing()[0]['enabled'] is False
    assert plugins.listing()[0]['runtimeSynced'] is rollback_succeeds
