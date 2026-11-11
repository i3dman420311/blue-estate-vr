"""Live stereo settings for Blue Estate VR."""

import json
from pathlib import Path
from tempfile import NamedTemporaryFile


SETTINGS = Path(__file__).resolve().parent / ".build" / "stereo-calibration.json"
SLIDERS = (
    ("Stereo depth", 0, 100, 1, 35),
    ("Horizontal alignment", -20, 20, 0.1, 0),
    ("Vertical alignment", -3, 3, 0.1, 0),
)
DEFAULTS = tuple(slider[4] for slider in SLIDERS)


def read_calibration():
    try:
        values = json.loads(SETTINGS.read_text(encoding="utf-8"))
        if isinstance(values, list) and len(values) == len(SLIDERS) and all(
            type(value) in (int, float) and limits[1] <= value <= limits[2]
            for value, limits in zip(values, SLIDERS)
        ):
            return tuple(values)
    except (OSError, ValueError):
        pass
    return DEFAULTS


def save_calibration(values):
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=SETTINGS.parent, mode="w", encoding="utf-8", delete=False) as temp:
        json.dump(values, temp)
    staged = Path(temp.name)
    try:
        staged.replace(SETTINGS)
    finally:
        staged.unlink(missing_ok=True)


def main():
    import tkinter as tk
    from tkinter import ttk

    window = tk.Tk()
    window.title("Blue Estate VR Calibration")
    window.attributes("-topmost", True)
    panel = ttk.Frame(window, padding=16)
    panel.pack(fill="both", expand=True)
    ttk.Label(panel, text="Switch to immersive VR in a level. Changes apply live.").pack(anchor="w")
    ttk.Label(panel, text="Start with stereo depth. Use alignment if the images still separate.").pack(anchor="w")
    values = [tk.DoubleVar(value=value) for value in read_calibration()]
    status = tk.StringVar()
    pending = None
    refreshing = False

    def save():
        nonlocal pending
        pending = None
        try:
            save_calibration([value.get() for value in values])
            status.set("Settings saved")
        except OSError as error:
            status.set(f"Could not save settings ({error.strerror})")

    def changed(*_):
        nonlocal pending
        if refreshing:
            return
        if pending is not None:
            window.after_cancel(pending)
        pending = window.after(80, save)

    for (label, low, high, step, _), value in zip(SLIDERS, values):
        tk.Scale(panel, label=f"{label} (%)", from_=low, to=high, resolution=step, variable=value,
                 orient="horizontal", length=350, highlightthickness=0).pack(fill="x", pady=(6, 0))
        value.trace_add("write", changed)

    def reset():
        for value, default in zip(values, DEFAULTS):
            value.set(default)

    def refresh():
        nonlocal refreshing
        if pending is None:
            refreshing = True
            for slider, saved in zip(values, read_calibration()):
                if slider.get() != saved:
                    slider.set(saved)
            refreshing = False
        window.after(350, refresh)

    def copy_values():
        depth, horizontal, vertical = (value.get() for value in values)
        window.clipboard_clear()
        window.clipboard_append(f"Stereo depth {depth:.0f}%, horizontal {horizontal:+.1f}%, vertical {vertical:+.1f}%")
        status.set("Values copied")

    def close():
        if pending is not None:
            window.after_cancel(pending)
            save()
        window.destroy()

    buttons = ttk.Frame(panel)
    buttons.pack(fill="x", pady=(10, 0))
    ttk.Button(buttons, text="Reset defaults", command=reset).pack(side="left")
    ttk.Button(buttons, text="Copy values", command=copy_values).pack(side="left", padx=8)
    ttk.Label(panel, textvariable=status).pack(anchor="w", pady=(6, 0))
    window.protocol("WM_DELETE_WINDOW", close)
    window.after(350, refresh)
    window.mainloop()


if __name__ == "__main__":
    main()
