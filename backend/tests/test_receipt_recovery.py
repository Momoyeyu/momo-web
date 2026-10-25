import json
import pytest
from app.core import db
from app.core.plugin_host import HostError
from app.services.coordinator import Coordinator


@pytest.mark.parametrize("status", ["completed", "delivered"])
def test_lost_response_cannot_downgrade_a_confirmed_receipt(status):
    core = Coordinator()
    core.schema()

    class Host:
        def permit(self, run_id):
            return {"commandId": "known", "activityEpoch": 0}

        def request(self, *args, **kwargs):
            core.record_receipt(
                {"commandId": "known", "runId": "run", "status": status}
            )
            raise HostError("response timed out after receipt")

    core.host = Host()
    with pytest.raises(HostError):
        core.command("plugins.callTool", {"name": "test"}, "run")
    row = db.query("SELECT status,receipt FROM outbox WHERE command_id='known'")[0]
    assert row["status"] == status
    assert json.loads(row["receipt"])["status"] == status


def test_late_receipt_missing_from_restored_snapshot_is_retained_without_replay():
    core = Coordinator()
    core.schema()
    core.mode = "paused"
    core.epoch = 9
    core.record_receipt(
        {
            "commandId": "after-backup",
            "runId": "original-run",
            "activityEpoch": 2,
            "status": "delivered",
            "stale": True,
        }
    )
    row = db.query("SELECT * FROM outbox WHERE command_id='after-backup'")[0]
    assert (
        row["status"] == "delivered"
        and row["run_id"] == "original-run"
        and row["epoch"] == 2
    )
    assert core.active is None and core.queue == [] and core.mode == "paused"
    assert db.query("SELECT COUNT(*) n FROM inbox")[0]["n"] == 0
