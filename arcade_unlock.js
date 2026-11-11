// Blue Estate Win64 Steam build 637056. The launcher checks the executable hash.
function installArcadeUnlock(base) {
    const names = base.add(0x11bc910);
    const objects = base.add(0x123ee48);
    const nameData = names.readPointer();
    const nameCount = names.add(8).readU32();
    const objectData = objects.readPointer();
    const objectCount = objects.add(8).readU32();
    if (nameData.isNull() || objectData.isNull() || !nameCount || !objectCount) {
        throw new Error("Blue Estate hasn't loaded the Arcade menu scripts.");
    }

    const targets = new Set(["IsLevelLocked", "IsLevelLockedForDifficulty"]);
    const indexes = new Map();
    for (let i = 0; i < nameCount && indexes.size < targets.size; i++) {
        const entry = nameData.add(i * 8).readPointer();
        if (entry.isNull() || (entry.add(8).readU32() & 1)) continue;
        const value = entry.add(20).readCString();
        if (targets.has(value)) indexes.set(i, value);
    }

    const matches = new Map();
    for (let i = 0; i < objectCount && matches.size < targets.size; i++) {
        const object = objectData.add(i * 8).readPointer();
        if (object.isNull()) continue;
        const target = indexes.get(object.add(0x48).readU32());
        if (!target) continue;
        const owner = object.add(0x40).readPointer();
        if (owner.isNull()) continue;
        const entry = nameData.add(owner.add(0x48).readU32() * 8).readPointer();
        if (entry.add(20).readCString() === "BEGameManager") matches.set(target, object);
    }
    if (matches.size !== targets.size) throw new Error("Blue Estate's Arcade menu scripts could not be found.");

    const menuLock = matches.get("IsLevelLocked");
    const difficultyLock = matches.get("IsLevelLockedForDifficulty");
    const processInternal = base.add(0x57500);
    if (![menuLock, difficultyLock].every(fn => fn.add(0xf0).readPointer().equals(processInternal))) {
        throw new Error("Blue Estate's Arcade checks differ from the verified build.");
    }

    // The Arcade menu asks with Story mode (0), so identify Arcade stages by their map type (2).
    const native = new CModule(`
        #include <gum/guminterceptor.h>

        extern guint8 menu_lock, difficulty_lock;

        void onEnter(GumInvocationContext *context) {
            guint32 **result = gum_invocation_context_get_listener_invocation_data(context, sizeof(gpointer));
            *result = NULL;
            guint8 *frame = gum_invocation_context_get_nth_argument(context, 1);
            gpointer node = *(gpointer *) (frame + 0x14);
            if (node != &menu_lock && node != &difficulty_lock) return;
            guint8 *locals = *(guint8 **) (frame + 0x2c);
            if (locals == NULL) return;
            guint8 *manager = gum_invocation_context_get_nth_argument(context, 0);
            gint level = *(gint *) locals;
            guint8 *levels = *(guint8 **) (manager + 0x278);
            if (levels != NULL && level >= 0 && level < *(gint *) (manager + 0x280) && levels[level * 56 + 52] == 2)
                *result = gum_invocation_context_get_nth_argument(context, 2);
        }

        void onLeave(GumInvocationContext *context) {
            guint32 **result = gum_invocation_context_get_listener_invocation_data(context, sizeof(gpointer));
            if (*result != NULL) **result = 0;
        }
    `, { menu_lock: menuLock, difficulty_lock: difficultyLock });
    const listener = Interceptor.attach(processInternal, native);
    return { native, listener };
}
