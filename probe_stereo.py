"""Blue Estate Win64 Steam build 637056 render probe (requires Frida)."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
import winreg

import frida


EXPECTED_HASH = "de7b4d7e88e457505c89732e9a6e13f2e40aa371401b7c3dc717a290ea7cfcbe"


def find_game_exe():
    executable = Path("Binaries/Win64/BEGame.exe")
    override = os.environ.get("BLUE_ESTATE_GAME_DIR")
    if override:
        candidate = Path(override).expanduser() / executable
        if candidate.is_file():
            return candidate.resolve()
        raise RuntimeError("BLUE_ESTATE_GAME_DIR must point to the Blue Estate installation folder.")

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            steam = Path(winreg.QueryValueEx(key, "SteamPath")[0])
        libraries = [steam]
        manifest = steam / "steamapps" / "libraryfolders.vdf"
        if manifest.is_file():
            contents = manifest.read_text(encoding="utf-8-sig")
            libraries.extend(Path(folder.replace("\\\\", "\\")) for folder in
                             re.findall(r'^\s*"path"\s+"([^"]+)"', contents, re.MULTILINE))
        for library in libraries:
            candidate = library / "steamapps" / "common" / "Blue Estate" / executable
            if candidate.is_file():
                return candidate.resolve()
    except (OSError, UnicodeError):
        pass
    raise RuntimeError("Blue Estate was not found. Set BLUE_ESTATE_GAME_DIR to its installation folder.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pid", type=int, help="PID of the running 64-bit game")
    parser.add_argument("--frames", type=int, default=1, choices=range(1, 121),
                        metavar="1–120", help="number of frames to split")
    args = parser.parse_args()
    try:
        game_exe = find_game_exe()
    except RuntimeError as error:
        parser.error(str(error))
    if hashlib.sha256(game_exe.read_bytes()).hexdigest() != EXPECTED_HASH:
        parser.error("unsupported BEGame.exe build")

    results = []
    session = frida.attach(args.pid)
    try:
        probe = session.create_script(Path(__file__).with_suffix(".js").read_text(encoding="utf-8"))

        def report(message, _data):
            if message["type"] == "send":
                results.append(message["payload"])
            print(json.dumps(message), flush=True)

        probe.on("message", report)
        probe.load()
        probe.exports_sync.run(str(game_exe), args.frames)
        deadline = time.monotonic() + 10 + args.frames / 12
        while time.monotonic() < deadline and not results and not session.is_detached:
            time.sleep(0.05)
        if not session.is_detached:
            probe.unload()
    finally:
        if not session.is_detached:
            session.detach()
    if not results or results[0]["built"] != args.frames:
        raise SystemExit("The game did not build both views for every requested frame.")
    left, right = results[0]["eyes"]
    if left["address"] == right["address"] or not math.isclose(
        math.dist(left["location"], right["location"]), 6.4, abs_tol=0.02
    ):
        raise SystemExit("The returned views did not have separate eye positions.")
    x, y, width, height = left["rect"]
    if width <= 0 or height <= 0 or right["rect"] != [x + width, y, width, height]:
        raise SystemExit("The eye rectangles do not form a side-by-side pair.")
    back_buffer = results[0]["backBuffer"]
    if "error" in back_buffer or results[0]["presentResult"] != 0:
        raise SystemExit("Could not sample a successfully presented frame.")
    left_pixels, right_pixels = back_buffer["samples"]
    if min(len(set(left_pixels)), len(set(right_pixels))) <= 1 or left_pixels == right_pixels:
        raise SystemExit("The rendered eye regions did not both contain distinct image data.")


if __name__ == "__main__":
    main()
