"use strict";

const unit = 32768 / Math.PI;
const degrees = Math.PI / 180;
const panelDepth = 2.3;
const panelWidth = 2.0;
const railSetback = 20; // Unreal units at 100 units per meter.
const viewmodelScale = 1.7;
const defaultStereoCalibration = [35, 0, 0];
const horizontalAlignmentLimit = 20;
let stereoCalibration = defaultStereoCalibration;
const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const scale = (a, s) => a.map(v => v * s);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]
];
const normalize = a => scale(a, 1 / Math.hypot(...a));

function rotate(quaternion, vector) {
    const q = quaternion.slice(0, 3);
    const t = scale(cross(q, vector), 2);
    return add(vector, add(scale(t, quaternion[3]), cross(q, t)));
}

function xrToUnreal([x, y, z]) {
    return [-z, x, y];
}

function railBasis([pitch, yaw, roll]) {
    const [p, y, r] = [pitch, yaw, roll].map(a => a / unit);
    const cp = Math.cos(p), sp = Math.sin(p);
    const cy = Math.cos(y), sy = Math.sin(y);
    const cr = Math.cos(r), sr = Math.sin(r);
    return [
        [cp * cy, cp * sy, sp],
        [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
        [-cr * sp * cy - sr * sy, -cr * sp * sy + sr * cy, cr * cp]
    ];
}

function railTransform(basis, v) {
    return basis[0].map((_, i) => v.reduce((sum, value, axis) => sum + value * basis[axis][i], 0));
}

function rotator([x, y, z], right = [0, 0, 0], up = [0, 0, 1]) {
    return [Math.atan2(z, Math.hypot(x, y)), Math.atan2(y, x), Math.atan2(-right[2], up[2])]
        .map(r => Math.round(r * unit));
}

function projectionTerms(fov) {
    const [left, right, up, down] = fov.map(Math.tan);
    return [2 / (right - left), 2 / (up - down), -(right + left) / (right - left),
        -(up + down) / (up - down)];
}

function aimPoint(position, orientation) {
    // shortcut: converge at 10 m while the game owns the muzzle and trace, use a native raycast for close-range convergence.
    return add(position, scale(rotate(orientation, [0, 0, -1]), 10));
}

function projectAim(point, eye, width, height) {
    const [x, y, z] = eye.orientation;
    const [right, up, back] = rotate([-x, -y, -z, eye.orientation[3]], sub(point, eye.position));
    if (back >= -0.01) return [-1, -1];
    const [sx, sy, ox, oy] = eye.projection || projectionTerms(eye.fov);
    return [(1 + sx * right / -back + ox) * width / 2,
        (1 - sy * up / -back - oy) * height / 2];
}

function renderEye(eye, midpoint, index) {
    const [depth, horizontal, vertical] = stereoCalibration;
    const direction = index === 0 ? 1 : -1;
    const projection = projectionTerms(eye.fov);
    projection[2] += direction * horizontal / 100;
    projection[3] += direction * vertical / 100;
    return { ...eye, projection, position: add(midpoint, scale(sub(eye.position, midpoint), depth / 100)) };
}

function hudTransform(eye, center, orientation, [x, y, width, height]) {
    const screen = corner => projectAim(add(center, rotate(orientation, corner)), eye, width, height);
    const halfWidth = 1.65, halfHeight = halfWidth * 9 / 16;
    const origin = screen([-halfWidth, halfHeight, -panelDepth]);
    const dx = scale(sub(screen([halfWidth, halfHeight, -panelDepth]), origin), 1 / width);
    const dy = scale(sub(screen([-halfWidth, -halfHeight, -panelDepth]), origin), 1 / height);
    return { dx, dy, origin, matrix: [...dx, 0, 0, ...dy, 0, 0, 0, 0, 1, 0, x + origin[0], y + origin[1], 0, 1] };
}

function hudPoint(point, { dx, dy, origin }, width, height) {
    const [x, y] = sub(point, origin);
    const det = dx[0] * dy[1] - dx[1] * dy[0];
    if (Math.abs(det) < 0.01) return null;
    return [1280 * (dy[1] * x - dy[0] * y) / (width * det),
        720 * (dx[0] * y - dx[1] * x) / (height * det)];
}

function screenPointer(hand, eyes, width, height) {
    if (width <= 0 || height <= 0) return null;
    const center = scale(add(eyes[0].position, eyes[1].position), 0.5);
    const [x, y, z, w] = eyes[0].orientation;
    const inverse = [-x, -y, -z, w];
    const origin = rotate(inverse, sub(hand.position, center));
    const direction = rotate(inverse, rotate(hand.orientation, [0, 0, -1]));
    if (direction[2] >= -0.001) return null;
    const distance = (-panelDepth - origin[2]) / direction[2];
    if (distance <= 0) return null;
    const hit = add(origin, scale(direction, distance));
    const u = 0.5 + hit[0] / panelWidth;
    const v = 0.5 - hit[1] / (panelWidth * height / width);
    if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
    return [Math.floor(u * width), Math.floor(v * height)];
}

function nativeAimAxes(right, up, forward, horizontalScale, verticalScale) {
    const depth = Math.max(1, forward);
    const clamp = value => Math.min(1, Math.max(-1, value));
    return [clamp(horizontalScale * right / depth), clamp(-verticalScale * up / depth)];
}

function cursorPixels(axes, width, height) {
    return [Math.min(width - 1, (axes[0] + 1) * width / 2),
        Math.min(height - 1, (axes[1] + 1) * height / 2)];
}

function mouseDelta(cursor, previous) {
    return previous ? sub(cursor, previous).map(Math.round) : [0, 0];
}

function selfCheck() {
    const same = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) < 1e-5);
    const yaw = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];
    const forward = xrToUnreal(rotate(yaw, [0, 0, -1]));
    const terms = projectionTerms([-30 * degrees, 45 * degrees, 45 * degrees, -30 * degrees]);
    const centered = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
    if (!same(forward, [0, 1, 0]) || !same(rotator(forward), [0, 16384, 0]) ||
        !same(railTransform(railBasis([0, 16384, 0]), [1, 0, 0]), [0, 1, 0]) ||
        !same([terms[0] * Math.tan(-30 * degrees) + terms[2], terms[0] + terms[2]], [-1, 1]) ||
        !same(aimPoint([0.2, 0, 0], [0, 0, 0, 1]), [0.2, 0, -10]) ||
        !same(projectAim([0, 0, -10], { ...centered,
            fov: [-45, 45, 45, -45].map(angle => angle * degrees) }, 200, 100), [100, 50]) ||
        !same(screenPointer(centered, [centered, centered], 200, 100), [100, 50]) ||
        !same(nativeAimAxes(10, 10, 100, 1, 16 / 9), [0.1, -0.1 * 16 / 9]) ||
        !same(nativeAimAxes(10, -10, 100, 1, 16 / 9), [0.1, 0.1 * 16 / 9]) ||
        !same(mouseDelta(cursorPixels([0.5, -0.5], 1280, 720), [640, 360]), [320, -180]) ||
        !same(mouseDelta([500, 500], null), [0, 0])) {
        throw new Error("Blue Estate VR coordinate checks failed");
    }
}

if (typeof rpc === "undefined") {
    selfCheck();
} else {
    const game = Process.mainModule;
    let stop = () => {};
    let arcadeUnlock;
    rpc.exports = {
        configureStereo(depth, horizontal, vertical) {
            const values = [depth, horizontal, vertical];
            if (!values.every(Number.isFinite) || depth < 0 || depth > 100 ||
                Math.abs(horizontal) > horizontalAlignmentLimit || Math.abs(vertical) > 3) {
                throw new Error("Invalid stereo calibration");
            }
            stereoCalibration = values;
        },
        start(path, loader, bridge, smokeFrames, calibrationStage) {
            selfCheck();
            if (Process.arch !== "x64" || game.path.toLowerCase() !== path.toLowerCase()) {
                throw new Error("Select the verified Blue Estate Win64 executable.");
            }
            const address = rva => game.base.add(rva);
            const frame = Memory.alloc(144);
            const rects = Memory.alloc(48);
            const calibrationPanel = Memory.alloc(12);
            let calibrating = !!calibrationStage;
            let calibrationToggleWasDown = false;
            let nextCalibrationStep = 0;
            const scratch = Memory.alloc(Process.pageSize);
            const vec = (p, n, read = "readFloat") => Array.from({ length: n }, (_, i) => p.add(i * 4)[read]());
            const write = (p, values, method = "writeFloat") =>
                values.forEach((value, index) => p.add(index * 4)[method](value));
            const pose = p => ({ orientation: vec(p, 4), position: vec(p.add(16), 3) });
            const user32 = Process.getModuleByName("user32.dll");
            const user = (name, result, params) => new NativeFunction(user32.getExportByName(name), result, params);
            const window = user("FindWindowW", "pointer", ["pointer", "pointer"])(
                NULL, Memory.allocUtf16String("Blue Estate (64-bit, DX9)"));
            const owner = Memory.alloc(4);
            user("GetWindowThreadProcessId", "uint", ["pointer", "pointer"])(window, owner);
            if (window.isNull() || owner.readU32() !== Process.id) throw new Error("Blue Estate window not found.");
            const post = user("PostMessageW", "int", ["pointer", "uint", "uint64", "uint64"]);
            const getRect = user("GetClientRect", "int", ["pointer", "pointer"]);
            const clientToScreen = user("ClientToScreen", "int", ["pointer", "pointer"]);
            const keyState = user("GetAsyncKeyState", "int16", ["int"]);
            const foreground = user("GetForegroundWindow", "pointer", []);
            const sendInput = user("SendInput", "uint", ["uint", "pointer", "int"]);
            const movement = Memory.alloc(40);
            movement.add(20).writeU32(0x2001); // Relative move without coalescing consecutive samples.
            const client = Memory.alloc(16);
            let menuCursor = null;
            let lastMousePoint = null;
            let mouseButtons = 0;
            let previousButtons = 0;
            let gesture = 0;
            let reportedControls = false;
            const worldNames = address(0x11bc910);
            const worldSlot = address(0x124f058);
            let previousWorld = NULL;
            let hiddenMenuWorld = NULL;
            let nextMenuCharacterScan = 0;
            let map = "";
            const setActorHidden = new NativeFunction(address(0x2918c0), "void", ["pointer", "int"]);

            function currentMap() {
                const world = worldSlot.readPointer();
                if (world.isNull()) return "";
                if (world.equals(previousWorld)) return map;
                let outer = world.add(0x40).readPointer();
                if (outer.isNull()) return "";
                for (let depth = 0; depth < 8; depth++) {
                    const parent = outer.add(0x40).readPointer();
                    if (parent.isNull()) {
                        const index = outer.add(0x48).readU32();
                        if (index >= worldNames.add(8).readU32()) return "";
                        const entry = worldNames.readPointer().add(index * 8).readPointer();
                        if (entry.isNull()) return "";
                        previousWorld = world;
                        map = entry.add(20).readCString();
                        return map;
                    }
                    outer = parent;
                }
                return "";
            }

            function hideMenuCharacter() {
                const world = worldSlot.readPointer();
                if (world.isNull() || world.equals(hiddenMenuWorld) || Date.now() < nextMenuCharacterScan) return;
                nextMenuCharacterScan = Date.now() + 500;
                const objects = address(0x123ee48);
                const data = objects.readPointer(), count = objects.add(8).readU32();
                const names = worldNames.readPointer();
                const objectName = object => {
                    if (object.isNull()) return "";
                    const entry = names.add(object.add(0x48).readU32() * 8).readPointer();
                    return entry.isNull() || (entry.add(8).readU32() & 1) ? "" : entry.add(20).readCString();
                };
                for (let i = 0; !data.isNull() && i < count; i++) {
                    const actor = data.add(i * 8).readPointer();
                    if (actor.isNull() || objectName(actor) !== "SkeletalMeshActorMAT" ||
                        objectName(actor.add(0x50).readPointer()) !== "SkeletalMeshActorMAT") continue;
                    let outer = actor;
                    for (let depth = 0; depth < 3 && !outer.isNull(); depth++) outer = outer.add(0x40).readPointer();
                    if (objectName(outer) !== "MainMenu_Cherry") continue;
                    setActorHidden(actor, 1);
                    hiddenMenuWorld = world;
                    return;
                }
            }

            function worldInfo() {
                const world = worldSlot.readPointer();
                if (world.isNull()) return NULL;
                const level = world.add(0x80).readPointer();
                if (level.isNull()) return NULL;
                const actors = level.add(0x60).readPointer();
                if (actors.isNull()) return NULL;
                const info = actors.readPointer();
                return !info.isNull() && info.readPointer().add(0x888).readPointer().equals(address(0xa3d8d0)) ? info : NULL;
            }

            function tutorialFrozen() {
                const info = worldInfo();
                return !info.isNull() && (info.add(0xb7c).readU32() & 0x800000) !== 0;
            }

            let stageTimerStart = 0;
            let stageFrozen = false;
            function freezeCalibrationStage(player) {
                const info = worldInfo();
                if (info.isNull()) return false;
                if (stageFrozen) return !info.add(0x530).readPointer().isNull();
                const timer = info.add(0x10e0).readFloat();
                stageTimerStart = Math.max(stageTimerStart, timer);
                // Wait for the Arcade countdown to clear, then pause the world without opening its pause menu.
                if (timer <= 0 || stageTimerStart - timer < 0.15) return false;
                const controller = player.add(0x68).readPointer();
                if (controller.isNull()) return false;
                const replication = controller.add(0x248).readPointer();
                if (replication.isNull()) return false;
                info.add(0x528).writeFloat(0);
                info.add(0x530).writePointer(replication);
                stageFrozen = true;
                send({ calibrationStage: true });
                return true;
            }

            function blockingMenu() {
                const engine = address(0x124a2b8).readPointer();
                if (engine.isNull()) return false;
                const viewport = engine.add(0x6dc).readPointer();
                if (viewport.isNull()) return false;
                const interaction = viewport.add(0x98).readPointer();
                if (interaction.isNull()) return false;
                const client = interaction.add(0xe0).readPointer();
                if (client.isNull()) return false;
                const scenes = client.add(0x19c);
                const data = scenes.readPointer(), count = scenes.add(8).readU32();
                for (let i = 0; !data.isNull() && i < count; i++) {
                    const scene = data.add(i * 8).readPointer();
                    if (!scene.isNull() && (scene.add(0x70).readU32() & 0x400)) return true;
                }
                return false;
            }

            function moveMouse(point) {
                if (!point || !foreground().equals(window)) {
                    lastMousePoint = null;
                    return;
                }
                const [dx, dy] = mouseDelta(point, lastMousePoint);
                if (!lastMousePoint) lastMousePoint = point;
                if (!dx && !dy) return;
                write(movement.add(8), [dx, dy], "writeS32");
                if (sendInput(1, movement, 40) === 1) lastMousePoint = add(lastMousePoint, [dx, dy]);
            }

            function key(code, down) {
                post(window, down ? 0x100 : 0x101, code, down ? 1 : 0xc0000001);
            }

            function mouse(buttons, cursor) {
                const [x, y] = cursor || [0, 0];
                const location = ((y & 0xffff) << 16) + (x & 0xffff);
                for (const [bit, down] of [[1, 0x201], [2, 0x204], [16, 0x207]]) {
                    if ((buttons ^ mouseButtons) & bit) {
                        post(window, buttons & bit ? down : down + 1, buttons, location >>> 0);
                    }
                }
                mouseButtons = buttons;
            }

            function controls(data, screen, cursor, validAim, gameplay) {
                const rawButtons = data.add(124).readU16();
                const buttons = calibrating ? rawButtons & ~0x3000 : rawButtons;
                const fire = data.add(127).readU8() >= (mouseButtons & 1 ? 102 : 153);
                const reload = gameplay && data.add(126).readU8() >= 128;
                const trigger = validAim && (fire || (screen && (buttons & 0x1000)));
                const weapon = gameplay && (buttons & 0x8000);
                if (trigger && !(mouseButtons & 1) && !reportedControls) {
                    reportedControls = true;
                    send({ input: screen ? "Touch clicked the menu" : "Touch trigger sent Fire" });
                }
                if (screen && cursor) {
                    const [x, y] = cursor;
                    post(window, 0x200, mouseButtons, ((y << 16) + x) >>> 0);
                }
                mouse((trigger ? 1 : 0) | (reload ? 2 : 0) | (weapon ? 16 : 0), cursor);
                if ((buttons ^ previousButtons) & 0x2010) key(0x1b, !!(buttons & 0x2010));
                previousButtons = buttons;
                const x = calibrating ? 0 : data.add(128).readS16(), y = calibrating ? 0 : data.add(130).readS16();
                const next = Math.abs(x) > Math.abs(y) && Math.abs(x) > 18000 ? (x < 0 ? 0x25 : 0x27)
                    : Math.abs(y) > 18000 ? (y > 0 ? 0x26 : 0x28) : 0;
                if (next !== gesture) {
                    if (gesture) key(gesture, false);
                    if (next) key(next, true);
                    gesture = next;
                }
            }

            function updateCalibrationControls(data, screen) {
                const pressed = data.add(140).readU32() !== 0;
                if (screen) calibrating = false;
                else if (pressed && !calibrationToggleWasDown) {
                    calibrating = !calibrating;
                    nextCalibrationStep = 0;
                }
                calibrationToggleWasDown = pressed;
                if (!calibrating || Date.now() < nextCalibrationStep) return;
                const buttons = data.add(124).readU16();
                const x = data.add(128).readS16(), y = data.add(130).readS16();
                const [depth, horizontal, vertical] = stereoCalibration;
                const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
                const next = (buttons & 0x3000) === 0x3000 ? defaultStereoCalibration : [
                    clamp(depth + ((buttons & 0x1000 ? 2 : 0) - (buttons & 0x2000 ? 2 : 0)), 0, 100),
                    clamp(Math.round(horizontal * 10 + (Math.abs(x) > 18000 ? 2 * Math.sign(x) : 0)) / 10,
                        -horizontalAlignmentLimit, horizontalAlignmentLimit),
                    clamp(Math.round(vertical * 10 + (Math.abs(y) > 18000 ? 2 * Math.sign(y) : 0)) / 10, -3, 3)
                ];
                if (next.every((value, i) => value === stereoCalibration[i])) return;
                stereoCalibration = next;
                nextCalibrationStep = Date.now() + 130;
                send({ calibration: next });
            }

            function releaseControls() {
                mouse(0, menuCursor);
                if (previousButtons & 0x2010) key(0x1b, false);
                if (gesture) key(gesture, false);
                previousButtons = 0;
                gesture = 0;
                menuCursor = null;
                lastMousePoint = null;
            }

            let error = () => "desktop test failed";
            let syntheticFrames = 0;
            let begin = () => {
                write(frame, [0, 0, 0, 1, -0.032, 0, 0, -0.8, 0.8, 0.8, -0.7]);
                write(frame.add(44), [0, 0, 0, 1, 0.032, 0, 0, -0.8, 0.8, 0.8, -0.7]);
                write(frame.add(88), [0, 0, 0, 1, 0.2, -0.2, -0.3]);
                frame.add(116).writeU32(1);
                frame.add(120).writeU32(0);
                frame.add(136).writeU32(0);
                frame.add(140).writeU32(0);
                syntheticFrames++;
                return 1;
            };
            let submit = () => 1;
            if (!smokeFrames) {
                Module.load(loader);
                const native = Module.load(bridge);
                // Meta's runtime handles its own first-chance Windows exceptions.
                const fn = (name, result, args) => new NativeFunction(
                    native.getExportByName(name), result, args, { exceptions: "propagate" });
                error = () => fn("BevrError", "pointer", [])().readUtf8String();
                if (fn("BevrStart", "int", ["int"])(0) !== 1) throw new Error(error());
                begin = fn("BevrBegin", "int", ["pointer"]);
                const nativeSubmit = fn("BevrSubmit", "int", ["pointer", "pointer", "int", "pointer"]);
                submit = (device, rects, screen) => {
                    if (calibrating) write(calibrationPanel, stereoCalibration);
                    return nativeSubmit(device, rects, screen, calibrating ? calibrationPanel : NULL);
                };
                const close = fn("BevrStop", "void", []);
                stop = () => { releaseControls(); close(); };
            }

            const scene = address(0x53fb20);
            const sceneArgs = Array(6).fill("pointer");
            const calcView = new NativeFunction(scene, "pointer", sceneArgs);
            const allocateViewState = new NativeFunction(address(0x764bb0), "pointer", []);
            let rightState = NULL;
            const gameThread = { id: null };
            let available = true;
            let pending = false;
            let screenMode = true;
            let screenOverride = !smokeFrames && !calibrationStage;
            let screenToggleWasDown = false;
            let lastMap = null;
            let built = 0;
            let submitted = 0;
            let stereoSubmitted = 0;
            let eye = null;
            let recenterWasDown = false;
            let center, centerRotation, originalLocation, originalRotation, railOrigin, stereoCenter, viewerOrigin;
            let aim = null;
            let localController = NULL;
            let playerInput = NULL;
            let crosshair = null;
            let failedFrames = 0;
            let projectionWrites = 0;
            let poseWrites = 0;
            let lastRect;
            let reticlePixels = null, hudTransforms = null, stereoViews = null, hudEye = 0;
            let stockReticleEyes = 0;
            let stereoMatches = true;
            let hasAim = false;
            let reportedAim = false;
            let presentHook;
            const disable = message => {
                if (!available) return;
                available = false;
                pending = false;
                releaseControls();
                aim = null;
                crosshair = null;
                send({ error: message });
            };

            const deviceHook = Interceptor.attach(address(0x959a80), {
                onEnter(args) {
                    const device = args[0].add(0x34).readPointer();
                    if (device.isNull()) return;
                    const present = device.readPointer().add(17 * Process.pointerSize).readPointer();
                    presentHook = Interceptor.attach(present, {
                        onEnter(args) {
                            if (!pending || !this.returnAddress.equals(address(0x959cf5))) return;
                            pending = false;
                            if (this.threadId !== gameThread.id) {
                                submit(NULL, NULL, 0);
                                disable("Blue Estate did not use its single-threaded DirectX 9 renderer.");
                                return;
                            }
                            if (drewRightHud && (stockReticleEyes & 1)) stockReticleEyes |= 2;
                            for (let index = 0; !screenMode && index < 2; index++) {
                                if (stockReticleEyes & (1 << index)) write(rects.add(32 + 8 * index), [-1, -1], "writeS32");
                            }
                            const status = submit(args[0], rects, screenMode ? 1 : 0);
                            if (status < 0) return disable(error());
                            if (status === 0) {
                                if (++failedFrames >= 30) disable("The VR bridge could not copy the game back buffer.");
                                return;
                            }
                            failedFrames = 0;
                            submitted++;
                            if (!screenMode) stereoSubmitted++;
                            if (submitted === 1 || (smokeFrames && stereoSubmitted === smokeFrames) ||
                                (!screenMode && (stereoSubmitted === 1 || (aim && !reportedAim)))) {
                                const trackedAim = !screenMode && aim !== null;
                                reportedAim ||= trackedAim;
                                send({ submitted, stereoSubmitted, built, projectionWrites, poseWrites, stereoMatches, rects: lastRect,
                                    trackedAim, screenMode });
                            }
                        }
                    });
                    deviceHook.detach();
                }
            });

            // Both the live viewpoint and the cached rail camera reach this point before view construction.
            Interceptor.attach(address(0x53fe5a), function () {
                    if (!eye || this.threadId !== gameThread.id) return;
                    const location = this.context.r13;
                    const rotationOut = this.context.rdi;
                    const position = vec(location, 3);
                    const rotation = vec(rotationOut, 3, "readS32");
                    originalLocation ??= position;
                    originalRotation ??= rotation;
                    const basis = railBasis([originalRotation[0], originalRotation[1], 0]);
                    const inWorld = v => railTransform(basis, xrToUnreal(rotate(centerRotation, v)));
                    railOrigin = sub(originalLocation, scale(basis[0], railSetback));
                    const toWorld = p => add(railOrigin, scale(inWorld(sub(p, center)), 100));
                    viewerOrigin = toWorld(stereoCenter);
                    write(location, toWorld(eye.position));
                    const axis = v => inWorld(rotate(eye.orientation, v));
                    write(rotationOut, rotator(axis([0, 0, -1]), axis([1, 0, 0]), axis([0, 1, 0])), "writeS32");
                    poseWrites++;
                    if (hasAim) {
                        const hand = pose(frame.add(88));
                        aim = { origin: toWorld(hand.position), target: toWorld(aimPoint(hand.position, hand.orientation)) };
                    }
            });

            // The stock camera letterboxes each half to 16:9. OpenXR supplies the eye's projection instead.
            let eyeExtents;
            const extentOffsets = [-0x58, -0x60, -0x80, -0x7c];
            Interceptor.attach(address(0x53fca8), function () {
                if (eye) eyeExtents = extentOffsets.map(offset => this.context.rbp.add(offset).readS32());
            });
            Interceptor.attach(address(0x53fd79), function () {
                if (!eye) return;
                extentOffsets.forEach((offset, i) => this.context.rbp.add(offset).writeS32(eyeExtents[i]));
                this.context.r8 = ptr(eyeExtents[2]);
                this.context.r9 = ptr(eyeExtents[3]);
                write(address(0x124dab8), [0, 0], "writeS32");
            });
            Interceptor.attach(address(0x32a4c0), {
                onEnter(args) {
                    if (!eye || !this.returnAddress.equals(address(0x54053f))) return;
                    this.extents = [args[2], args[3], args[4], args[5]];
                    this.savedExtents = this.extents.map(field => field.readS32());
                },
                onLeave() {
                    if (this.extents) this.extents.forEach((field, i) => field.writeS32(this.savedExtents[i]));
                }
            });
            Interceptor.attach(address(0x761940), {
                onEnter(args) {
                    if (!eye || !this.returnAddress.equals(address(0x540eed))) return;
                    const matrix = args[17];
                    if (matrix.add(44).readFloat() !== 1 || matrix.add(60).readFloat() !== 0) return;
                    if (aim) {
                        const [forward, right, up] = railBasis(originalRotation);
                        const delta = sub(aim.target, railOrigin);
                        crosshair = nativeAimAxes(dot(delta, right), dot(delta, up), dot(delta, forward),
                            matrix.readFloat(), matrix.add(20).readFloat());
                        if (!playerInput.isNull()) write(playerInput.add(0x310), crosshair);
                        if (!localController.isNull()) write(localController.add(0xab8), crosshair);
                    }
                    scratch.writeByteArray(matrix.readByteArray(64));
                    eye.projection.forEach((value, i) =>
                        scratch.add([0, 5, 8, 9][i] * 4).writeFloat(value));
                    args[17] = scratch;
                    projectionWrites++;
                }
            });

            for (const [rva, isRotator] of [[0xa0f750, true], [0xa0f830, false]]) {
                Interceptor.attach(address(rva), {
                    onEnter(args) {
                        if (!aim || !args[0].equals(localController)) return;
                        this.output = args[1];
                        this.from = isRotator && !args[3].isNull() ? vec(args[3], 3) : aim.origin;
                    },
                    onLeave() {
                        if (!this.output || !aim) return;
                        const delta = sub(aim.target, this.from);
                        const distance = Math.hypot(...delta);
                        if (!Number.isFinite(distance) || distance < 0.01) return;
                        write(this.output, isRotator ? rotator(delta) : normalize(delta),
                            isRotator ? "writeS32" : "writeFloat");
                    }
                });
            }

            const viewmodelProxies = new Set();
            // Scale around the midpoint of the eyes to reduce disparity without bringing the pawn's head into view.
            Interceptor.attach(address(0x788920), {
                onEnter() {
                    if (screenMode || !pending || !originalRotation || localController.isNull() ||
                        this.threadId !== gameThread.id || !this.returnAddress.equals(address(0x546b1d))) return;
                    const pawn = localController.add(0x798).readPointer();
                    if (pawn.isNull()) return;
                    const weapon = pawn.add(0x494).readPointer();
                    const meshes = [pawn.add(0x43c).readPointer()];
                    if (!weapon.isNull()) meshes.push(weapon.add(0x34c).readPointer());
                    this.moved = [];
                    for (const mesh of meshes) {
                        if (mesh.isNull() || mesh.add(0x170).readU8() !== 2) continue;
                        const scene = mesh.add(0xa8).readPointer();
                        if (scene.isNull() || !scene.add(0x10).readPointer().equals(mesh)) continue;
                        const proxy = scene.add(8).readPointer();
                        if (proxy.isNull() || !proxy.readPointer().equals(address(0xeee120))) continue;
                        viewmodelProxies.add(proxy.toString());
                        const transform = proxy.add(0x10);
                        const saved = vec(transform, 16);
                        const adjusted = saved.slice();
                        for (const row of [0, 4, 8]) {
                            for (let i = row; i < row + 3; i++) adjusted[i] *= viewmodelScale;
                        }
                        const translation = add(viewerOrigin, scale(sub(saved.slice(12, 15), viewerOrigin), viewmodelScale));
                        adjusted.splice(12, 3, ...translation);
                        this.moved.push([transform, saved]);
                        write(transform, adjusted);
                    }
                },
                onLeave() {
                    if (!this.moved) return;
                    for (const [position, saved] of this.moved) write(position, saved);
                    viewmodelProxies.clear();
                }
            });

            // The foreground pass omits the per-eye projection offsets. Apply them to the local meshes for this draw.
            Interceptor.attach(address(0x5f7730), {
                onEnter(args) {
                    if (!viewmodelProxies.size || args[3].toInt32() !== 2 ||
                        !viewmodelProxies.has(args[0].toString())) return;
                    const [, horizontal, vertical] = stereoCalibration;
                    if (!horizontal && !vertical) return;
                    const view = args[2];
                    const x = view.add(0x5c).readFloat();
                    if (x !== lastRect[0] && x !== lastRect[4]) return;
                    const direction = x === lastRect[0] ? 1 : -1;
                    const matrix = vec(view.add(0x80), 16);
                    const right = [matrix[0], matrix[4], matrix[8]];
                    const up = [matrix[1], matrix[5], matrix[9]];
                    const forward = [matrix[2], matrix[6], matrix[10]];
                    const correction = add(scale(right, direction * horizontal / (100 * view.add(0xc0).readFloat())),
                        scale(up, direction * vertical / (100 * view.add(0xd4).readFloat())));
                    if (!correction.every(Number.isFinite)) return;

                    this.transform = args[0].add(0x10);
                    this.saved = vec(this.transform, 16);
                    const adjusted = this.saved.slice();
                    for (let row = 0; row < 4; row++) {
                        const vector = this.saved.slice(row * 4, row * 4 + 3);
                        const distance = dot(vector, forward) + (row === 3 ? matrix[14] : 0);
                        adjusted.splice(row * 4, 3, ...add(vector, scale(correction, distance)));
                    }
                    write(this.transform, adjusted);
                },
                onLeave() {
                    if (this.transform) write(this.transform, this.saved);
                }
            });

            Interceptor.attach(address(0xa159b0), {
                onEnter(args) {
                    if (crosshair && args[0].equals(playerInput)) {
                        this.output = args[0].add(0x310);
                        write(this.output, crosshair);
                    }
                },
                onLeave() {
                    if (this.output && crosshair) write(this.output, crosshair);
                }
            });
            const crosshairGetter = address(0xa351a0);
            const getCrosshair = new NativeFunction(crosshairGetter, "float", ["pointer", "int"]);
            Interceptor.replace(crosshairGetter, new NativeCallback((controller, axis) => {
                if (crosshair && controller.equals(localController) && (axis === 0 || axis === 1)) {
                    return crosshair[axis];
                }
                return getCrosshair(controller, axis);
            }, "float", ["pointer", "int"]));
            Interceptor.attach(address(0xa31f30), {
                onEnter(args) {
                    if (aim && args[0].equals(localController)) this.output = args[0].add(0xab8);
                },
                onLeave() {
                    if (this.output && crosshair) write(this.output, crosshair);
                }
            });
            const spriteRender = address(0x9b7560);
            const drawSprite = new NativeFunction(spriteRender, "int", ["pointer", "pointer"]);
            Interceptor.replace(spriteRender, new NativeCallback(function (sprite, hud) {
                if (screenMode || !pending || !reticlePixels || localController.isNull() ||
                    !this.returnAddress.equals(address(0x9de0dc))) return drawSprite(sprite, hud);
                const gui = localController.add(0xc34).readPointer();
                if (gui.isNull() || (gui.add(0x78).readU32() & 0x400)) return drawSprite(sprite, hud);
                const isAimMark = sprite.equals(gui.add(0x7c).readPointer()) || sprite.equals(gui.add(0x84).readPointer());
                if (!isAimMark && !sprite.equals(gui.add(0xc4).readPointer())) return drawSprite(sprite, hud);

                // The game's reticle draws on a 1280x720 HUD over the combined back buffer.
                const point = reticlePixels[hudEye];
                if (!point) return 0;
                const position = sprite.add(0x60), saved = vec(position, 2);
                try {
                    write(position, point);
                    const drawn = drawSprite(sprite, hud);
                    if (isAimMark && drawn) stockReticleEyes |= 1 << hudEye;
                    return drawn;
                } finally {
                    write(position, saved);
                }
            }, "int", ["pointer", "pointer"]));

            const pushHud = new NativeFunction(address(0x6e0250), "void", ["pointer", "pointer"]);
            const popHud = new NativeFunction(address(0x6e3560), "void", ["pointer"]);
            const processHud = new NativeFunction(address(0x290f60), "void", Array(4).fill("pointer"));
            const hudMatrix = Memory.alloc(Process.pageSize);
            let hudScale = [1, 1];
            let hudCanvas = NULL;
            function writeHudMatrix(index) {
                const matrix = hudTransforms[index].matrix.slice();
                for (let i = 0; i < 2; i++) {
                    matrix[i] *= hudScale[0];
                    matrix[4 + i] *= hudScale[1];
                }
                write(hudMatrix, matrix);
            }
            Interceptor.attach(address(0x6e0250), {
                onEnter(args) {
                    if (!pending || !hudTransforms || !this.returnAddress.equals(address(0x547272))) return;
                    hudCanvas = args[0];
                    hudScale = [args[1].readFloat(), args[1].add(20).readFloat()];
                    writeHudMatrix(0);
                    args[1] = hudMatrix;
                }
            });
            let drewRightHud = false;
            let leftGuiAim = null;
            let leftLowLifeMaterial = null;
            function setHudAim(slot, index) {
                const point = reticlePixels[index] || [-16384, -16384];
                write(slot, [...point, ...point]);
            }
            Interceptor.attach(address(0x5472d5), function () {
                const hud = this.context.rcx;
                if (!pending || !hudTransforms || hudCanvas.isNull() || localController.isNull() ||
                    !localController.add(0x4a0).readPointer().equals(hud) ||
                    !this.context.rdi.add(0x210).readPointer().equals(address(0x290f60))) return;
                const canvasObject = hud.add(0x510).readPointer();
                if (canvasObject.isNull() || !canvasObject.add(0xa0).readPointer().equals(stereoViews[0])) return;
                const viewSlot = canvasObject.add(0xa0);
                const gui = localController.add(0xc34).readPointer();
                const guiAim = !gui.isNull() && !(gui.add(0x78).readU32() & 0x400) ? gui.add(0xe4) : NULL;
                const savedAim = guiAim.isNull() ? null : guiAim.readByteArray(16);
                const info = worldInfo();
                const lowLifeSlot = info.isNull() ? NULL : info.add(0x112c);
                const lowLifeMaterial = lowLifeSlot.isNull() ? NULL : lowLifeSlot.readPointer();
                popHud(hudCanvas);
                writeHudMatrix(1);
                pushHud(hudCanvas, hudMatrix);
                hudEye = 1;
                viewSlot.writePointer(stereoViews[1]);
                try {
                    // The replay runs inside this hook, so supply the right-eye position to the script directly.
                    if (savedAim && hasAim) setHudAim(guiAim, 1);
                    // NearDeath samples the combined back buffer, so its HUD tile repeats both eyes.
                    if (!lowLifeMaterial.isNull()) lowLifeSlot.writePointer(NULL);
                    processHud(hud, this.context.rdx, NULL, NULL);
                    drewRightHud = savedAim !== null;
                } finally {
                    if (!lowLifeMaterial.isNull()) lowLifeSlot.writePointer(lowLifeMaterial);
                    if (savedAim) guiAim.writeByteArray(savedAim);
                    hudEye = 0;
                    viewSlot.writePointer(stereoViews[0]);
                    popHud(hudCanvas);
                    writeHudMatrix(0);
                    pushHud(hudCanvas, hudMatrix);
                }
                if (savedAim && hasAim) {
                    leftGuiAim = { slot: guiAim, value: savedAim };
                    setHudAim(guiAim, 0);
                }
                if (!lowLifeMaterial.isNull()) {
                    leftLowLifeMaterial = { slot: lowLifeSlot, value: lowLifeMaterial };
                    lowLifeSlot.writePointer(NULL);
                }
            });
            Interceptor.attach(address(0x5472db), function () {
                if (leftLowLifeMaterial) {
                    leftLowLifeMaterial.slot.writePointer(leftLowLifeMaterial.value);
                    leftLowLifeMaterial = null;
                }
                if (leftGuiAim) {
                    leftGuiAim.slot.writeByteArray(leftGuiAim.value);
                    leftGuiAim = null;
                }
            });
            Interceptor.attach(user32.getExportByName("GetCursorPos"), {
                onEnter(args) {
                    if (menuCursor && this.threadId === gameThread.id &&
                        this.returnAddress.compare(game.base) >= 0 &&
                        this.returnAddress.compare(game.base.add(game.size)) < 0) this.point = args[0];
                },
                onLeave(result) {
                    if (!this.point || !menuCursor) return;
                    write(this.point, menuCursor, "writeS32");
                    if (clientToScreen(window, this.point)) result.replace(ptr(1));
                }
            });

            let mainMenuReached = false;
            Interceptor.replace(scene, new NativeCallback(function (player, family, loc, rot, viewport, drawer) {
                const original = () => calcView(player, family, loc, rot, viewport, drawer);
                if (!this.returnAddress.equals(address(0x546451))) return original();
                const gameMap = currentMap();
                const menuMap = gameMap.toLowerCase().includes("mainmenu");
                if (menuMap) hideMenuCharacter();
                if (!mainMenuReached && menuMap) {
                    mainMenuReached = true;
                    try {
                        arcadeUnlock = installArcadeUnlock(game.base);
                        send({ arcade: true });
                    } catch (e) {
                        send({ arcade: false, reason: e.message });
                    }
                }
                if (calibrationStage && (gameMap.toLowerCase() !== "tap_ut_root" || !freezeCalibrationStage(player))) {
                    return original();
                }
                if (!available || (!smokeFrames && !calibrationStage && !mainMenuReached) ||
                    (smokeFrames && stereoSubmitted >= smokeFrames)) return original();
                gameThread.id = this.threadId;
                const rect = player.add(0xa0);
                const saved = vec(rect, 4);
                if (!presentHook || saved.join(",") !== "0,0,1,1") return original();
                if (pending) {
                    pending = false;
                    submit(NULL, NULL, 0);
                }
                const status = begin(frame);
                if (status < 0) disable(error());
                if (status !== 1) {
                    releaseControls();
                    aim = null;
                    crosshair = null;
                    return original();
                }
                const eyes = [0, 44].map(offset => {
                    const data = frame.add(offset);
                    return { ...pose(data), fov: vec(data.add(28), 4) };
                });
                stereoCenter = scale(add(eyes[0].position, eyes[1].position), 0.5);
                const name = smokeFrames && !calibrationStage && syntheticFrames > 4 ? "TestLevel" : gameMap;
                const mainMenu = !name || name.toLowerCase().includes("mainmenu");
                const tutorial = !smokeFrames && !mainMenu && tutorialFrozen();
                const inGameMenu = !smokeFrames && !calibrationStage && !mainMenu && blockingMenu();
                const mapChanged = name !== lastMap;
                lastMap = name;
                const screenToggle = frame.add(136).readU32() !== 0 || (keyState(0x77) & 0x8000);
                if (screenToggle && !screenToggleWasDown && !mainMenu && !tutorial && !inGameMenu) {
                    screenOverride = !screenOverride;
                }
                screenToggleWasDown = screenToggle;
                const nextScreenMode = mainMenu || tutorial || inGameMenu || screenOverride;
                const mode = mainMenu ? "menu screen" : tutorial ? "tutorial panel" : inGameMenu ? "in-game menu panel"
                    : nextScreenMode ? "comfort screen" : "immersive stereo";
                if (nextScreenMode !== screenMode) {
                    releaseControls();
                    center = null;
                    screenMode = nextScreenMode;
                    reportedControls = false;
                    send({ mode, map: name });
                } else if (mapChanged && !mainMenu && screenMode) {
                    send({ mode, map: name });
                }
                updateCalibrationControls(frame, screenMode);
                if (calibrationStage && (frame.add(124).readU16() & 0x0010)) send({ exitCalibration: true });
                const recenter = frame.add(120).readU32() !== 0;
                if (!center || (recenter && !recenterWasDown)) {
                    lastMousePoint = null;
                    center = stereoCenter;
                    const forward = rotate(eyes[0].orientation, [0, 0, -1]);
                    const yaw = Math.atan2(-forward[0], -forward[2]);
                    centerRotation = [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)];
                }
                recenterWasDown = recenter;
                hasAim = frame.add(116).readU32() !== 0;
                aim = null;
                crosshair = null;
                reticlePixels = null;
                hudTransforms = null;
                stereoViews = null;
                hudCanvas = NULL;
                drewRightHud = false;
                stockReticleEyes = 0;
                const controller = player.add(0x68).readPointer();
                localController = !controller.isNull() &&
                    controller.readPointer().add(0xb60).readPointer().equals(crosshairGetter) ? controller : NULL;
                playerInput = localController.isNull() ? NULL : localController.add(0x554).readPointer();
                const hand = pose(frame.add(88));
                const sized = getRect(window, client);
                if (!smokeFrames) {
                    menuCursor = screenMode && hasAim && sized
                        ? screenPointer(hand, eyes, client.add(8).readS32(), client.add(12).readS32())
                        : null;
                }
                if (screenMode) {
                    write(rects.add(32), menuCursor || [-1, -1], "writeS32");
                    if (menuCursor && !playerInput.isNull()) {
                        const width = client.add(8).readS32(), height = client.add(12).readS32();
                        crosshair = [2 * menuCursor[0] / width - 1, 2 * menuCursor[1] / height - 1];
                        write(playerInput.add(0x310), crosshair);
                    }
                    if (!smokeFrames && !calibrationStage) {
                        if (!mainMenu) moveMouse(menuCursor);
                        controls(frame, true, menuCursor, menuCursor !== null, !mainMenu && !inGameMenu);
                    }
                    pending = true;
                    return original();
                }
                // The post-process chain at +0xB0 belongs to both eyes. The render history lives at +0xCC.
                const viewState = player.add(0xcc);
                const state = viewState.readPointer();
                if (rightState.isNull()) {
                    if (state.isNull() || !state.readPointer().equals(address(0xdfd848))) {
                        submit(NULL, NULL, 0);
                        disable("Blue Estate's stereo render history could not be verified.");
                        return original();
                    }
                    rightState = allocateViewState();
                    if (rightState.isNull() || !rightState.readPointer().equals(state.readPointer())) {
                        submit(NULL, NULL, 0);
                        disable("Blue Estate could not allocate the right-eye render history.");
                        return original();
                    }
                }
                const views = [];
                // Use the same reduced eye separation for scene geometry and the world-space aim marker.
                const renderEyes = eyes.map((view, index) => renderEye(view, stereoCenter, index));
                const projectionsBefore = projectionWrites, posesBefore = poseWrites;
                originalLocation = null;
                originalRotation = null;
                try {
                    for (let index = 0; index < 2; index++) {
                        write(rect, [index / 2, 0, 0.5, 1]);
                        eye = renderEyes[index];
                        if (index === 1) viewState.writePointer(rightState);
                        views.push(original());
                    }
                } finally {
                    eye = null;
                    viewState.writePointer(state);
                    write(rect, saved);
                    if (originalLocation) write(loc, originalLocation);
                    if (originalRotation) write(rot, originalRotation, "writeS32");
                }
                if (projectionWrites === projectionsBefore + 2 && poseWrites === posesBefore + 2 &&
                    views.every(view => !view.isNull())) {
                    if (smokeFrames) {
                        stereoMatches &&= views.every((view, index) =>
                            view.add(8).readPointer().equals(index === 0 ? state : rightState) &&
                            renderEyes[index].projection.every((value, field) =>
                                Math.abs(view.add(0xc0 + [0, 5, 8, 9][field] * 4).readFloat() - value) < 0.00001));
                    }
                    lastRect = views.flatMap(view => vec(view.add(0x5c), 4));
                    write(rects, lastRect, "writeS32");
                    const target = hasAim ? aimPoint(hand.position, hand.orientation) : null;
                    if (!smokeFrames && !calibrationStage) {
                        const width = client.add(8).readS32(), height = client.add(12).readS32();
                        const point = crosshair && width > 0 && height > 0 ? cursorPixels(crosshair, width, height) : null;
                        moveMouse(point);
                        controls(frame, false, point && point.map(Math.floor), hasAim, true);
                    }
                    const cursors = renderEyes.map((view, index) => target
                        ? projectAim(target, view, lastRect[index * 4 + 2], lastRect[index * 4 + 3])
                        : [-1, -1]);
                    write(rects.add(32), cursors.flat().map(Math.round), "writeS32");
                    hudTransforms = eyes.map((view, index) => hudTransform(
                        { ...view, projection: renderEyes[index].projection }, stereoCenter, eyes[0].orientation,
                        lastRect.slice(index * 4, index * 4 + 4)));
                    stereoViews = views;
                    reticlePixels = cursors.map(([x, y], index) => {
                        const offset = index * 4;
                        const [width, height] = lastRect.slice(offset + 2, offset + 4);
                        if (x < 0 || y < 0 || x >= width || y >= height) return null;
                        return hudPoint([x, y], hudTransforms[index], width, height);
                    });
                    built++;
                    pending = true;
                } else {
                    submit(NULL, NULL, 0);
                    if (++failedFrames >= 30) disable("The game did not build both tracked projection views.");
                }
                return views[0];
            }, "pointer", sceneArgs));
        },
        stop() {
            if (arcadeUnlock) arcadeUnlock.listener.detach();
            stop();
        }
    };
}
