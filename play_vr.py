"""Launch Blue Estate in Quest Link VR."""

import argparse
from collections import deque
import ctypes
from ctypes import wintypes
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from stereo_calibration import read_calibration, save_calibration

ROOT = Path(__file__).resolve().parent
BIN = ROOT / ".build" / "bin"
sys.path.insert(0, str(ROOT / ".build" / "python"))


def wait_for_game(game):
    user32 = ctypes.WinDLL("user32")
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if game.poll() is not None:
            raise RuntimeError(f"Blue Estate exited during launch ({game.returncode}).")
        found = []

        @callback_type
        def inspect(window, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
            if pid.value == game.pid:
                title = ctypes.create_unicode_buffer(128)
                user32.GetWindowTextW(window, title, len(title))
                if title.value == "Blue Estate (64-bit, DX9)":
                    found.append(window)
                    return False
            return True

        user32.EnumWindows(inspect, 0)
        if found:
            return
        time.sleep(0.25)
    raise RuntimeError("Timed out waiting for Blue Estate's 64-bit DirectX 9 window.")


def find_runtime():
    program_files = Path(os.environ["ProgramFiles"])
    for folder in ("Oculus", "Meta Horizon"):
        manifest = program_files / folder / "Support" / "oculus-runtime" / "oculus_openxr_64.json"
        if manifest.is_file():
            return manifest
    raise RuntimeError("Install the Meta Quest Link PC app before launching Blue Estate VR.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="check the Meta OpenXR runtime")
    parser.add_argument("--smoke-test", action="store_true", help="test 120 frames with simulated poses")
    parser.add_argument("--calibration-stage", action="store_true", help="open a frozen stage for headset calibration")
    args = parser.parse_args()
    loader, bridge = BIN / "openxr_loader.dll", BIN / "BlueEstateQuest.dll"
    if not args.smoke_test:
        if not loader.is_file() or not bridge.is_file():
            raise RuntimeError("Run build-vr.ps1 before launching Blue Estate VR.")
        os.environ["XR_RUNTIME_JSON"] = str(find_runtime())
        if args.check:
            with os.add_dll_directory(str(BIN)):
                native = ctypes.CDLL(str(bridge))
                native.BevrError.restype = ctypes.c_char_p
                if native.BevrStart(1) != 1:
                    raise RuntimeError(native.BevrError().decode())
            print("Meta OpenXR found the headset.", flush=True)
            return

    try:
        import frida
        from probe_stereo import EXPECTED_HASH, find_game_exe
    except ImportError as error:
        raise RuntimeError("Run build-vr.ps1 to install the launcher dependency.") from error
    game_exe = find_game_exe()
    if hashlib.sha256(game_exe.read_bytes()).hexdigest() != EXPECTED_HASH:
        raise RuntimeError("The installed 64-bit Blue Estate executable does not match Steam build 637056.")
    device = frida.get_local_device()
    if any(process.name.lower() == "begame.exe" for process in device.enumerate_processes()):
        raise RuntimeError("Close the running copy of Blue Estate before starting the VR launcher.")
    if not args.smoke_test and args.calibration_stage:
        print("Calibration opens in stereo. A/B change depth, left stick aligns the eyes, and Menu exits.", flush=True)
    elif not args.smoke_test:
        print("Point and use A or the right trigger to select. X recenters.", flush=True)
        print("Levels start on the comfort screen. Left stick click or F8 switches to immersive stereo and back.", flush=True)
        print("In immersive stereo, right stick click opens calibration. A/B change depth, left stick aligns the eyes.", flush=True)
    map_url = "TAP_UT_Root?Game=BEGame.BEGame_Clarence" if args.calibration_stage else "mainmenu"
    print("Loading the frozen calibration stage." if args.calibration_stage else "Loading the Blue Estate main menu.", flush=True)
    process = subprocess.Popen(
        [str(game_exe), map_url, "-windowed", "-dx9", "-onethread", "-nomovie", "-NoStartupMovies",
         "-NoSplash", "-ResX=1920", "-ResY=1080"],
        cwd=game_exe.parent,
    )
    session = script = None
    first_frame = threading.Event()
    done = threading.Event()
    arcade_ready = threading.Event()
    calibration_ready = threading.Event()
    errors = []
    smoke_frames = 120 if args.smoke_test else 0
    calibration = read_calibration()
    controller_calibration = deque(maxlen=1)

    def save_controller_calibration():
        nonlocal calibration
        try:
            values = controller_calibration.pop()
        except IndexError:
            return
        try:
            save_calibration(values)
            calibration = values
        except OSError as error:
            print(f"Could not save headset calibration ({error.strerror}).", flush=True)

    def report(message, _data):
        if message["type"] == "error":
            errors.append(message.get("stack", message["description"]))
            done.set()
            return
        if message["type"] != "send":
            return
        payload = message["payload"]
        if payload.get("calibrationStage"):
            calibration_ready.set()
            print("Calibration stage frozen. Head tracking and calibration are active.", flush=True)
            return
        if payload.get("exitCalibration"):
            done.set()
            return
        if "calibration" in payload:
            controller_calibration.append(tuple(payload["calibration"]))
            return
        if "arcade" in payload:
            if payload["arcade"]:
                arcade_ready.set()
                print("All seven Arcade stages are unlocked for this run.", flush=True)
            else:
                print(f"Arcade unlock unavailable: {payload['reason']}", flush=True)
            return
        if "mode" in payload:
            print(f"{payload['map']}: {payload['mode']}", flush=True)
            return
        if "input" in payload:
            print(payload["input"], flush=True)
            return
        if "error" in payload:
            errors.append(payload["error"])
            done.set()
            return
        first_frame.set()
        if smoke_frames:
            print(payload, flush=True)
            if payload["stereoSubmitted"] == smoke_frames:
                if args.calibration_stage and not calibration_ready.is_set():
                    errors.append("The calibration stage did not freeze.")
                if not args.calibration_stage and not arcade_ready.is_set():
                    errors.append("The Arcade unlock did not attach at the main menu.")
                if (payload["built"] < smoke_frames or payload["projectionWrites"] != 2 * payload["built"]
                        or payload["poseWrites"] != 2 * payload["built"]):
                    errors.append("A stereo frame or projection was missed.")
                if not payload["stereoMatches"]:
                    errors.append("The game did not use the requested per-eye projection and render history.")
                if payload["rects"][1] or payload["rects"][5]:
                    errors.append("Blue Estate letterboxed the stereo views.")
                if not args.calibration_stage and payload["submitted"] <= smoke_frames:
                    errors.append("The menu screen did not reach Present.")
                if not payload["trackedAim"]:
                    errors.append("The simulated controller pose did not reach the game.")
                done.set()
        else:
            if payload["submitted"] == 1 and payload["screenMode"]:
                print("Blue Estate submitted its first menu screen to Meta OpenXR.", flush=True)
            if payload["stereoSubmitted"] == 1 and not payload["screenMode"]:
                width, height = payload["rects"][2:4]
                print(f"Blue Estate submitted stereo to Meta OpenXR at {width}x{height} per eye.", flush=True)
            if payload["trackedAim"]:
                print("Right Touch controller aim is tracked.", flush=True)

    try:
        wait_for_game(process)
        session = device.attach(process.pid)
        session.on("detached", lambda *_: done.set())
        source = (ROOT / "arcade_unlock.js").read_text(encoding="utf-8")
        source += "\n" + (ROOT / "quest_hooks.js").read_text(encoding="utf-8")
        script = session.create_script(source)
        script.on("message", report)
        script.load()
        try:
            script.exports_sync.configure_stereo(*calibration)
            script.exports_sync.start(str(game_exe), str(loader), str(bridge), smoke_frames, args.calibration_stage)
        except frida.RPCException as error:
            raise RuntimeError(str(error).splitlines()[0]) from error
        print("Waiting for a tracked VR frame..." if not smoke_frames else "Testing the game hooks...", flush=True)
        deadline = time.monotonic() + (45 if smoke_frames else 180)
        while process.poll() is None and not done.wait(0.25):
            save_controller_calibration()
            updated = read_calibration()
            if updated != calibration:
                try:
                    script.exports_sync.configure_stereo(*updated)
                except frida.InvalidOperationError:
                    if session.is_detached:
                        break
                    raise
                calibration = updated
            if time.monotonic() >= deadline and (smoke_frames or not first_frame.is_set()):
                if smoke_frames:
                    raise RuntimeError("Blue Estate did not finish the simulated render test.")
                raise RuntimeError("No headset frame. Keep Quest Link open with the headset awake and retry.")
        if errors:
            raise RuntimeError(errors[0])
        if not first_frame.is_set() or (smoke_frames and process.poll() is not None):
            raise RuntimeError("Blue Estate exited before the render test finished.")
    finally:
        save_controller_calibration()
        if script and session and not session.is_detached:
            try:
                script.exports_sync.stop()
            except (frida.InvalidOperationError, frida.RPCException):
                pass
            finally:
                if not session.is_detached:
                    session.detach()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        sys.exit(str(error))
