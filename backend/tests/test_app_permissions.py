import pytest

from app.services.app_permissions import AppPermissions, DesktopPermissionError

EDITOR = {'bundleId': 'com.apple.TextEdit'}
BROWSER = {'bundleId': 'com.apple.Safari'}


def test_consent_enables_applications_without_individual_requests(tmp_path):
    path = tmp_path / 'desktop-access.json'
    policy = AppPermissions(path)
    assert policy.status() == {'granted': None, 'blocked': []}
    with pytest.raises(DesktopPermissionError, match='has not been granted'):
        policy.before_action(EDITOR)
    policy.consent(False)
    assert AppPermissions(path).status()['granted'] is False
    policy.consent(True)
    assert policy.before_action(EDITOR) == policy.before_action(BROWSER)
    assert AppPermissions(path).before_action(BROWSER)[1] == []


def test_blocklist_is_app_scoped_and_invalidates_old_access(tmp_path):
    policy = AppPermissions(tmp_path/'desktop-access.json')
    policy.consent(True)
    version, _ = policy.before_action(EDITOR)
    assert policy.block('COM.APPLE.TEXTEDIT', 'TextEdit', True)
    assert not policy.block('com.apple.textedit', 'TextEdit', True)
    assert policy.before_action(BROWSER)[1] == ['com.apple.textedit']
    with pytest.raises(DesktopPermissionError, match='blocklist'):
        policy.before_action(EDITOR)
    with pytest.raises(DesktopPermissionError, match='changed'):
        policy.before_action(BROWSER, version)
    policy.block('com.apple.textedit', '', False)
    assert policy.before_action(EDITOR)[1] == []


def test_revoked_global_access_rejects_old_capture_and_new_bindings(tmp_path):
    policy = AppPermissions(tmp_path/'desktop-access.json')
    policy.consent(True)
    version, _ = policy.before_action()
    policy.consent(False)
    for target in (None, EDITOR, BROWSER):
        with pytest.raises(DesktopPermissionError):
            policy.before_action(target, version)


def test_legacy_list_is_not_promoted_to_broad_consent(tmp_path):
    (tmp_path/'app-permissions.json').write_text('{"old-app":{"capabilities":["observe","interact"]}}')
    assert AppPermissions(tmp_path/'desktop-access.json').status()['granted'] is None
