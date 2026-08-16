"""Dependency-free, controller-owned pytest JSONL evidence plugin."""

import json
import os
import stat


_MAX_NODEID = 4096
_MAX_PATH = 4096
_MAX_STREAM_CHARS = 8 * 1024 * 1024
_STATE_ATTR = "_bom_orch_event_state"
_ACTIVE_CONFIG = None


def pytest_addoption(parser):
    group = parser.getgroup("bom-orch")
    group.addoption(
        "--bom-orch-events",
        action="store",
        dest="bom_orch_events",
        required=True,
        help="absolute controller-precreated JSONL event file",
    )


def _inside(root, candidate):
    try:
        return os.path.commonpath((root, candidate)) == root and candidate != root
    except (TypeError, ValueError):
        return False


def _bounded_text(value, limit, label, allow_empty=False):
    if not isinstance(value, str) or (not allow_empty and not value) or len(value) > limit or "\x00" in value:
        raise RuntimeError("bom-orch pytest event has invalid " + label)
    return value


def _write(config, event):
    state = getattr(config, _STATE_ATTR, None)
    if not isinstance(state, dict) or state.get("closed") or state.get("file") is None:
        raise RuntimeError("bom-orch pytest event stream is unavailable")
    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    if len(payload) > 16384:
        raise RuntimeError("bom-orch pytest event exceeds its bound")
    state["chars"] += len(payload) + 1
    if state["chars"] > _MAX_STREAM_CHARS:
        state["write_error"] = True
        raise RuntimeError("bom-orch pytest event stream exceeds its bound")
    try:
        state["file"].write(payload + "\n")
    except Exception as error:
        state["write_error"] = True
        raise RuntimeError("bom-orch pytest event write failed") from error


def pytest_configure(config):
    global _ACTIVE_CONFIG
    requested = config.getoption("bom_orch_events")
    if not isinstance(requested, str) or not os.path.isabs(requested):
        raise RuntimeError("--bom-orch-events must be absolute")
    cwd = os.path.realpath(os.getcwd())
    target = os.path.realpath(requested)
    if not _inside(cwd, target):
        raise RuntimeError("--bom-orch-events escapes the evidence worktree")
    before = os.lstat(requested)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise RuntimeError("--bom-orch-events is not a regular controller file")
    flags = os.O_WRONLY | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(requested, flags)
    try:
        after = os.fstat(descriptor)
        if before.st_dev != after.st_dev or before.st_ino != after.st_ino or not stat.S_ISREG(after.st_mode):
            raise RuntimeError("--bom-orch-events identity changed")
        stream = os.fdopen(descriptor, "a", encoding="utf-8", newline="\n")
        descriptor = None
    finally:
        if descriptor is not None:
            os.close(descriptor)
    setattr(config, _STATE_ATTR, {
        "file": stream,
        "closed": False,
        "write_error": False,
        "terminal_error": False,
        "chars": 0,
    })
    _ACTIVE_CONFIG = config


def _location(nodeid, location):
    node = _bounded_text(nodeid, _MAX_NODEID, "nodeid")
    if not isinstance(location, tuple) or len(location) < 2:
        raise RuntimeError("bom-orch pytest event has no source location")
    path = _bounded_text(location[0], _MAX_PATH, "path")
    line = location[1]
    if not isinstance(line, int) or line < 0 or line > 10000000:
        raise RuntimeError("bom-orch pytest event has invalid line")
    return node, path, line + 1


def pytest_collection_finish(session):
    for item in session.items:
        nodeid, path, line = _location(item.nodeid, item.location)
        _write(session.config, {
            "type": "collect",
            "nodeid": nodeid,
            "path": path,
            "line": line,
            "outcome": "collected",
            "when": "collection",
            "wasxfail": False,
        })


def pytest_runtest_logreport(report):
    nodeid, path, line = _location(report.nodeid, report.location)
    when = report.when
    outcome = report.outcome
    if when not in ("setup", "call", "teardown") or outcome not in ("passed", "failed", "skipped"):
        raise RuntimeError("bom-orch pytest event has invalid phase/outcome")
    if _ACTIVE_CONFIG is None:
        raise RuntimeError("bom-orch pytest plugin was not configured")
    _write(_ACTIVE_CONFIG, {
        "type": "test",
        "nodeid": nodeid,
        "path": path,
        "line": line,
        "outcome": outcome,
        "when": when,
        "wasxfail": bool(getattr(report, "wasxfail", False)),
    })


def pytest_sessionfinish(session, exitstatus):
    global _ACTIVE_CONFIG
    state = getattr(session.config, _STATE_ATTR, None)
    if not isinstance(state, dict) or state.get("closed") or state.get("file") is None:
        raise RuntimeError("bom-orch pytest event stream cannot finish")
    stream = state["file"]
    terminal_error = None
    try:
        if state.get("write_error"):
            raise RuntimeError("bom-orch pytest event stream had a prior write failure")
        _write(session.config, {
            "type": "session",
            "nodeid": "",
            "path": "",
            "line": None,
            "outcome": str(int(exitstatus)),
            "when": "session",
            "wasxfail": False,
        })
        stream.flush()
        os.fsync(stream.fileno())
    except Exception as error:
        state["terminal_error"] = True
        session.exitstatus = 3
        terminal_error = RuntimeError("bom-orch pytest terminal write failed")
        terminal_error.__cause__ = error
    finally:
        state["closed"] = True
        state["file"] = None
        try:
            stream.close()
        except Exception as error:
            state["terminal_error"] = True
            session.exitstatus = 3
            if terminal_error is None:
                terminal_error = RuntimeError("bom-orch pytest terminal close failed")
                terminal_error.__cause__ = error
        finally:
            _ACTIVE_CONFIG = None
    if terminal_error is not None:
        raise terminal_error
