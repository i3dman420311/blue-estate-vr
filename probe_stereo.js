const game = Process.mainModule;

function sampleBackBuffer(device, eyes) {
    function method(object, index, result, parameters) {
        const address = object.readPointer().add(index * Process.pointerSize).readPointer();
        return new NativeFunction(address, result, ["pointer", ...parameters]);
    }
    const output = Memory.alloc(Process.pointerSize);
    const getBuffer = method(device, 18, "int", ["uint", "uint", "uint", "pointer"]);
    if (getBuffer(device, 0, 0, 0, output) !== 0) return { error: "GetBackBuffer failed" };
    const buffer = output.readPointer();
    let copy = NULL;
    try {
        const desc = Memory.alloc(32);
        if (method(buffer, 12, "int", ["pointer"])(buffer, desc) !== 0) {
            return { error: "GetDesc failed" };
        }
        const format = desc.readU32();
        const width = desc.add(24).readU32();
        const height = desc.add(28).readU32();
        if (format !== 21 && format !== 22) return { error: "Unsupported back buffer format", format };
        const createSurface = method(device, 36, "int",
            ["uint", "uint", "uint", "uint", "pointer", "pointer"]);
        if (createSurface(device, width, height, format, 2, output, NULL) !== 0) {
            return { error: "CreateOffscreenPlainSurface failed" };
        }
        copy = output.readPointer();
        if (method(device, 32, "int", ["pointer", "pointer"])(device, buffer, copy) !== 0) {
            return { error: "GetRenderTargetData failed" };
        }
        const locked = Memory.alloc(16);
        if (method(copy, 13, "int", ["pointer", "pointer", "uint"])(copy, locked, NULL, 16) !== 0) {
            return { error: "LockRect failed" };
        }
        try {
            const pitch = locked.readS32();
            const pixels = locked.add(8).readPointer();
            return { samples: eyes.map(({ rect: [x, y, w, h] }) => {
                if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > width || y + h > height) {
                    return [];
                }
                const samples = [];
                for (let row = 1; row <= 4; row++) {
                    for (let column = 1; column <= 4; column++) {
                        const sx = Math.floor(x + w * column / 5);
                        const sy = Math.floor(y + h * row / 5);
                        samples.push(pixels.add(sy * pitch + sx * 4).readU32() & 0xffffff);
                    }
                }
                return samples;
            }) };
        } finally {
            method(copy, 14, "int", [])(copy);
        }
    } finally {
        if (!copy.isNull()) method(copy, 2, "uint", [])(copy);
        method(buffer, 2, "uint", [])(buffer);
    }
}

rpc.exports = {
    run(path, frames) {
        if (Process.arch !== "x64" || game.path.toLowerCase() !== path.toLowerCase()) {
            throw new Error("Select the 64-bit Blue Estate process from the verified install.");
        }

        const sceneView = game.base.add(0x53fb20);
        const renderCaller = game.base.add(0x546451);
        const calcView = new NativeFunction(sceneView, "pointer", Array(6).fill("pointer"));
        const eyeRects = [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]];
        const requested = frames;
        let built = 0;
        let baseLocation;
        let eyeOffset = 0;
        let report;

        const getPresent = Interceptor.attach(game.base.add(0x959a80), {
            onEnter(args) {
                const device = args[0].add(0x34).readPointer();
                if (device.isNull()) return;
                const present = device.readPointer().add(17 * Process.pointerSize).readPointer();
                Interceptor.attach(present, {
                    onEnter(presentArgs) {
                        if (!report || !this.returnAddress.equals(game.base.add(0x959cf5))) return;
                        this.result = report;
                        report = null;
                        this.result.backBuffer = sampleBackBuffer(presentArgs[0], this.result.eyes);
                    },
                    onLeave(result) {
                        if (!this.result) return;
                        this.result.presentResult = result.toInt32();
                        send(this.result);
                    }
                });
                getPresent.detach();
            }
        });

        Interceptor.attach(game.base.add(0x327ba0), {
            onEnter(args) {
                if (eyeOffset !== 0 && this.returnAddress.equals(game.base.add(0x53fe47))) {
                    this.location = args[1];
                    this.rotation = args[2];
                }
            },
            onLeave() {
                if (!this.location) return;
                const yaw = this.rotation.add(4).readS32() * Math.PI / 32768;
                baseLocation = this.location.readByteArray(12);
                this.location.writeFloat(this.location.readFloat() - Math.sin(yaw) * eyeOffset);
                const y = this.location.add(4);
                y.writeFloat(y.readFloat() + Math.cos(yaw) * eyeOffset);
            }
        });

        Interceptor.replace(sceneView, new NativeCallback(function (player, family, loc, rot, viewport, drawer) {
            if (frames === 0 || !this.returnAddress.equals(renderCaller)) {
                return calcView(player, family, loc, rot, viewport, drawer);
            }
            const rect = player.add(0xa0);
            const fullRect = [0, 0, 1, 1];
            if (!fullRect.every((value, index) => rect.add(index * 4).readFloat() === value)) {
                return calcView(player, family, loc, rot, viewport, drawer);
            }
            frames--;
            const viewState = player.add(0xb0);
            const originalState = viewState.readPointer();
            const eyes = [];
            const views = [];
            baseLocation = null;
            try {
                for (const [index, eyeRect] of eyeRects.entries()) {
                    eyeRect.forEach((value, field) => rect.add(field * 4).writeFloat(value));
                    eyeOffset = index === 0 ? -3.2 : 3.2;
                    // shortcut: the right eye has no temporal state during this probe, allocate a separate state before continuous play.
                    if (index === 1) viewState.writePointer(NULL);
                    const view = calcView(player, family, loc, rot, viewport, drawer);
                    views.push(view);
                    if (!view.isNull()) {
                        eyes.push({
                            address: view.toString(),
                            projection: [0, 5].map(field => view.add(0xc0 + field * 4).readFloat()),
                            location: [0, 4, 8].map(field => loc.add(field).readFloat()),
                            rect: [0x5c, 0x60, 0x64, 0x68].map(field => view.add(field).readFloat())
                        });
                    }
                }
            } finally {
                eyeOffset = 0;
                viewState.writePointer(originalState);
                fullRect.forEach((value, field) => rect.add(field * 4).writeFloat(value));
                if (baseLocation) loc.writeByteArray(baseLocation);
            }
            if (eyes.length === 2) built++;
            if (frames === 0) {
                const controllerVtable = player.add(0x68).readPointer().readPointer();
                const controllerRva = offset => controllerVtable.add(offset).readPointer()
                    .sub(game.base).toString();
                report = {
                    requested, built, eyes,
                    controller: {
                        getAdjustedAimFor: controllerRva(0xa90),
                        getPlayerRealAim: controllerRva(0xa98),
                        getCrosshairPos: controllerRva(0xb60)
                    }
                };
            }
            return views[0];
        }, "pointer", Array(6).fill("pointer")));
    }
};
