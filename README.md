# Blue Estate VR

An unofficial PC VR mod for the Steam version of Blue Estate. It adds stereoscopic rendering, headset tracking, and right Touch controller aiming and shooting over Meta Quest Link or Air Link. Blue Estate remains an on-rails game.

[Watch the one-minute Quest gameplay video on YouTube](https://youtu.be/Eo-qNmeCUX0)

## Requirements

- Windows and a local Steam installation of Blue Estate with the 64-bit DirectX 9 executable from Steam build 637056.
- A Meta Quest headset connected through the Meta Quest Link PC app.
- 64-bit Python 3 with pip and Visual Studio C++ Build Tools with the Windows SDK.

This repository contains the mod source and build scripts. You need your own copy of Blue Estate.

## Build and play

1. Download or clone this repository.
2. Open PowerShell in the mod folder and run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\build-vr.ps1
   ```

   The build downloads the pinned OpenXR loader and Frida dependency and builds the Quest bridge into `.build`.
3. Open Quest Link or Air Link in the headset, then run **Play Blue Estate VR.cmd**. If the launcher cannot find the game, set `BLUE_ESTATE_GAME_DIR` to your Blue Estate installation folder and start the launcher in the same PowerShell session:

   ```powershell
   $env:BLUE_ESTATE_GAME_DIR = 'D:\SteamLibrary\steamapps\common\Blue Estate'
   & '.\Play Blue Estate VR.cmd'
   ```

## Controls

| Input | Action |
| --- | --- |
| Right Touch | Aim or point at menus |
| Right trigger | Fire or select |
| A | Select on menus |
| X | Recenter |
| Left stick click or F8 | Switch between the comfort screen and immersive stereo during a level |
| Right stick click | Open or close stereo calibration in immersive mode |

Levels start on the comfort screen. The mod makes all seven Arcade stages selectable while it runs. Immersive stereo skips the rectangular overlays during low health and fast scene transitions while keeping the damage flash and camera movement.

Run **VR Calibration Map.cmd** to adjust stereo in a frozen Arcade stage. In the calibration panel, A and B adjust depth and the left stick adjusts horizontal and vertical alignment. Settings are saved locally and used in regular levels.

## Compatibility

The launcher checks the executable before loading the mod. Other game builds and PC VR runtimes are untested. Close Blue Estate before launching the mod or opening the calibration stage.
