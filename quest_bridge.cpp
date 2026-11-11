#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define XR_USE_PLATFORM_WIN32
#define XR_USE_GRAPHICS_API_D3D11
#include <windows.h>
#include <d3d9.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <xinput.h>
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {
constexpr auto Stereo = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
constexpr auto Tracked = XR_SPACE_LOCATION_POSITION_VALID_BIT | XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
constexpr XrPosef Identity{{0, 0, 0, 1}, {0, 0, 0}};

struct Eye {
    XrPosef pose;
    XrFovf fov;
};

struct Frame {
    Eye eyes[2];
    XrPosef aim;
    uint32_t aimValid;
    uint32_t recenter;
    XINPUT_GAMEPAD pad;
    uint32_t screenToggle;
    uint32_t calibrationToggle;
};

static_assert(sizeof(Eye) == 44 && offsetof(Frame, aim) == 88 &&
              offsetof(Frame, pad) == 124 && offsetof(Frame, screenToggle) == 136 && sizeof(Frame) == 144);

struct EyeBuffer {
    XrSwapchain chain{};
    unsigned width{}, height{};
    std::vector<XrSwapchainImageD3D11KHR> images;
};

struct Bridge {
    XrInstance instance{};
    XrSystemId system{};
    XrSession session{};
    XrSpace local{}, view{}, aimSpace{};
    XrActionSet actions{};
    XrAction aim{}, fire{}, reload{}, accept{}, back{}, weapon{}, pause{}, recenter{}, stick{}, screenToggle{}, calibrationToggle{};
    XrSessionState sessionState{};
    bool running{}, frameOpen{}, frameValid{};
    XrFrameState timing{XR_TYPE_FRAME_STATE};
    XrView views[2]{{XR_TYPE_VIEW}, {XR_TYPE_VIEW}};
    EyeBuffer eyes[2];
    EyeBuffer screen;
    EyeBuffer calibrationPanel;
    std::array<float, 3> calibrationValues{-1.f, 0.f, 0.f};
    DXGI_FORMAT format{};
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<IDirect3DSurface9> readback;
    ComPtr<IDirect3DDevice9> readbackDevice;
    D3DSURFACE_DESC readbackDesc{};
    std::vector<uint32_t> rgba;
};

Bridge bridge;
std::mutex mutex;
char error[256]{};
const char* startStep = "start";

void check(XrResult result, const char* operation) {
    if (XR_SUCCEEDED(result)) return;
    char name[XR_MAX_RESULT_STRING_SIZE]{};
    if (bridge.instance) xrResultToString(bridge.instance, result, name);
    if (!name[0]) sprintf_s(name, "%d", result);
    throw std::runtime_error(std::string(operation) + " returned " + name);
}

void checkHr(HRESULT result, const char* operation) {
    if (SUCCEEDED(result)) return;
    char message[128];
    sprintf_s(message, "%s returned 0x%08lx", operation, result);
    throw std::runtime_error(message);
}

void finish(const XrCompositionLayerBaseHeader* layer = nullptr, const XrCompositionLayerBaseHeader* overlay = nullptr) {
    if (!bridge.frameOpen) return;
    bridge.frameOpen = false;
    bridge.frameValid = false;
    XrFrameEndInfo end{XR_TYPE_FRAME_END_INFO};
    end.displayTime = bridge.timing.predictedDisplayTime;
    end.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
    const XrCompositionLayerBaseHeader* layers[] = {layer, overlay};
    end.layerCount = overlay ? 2u : layer ? 1u : 0u;
    end.layers = layer ? layers : nullptr;
    check(xrEndFrame(bridge.session, &end), "xrEndFrame");
}

void close() {
    try { finish(); } catch (const std::exception&) {}
    if (bridge.aimSpace) xrDestroySpace(bridge.aimSpace);
    if (bridge.view) xrDestroySpace(bridge.view);
    if (bridge.local) xrDestroySpace(bridge.local);
    for (auto& eye : bridge.eyes) {
        if (eye.chain) xrDestroySwapchain(eye.chain);
    }
    if (bridge.screen.chain) xrDestroySwapchain(bridge.screen.chain);
    if (bridge.calibrationPanel.chain) xrDestroySwapchain(bridge.calibrationPanel.chain);
    if (bridge.session) xrDestroySession(bridge.session);
    if (bridge.actions) xrDestroyActionSet(bridge.actions);
    if (bridge.instance) xrDestroyInstance(bridge.instance);
    bridge = {};
}

void openSystem() {
    startStep = "Load Meta OpenXR";
    const char* extensions[] = {XR_KHR_D3D11_ENABLE_EXTENSION_NAME};
    XrInstanceCreateInfo info{XR_TYPE_INSTANCE_CREATE_INFO};
    strcpy_s(info.applicationInfo.applicationName, "Blue Estate VR");
    info.applicationInfo.apiVersion = XR_MAKE_VERSION(1, 0, 0);
    info.enabledExtensionCount = 1;
    info.enabledExtensionNames = extensions;
    check(xrCreateInstance(&info, &bridge.instance), "xrCreateInstance");
    startStep = "Find headset";
    XrSystemGetInfo systemInfo{XR_TYPE_SYSTEM_GET_INFO};
    systemInfo.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
    check(xrGetSystem(bridge.instance, &systemInfo, &bridge.system), "xrGetSystem");
}

XrPath path(const char* value) {
    XrPath result{};
    check(xrStringToPath(bridge.instance, value, &result), "xrStringToPath");
    return result;
}

void bindTouch() {
    XrActionSetCreateInfo set{XR_TYPE_ACTION_SET_CREATE_INFO};
    strcpy_s(set.actionSetName, "blue_estate");
    strcpy_s(set.localizedActionSetName, "Blue Estate");
    check(xrCreateActionSet(bridge.instance, &set, &bridge.actions), "xrCreateActionSet");
    std::vector<XrActionSuggestedBinding> bindings;
    auto bind = [&](XrAction& action, XrActionType type, const char* name,
                    const char* label, const char* input) {
        XrActionCreateInfo info{XR_TYPE_ACTION_CREATE_INFO};
        info.actionType = type;
        strcpy_s(info.actionName, name);
        strcpy_s(info.localizedActionName, label);
        check(xrCreateAction(bridge.actions, &info, &action), "xrCreateAction");
        bindings.push_back({action, path(input)});
    };
    bind(bridge.aim, XR_ACTION_TYPE_POSE_INPUT, "aim", "Aim", "/user/hand/right/input/aim/pose");
    bind(bridge.fire, XR_ACTION_TYPE_FLOAT_INPUT, "fire", "Fire", "/user/hand/right/input/trigger/value");
    bind(bridge.reload, XR_ACTION_TYPE_FLOAT_INPUT, "reload", "Reload and cover", "/user/hand/left/input/squeeze/value");
    bind(bridge.accept, XR_ACTION_TYPE_BOOLEAN_INPUT, "accept", "Accept", "/user/hand/right/input/a/click");
    bind(bridge.back, XR_ACTION_TYPE_BOOLEAN_INPUT, "back", "Back", "/user/hand/right/input/b/click");
    bind(bridge.weapon, XR_ACTION_TYPE_BOOLEAN_INPUT, "weapon", "Next weapon", "/user/hand/left/input/y/click");
    bind(bridge.pause, XR_ACTION_TYPE_BOOLEAN_INPUT, "pause", "Pause", "/user/hand/left/input/menu/click");
    bind(bridge.recenter, XR_ACTION_TYPE_BOOLEAN_INPUT, "recenter", "Recenter", "/user/hand/left/input/x/click");
    bind(bridge.stick, XR_ACTION_TYPE_VECTOR2F_INPUT, "gesture", "Menus and gestures", "/user/hand/left/input/thumbstick");
    bind(bridge.screenToggle, XR_ACTION_TYPE_BOOLEAN_INPUT, "screen_toggle", "Toggle menu screen", "/user/hand/left/input/thumbstick/click");
    bind(bridge.calibrationToggle, XR_ACTION_TYPE_BOOLEAN_INPUT, "calibrate", "Stereo calibration", "/user/hand/right/input/thumbstick/click");
    XrInteractionProfileSuggestedBinding suggestion{XR_TYPE_INTERACTION_PROFILE_SUGGESTED_BINDING};
    suggestion.interactionProfile = path("/interaction_profiles/oculus/touch_controller");
    suggestion.countSuggestedBindings = static_cast<uint32_t>(bindings.size());
    suggestion.suggestedBindings = bindings.data();
    check(xrSuggestInteractionProfileBindings(bridge.instance, &suggestion), "xrSuggestInteractionProfileBindings");

    XrActionSpaceCreateInfo space{XR_TYPE_ACTION_SPACE_CREATE_INFO};
    space.action = bridge.aim;
    space.poseInActionSpace = Identity;
    check(xrCreateActionSpace(bridge.session, &space, &bridge.aimSpace), "xrCreateActionSpace");
    XrSessionActionSetsAttachInfo attach{XR_TYPE_SESSION_ACTION_SETS_ATTACH_INFO};
    attach.countActionSets = 1;
    attach.actionSets = &bridge.actions;
    check(xrAttachSessionActionSets(bridge.session, &attach), "xrAttachSessionActionSets");
}

void openSession() {
    openSystem();
    startStep = "Find graphics requirements";
    PFN_xrGetD3D11GraphicsRequirementsKHR requirements{};
    check(xrGetInstanceProcAddr(bridge.instance, "xrGetD3D11GraphicsRequirementsKHR",
        reinterpret_cast<PFN_xrVoidFunction*>(&requirements)), "xrGetInstanceProcAddr");
    XrGraphicsRequirementsD3D11KHR graphics{XR_TYPE_GRAPHICS_REQUIREMENTS_D3D11_KHR};
    check(requirements(bridge.instance, bridge.system, &graphics), "xrGetD3D11GraphicsRequirementsKHR");

    ComPtr<IDXGIFactory1> factory;
    startStep = "Create DirectX device";
    checkHr(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), "CreateDXGIFactory1");
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT index = 0; ; ++index) {
        checkHr(factory->EnumAdapters1(index, &adapter), "Find the OpenXR graphics adapter");
        DXGI_ADAPTER_DESC1 desc{};
        checkHr(adapter->GetDesc1(&desc), "GetDesc1");
        if (memcmp(&desc.AdapterLuid, &graphics.adapterLuid, sizeof(LUID)) == 0) break;
        adapter.Reset();
    }
    const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
    D3D_FEATURE_LEVEL actual{};
    checkHr(D3D11CreateDevice(adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, &bridge.device, &actual, &bridge.context), "D3D11CreateDevice");
    if (actual < graphics.minFeatureLevel) throw std::runtime_error("OpenXR GPU feature level is too low");

    XrGraphicsBindingD3D11KHR binding{XR_TYPE_GRAPHICS_BINDING_D3D11_KHR};
    startStep = "Create Meta OpenXR session";
    binding.device = bridge.device.Get();
    XrSessionCreateInfo info{XR_TYPE_SESSION_CREATE_INFO};
    info.next = &binding;
    info.systemId = bridge.system;
    check(xrCreateSession(bridge.instance, &info, &bridge.session), "xrCreateSession");
    XrReferenceSpaceCreateInfo space{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
    space.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_LOCAL;
    space.poseInReferenceSpace = Identity;
    check(xrCreateReferenceSpace(bridge.session, &space, &bridge.local), "xrCreateReferenceSpace");
    space.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW;
    check(xrCreateReferenceSpace(bridge.session, &space, &bridge.view), "xrCreateReferenceSpace (view)");
    startStep = "Bind Touch controllers";
    bindTouch();

    startStep = "Select OpenXR texture format";
    uint32_t count{};
    check(xrEnumerateSwapchainFormats(bridge.session, 0, &count, nullptr), "xrEnumerateSwapchainFormats");
    std::vector<int64_t> formats(count);
    check(xrEnumerateSwapchainFormats(bridge.session, count, &count, formats.data()), "xrEnumerateSwapchainFormats");
    for (auto format : {DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB,
                        DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM}) {
        if (std::find(formats.begin(), formats.end(), format) != formats.end()) {
            bridge.format = format;
            break;
        }
    }
    if (!bridge.format) throw std::runtime_error("OpenXR has no supported 32-bit color format");
}

void poll() {
    for (;;) {
        XrEventDataBuffer event{XR_TYPE_EVENT_DATA_BUFFER};
        const XrResult result = xrPollEvent(bridge.instance, &event);
        if (result == XR_EVENT_UNAVAILABLE) return;
        check(result, "xrPollEvent");
        if (event.type == XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING) {
            throw std::runtime_error("The OpenXR runtime disconnected");
        }
        if (event.type != XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) continue;
        bridge.sessionState = reinterpret_cast<const XrEventDataSessionStateChanged&>(event).state;
        if (bridge.sessionState == XR_SESSION_STATE_READY) {
            XrSessionBeginInfo begin{XR_TYPE_SESSION_BEGIN_INFO};
            begin.primaryViewConfigurationType = Stereo;
            check(xrBeginSession(bridge.session, &begin), "xrBeginSession");
            bridge.running = true;
        } else if (bridge.sessionState == XR_SESSION_STATE_STOPPING) {
            check(xrEndSession(bridge.session), "xrEndSession");
            bridge.running = false;
        } else if (bridge.sessionState == XR_SESSION_STATE_EXITING || bridge.sessionState == XR_SESSION_STATE_LOSS_PENDING) {
            throw std::runtime_error("The OpenXR session ended");
        }
    }
}

void input(Frame& frame) {
    if (bridge.sessionState != XR_SESSION_STATE_FOCUSED) return;
    const XrActiveActionSet active{bridge.actions, XR_NULL_PATH};
    XrActionsSyncInfo sync{XR_TYPE_ACTIONS_SYNC_INFO};
    sync.countActiveActionSets = 1;
    sync.activeActionSets = &active;
    if (xrSyncActions(bridge.session, &sync) != XR_SUCCESS) return;

    XrActionStateGetInfo get{XR_TYPE_ACTION_STATE_GET_INFO};
    auto button = [&](XrAction action) {
        get.action = action;
        XrActionStateBoolean state{XR_TYPE_ACTION_STATE_BOOLEAN};
        check(xrGetActionStateBoolean(bridge.session, &get, &state), "xrGetActionStateBoolean");
        return state.isActive && state.currentState;
    };
    auto trigger = [&](XrAction action) -> BYTE {
        get.action = action;
        XrActionStateFloat state{XR_TYPE_ACTION_STATE_FLOAT};
        check(xrGetActionStateFloat(bridge.session, &get, &state), "xrGetActionStateFloat");
        return state.isActive ? static_cast<BYTE>(std::clamp(state.currentState, 0.f, 1.f) * 255) : 0;
    };
    if (button(bridge.accept)) frame.pad.wButtons |= XINPUT_GAMEPAD_A;
    if (button(bridge.back)) frame.pad.wButtons |= XINPUT_GAMEPAD_B;
    if (button(bridge.weapon)) frame.pad.wButtons |= XINPUT_GAMEPAD_Y;
    if (button(bridge.pause)) frame.pad.wButtons |= XINPUT_GAMEPAD_START;
    frame.recenter = button(bridge.recenter);
    frame.screenToggle = button(bridge.screenToggle);
    frame.calibrationToggle = button(bridge.calibrationToggle);
    frame.pad.bRightTrigger = trigger(bridge.fire);
    frame.pad.bLeftTrigger = trigger(bridge.reload);
    get.action = bridge.stick;
    XrActionStateVector2f axis{XR_TYPE_ACTION_STATE_VECTOR2F};
    check(xrGetActionStateVector2f(bridge.session, &get, &axis), "xrGetActionStateVector2f");
    if (axis.isActive) {
        frame.pad.sThumbLX = static_cast<SHORT>(std::clamp(axis.currentState.x, -1.f, 1.f) * 32767);
        frame.pad.sThumbLY = static_cast<SHORT>(std::clamp(axis.currentState.y, -1.f, 1.f) * 32767);
    }
    get.action = bridge.aim;
    XrActionStatePose aim{XR_TYPE_ACTION_STATE_POSE};
    check(xrGetActionStatePose(bridge.session, &get, &aim), "xrGetActionStatePose");
    if (!aim.isActive) return;
    XrSpaceLocation location{XR_TYPE_SPACE_LOCATION};
    check(xrLocateSpace(bridge.aimSpace, bridge.local, bridge.timing.predictedDisplayTime, &location), "xrLocateSpace");
    if ((location.locationFlags & Tracked) == Tracked) {
        frame.aimValid = 1;
        frame.aim = location.pose;
    }
}

void ensureEye(EyeBuffer& eye, unsigned width, unsigned height) {
    if (eye.chain && eye.width == width && eye.height == height) return;
    if (eye.chain) {
        check(xrDestroySwapchain(eye.chain), "xrDestroySwapchain");
        eye = {};
    }
    XrSwapchainCreateInfo info{XR_TYPE_SWAPCHAIN_CREATE_INFO};
    info.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT | XR_SWAPCHAIN_USAGE_TRANSFER_DST_BIT;
    info.format = bridge.format;
    info.sampleCount = info.arraySize = info.faceCount = info.mipCount = 1;
    info.width = width;
    info.height = height;
    check(xrCreateSwapchain(bridge.session, &info, &eye.chain), "xrCreateSwapchain");
    uint32_t count{};
    check(xrEnumerateSwapchainImages(eye.chain, 0, &count, nullptr), "xrEnumerateSwapchainImages");
    eye.images.assign(count, {XR_TYPE_SWAPCHAIN_IMAGE_D3D11_KHR});
    check(xrEnumerateSwapchainImages(eye.chain, count, &count,
        reinterpret_cast<XrSwapchainImageBaseHeader*>(eye.images.data())), "xrEnumerateSwapchainImages");
    eye.width = width;
    eye.height = height;
}

void upload(EyeBuffer& eye, const uint8_t* pixels, unsigned pitch, unsigned width, unsigned height,
            const int32_t* reticle) {
    ensureEye(eye, width, height);
    if (bridge.format == DXGI_FORMAT_R8G8B8A8_UNORM || bridge.format == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB) {
        bridge.rgba.resize(static_cast<size_t>(width) * height);
        for (unsigned y = 0; y < height; ++y) {
            const auto* row = reinterpret_cast<const uint32_t*>(pixels + y * pitch);
            auto* out = bridge.rgba.data() + static_cast<size_t>(y) * width;
            for (unsigned x = 0; x < width; ++x) {
                const uint32_t bgra = row[x];
                out[x] = 0xff000000 | (bgra & 0xff00) | ((bgra & 0xff) << 16) | ((bgra >> 16) & 0xff);
            }
        }
        pixels = reinterpret_cast<const uint8_t*>(bridge.rgba.data());
        pitch = width * 4;
    }
    uint32_t index{};
    XrSwapchainImageAcquireInfo acquire{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
    check(xrAcquireSwapchainImage(eye.chain, &acquire, &index), "xrAcquireSwapchainImage");
    XrSwapchainImageWaitInfo wait{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
    wait.timeout = XR_INFINITE_DURATION;
    check(xrWaitSwapchainImage(eye.chain, &wait), "xrWaitSwapchainImage");
    ID3D11Texture2D* texture = eye.images[index].texture;
    bridge.context->UpdateSubresource(texture, 0, nullptr, pixels, pitch, 0);
    if (reticle[0] >= 5 && reticle[1] >= 5 && reticle[0] + 5 < static_cast<int>(width) &&
        reticle[1] + 5 < static_cast<int>(height)) {
        const auto x = static_cast<unsigned>(reticle[0]);
        const auto y = static_cast<unsigned>(reticle[1]);
        constexpr std::array<uint32_t, 9> line{0xff202020, 0xffffffff, 0xffffffff, 0xffffffff,
            0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 0xff202020};
        const D3D11_BOX horizontal{x - 4, y, 0, x + 5, y + 1, 1};
        const D3D11_BOX vertical{x, y - 4, 0, x + 1, y + 5, 1};
        bridge.context->UpdateSubresource(texture, 0, &horizontal, line.data(), 9 * 4, 0);
        bridge.context->UpdateSubresource(texture, 0, &vertical, line.data(), 4, 0);
    }
    XrSwapchainImageReleaseInfo release{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
    check(xrReleaseSwapchainImage(eye.chain, &release), "xrReleaseSwapchainImage");
}

bool calibrationOverlay(XrCompositionLayerQuad& quad, const float* values) {
    if (!values) return false;
    constexpr int width = 640, height = 110;
    const std::array<float, 3> current{values[0], values[1], values[2]};
    if (current != bridge.calibrationValues) {
        BITMAPINFO info{};
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        void* pixels{};
        const HDC dc = CreateCompatibleDC(nullptr);
        const HBITMAP bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
        if (!dc || !bitmap) {
            if (bitmap) DeleteObject(bitmap);
            if (dc) DeleteDC(dc);
            return false;
        }
        const auto previousBitmap = SelectObject(dc, bitmap);
        const HFONT font = CreateFontW(-24, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY, DEFAULT_PITCH, L"Segoe UI");
        const auto previousFont = font ? SelectObject(dc, font) : nullptr;
        std::fill_n(static_cast<uint32_t*>(pixels), width * height, 0xff142333);
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, RGB(240, 246, 255));
        wchar_t text[192];
        swprintf_s(text, L"Depth %.0f%%  |  Horizontal %+.1f%%  |  Vertical %+.1f%%\n"
            L"A / B: depth    Left stick: alignment\nRight stick click: close    A+B: reset", values[0], values[1], values[2]);
        RECT bounds{10, 10, width - 10, height - 4};
        DrawTextW(dc, text, -1, &bounds, DT_CENTER | DT_NOPREFIX);
        GdiFlush();
        std::vector<uint32_t> image(static_cast<uint32_t*>(pixels), static_cast<uint32_t*>(pixels) + width * height);
        if (font) { SelectObject(dc, previousFont); DeleteObject(font); }
        SelectObject(dc, previousBitmap);
        DeleteObject(bitmap);
        DeleteDC(dc);
        constexpr int32_t noReticle[] = {-1, -1};
        upload(bridge.calibrationPanel, reinterpret_cast<const uint8_t*>(image.data()), width * 4, width, height, noReticle);
        bridge.calibrationValues = current;
    }
    quad.space = bridge.view;
    quad.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
    quad.pose = Identity;
    quad.pose.position = {0.f, -.43f, -1.65f};
    quad.size = {1.1f, 1.1f * height / width};
    quad.subImage.swapchain = bridge.calibrationPanel.chain;
    quad.subImage.imageRect.extent = {width, height};
    return true;
}

bool submit(IDirect3DDevice9* device, const int32_t* rects, bool screen, const float* calibration) {
    ComPtr<IDirect3DSurface9> back;
    if (FAILED(device->GetBackBuffer(0, 0, D3DBACKBUFFER_TYPE_MONO, &back))) return false;
    D3DSURFACE_DESC desc{};
    if (FAILED(back->GetDesc(&desc))) return false;
    if ((desc.Format != D3DFMT_X8R8G8B8 && desc.Format != D3DFMT_A8R8G8B8) ||
        desc.MultiSampleType != D3DMULTISAMPLE_NONE) {
        throw std::runtime_error("The game must use a non-multisampled 32-bit DirectX 9 back buffer");
    }
    for (int eye = 0; !screen && eye < 2; ++eye) {
        const int32_t* r = rects + eye * 4;
        if (r[0] < 0 || r[1] < 0 || r[2] <= 0 || r[3] <= 0 ||
            static_cast<uint64_t>(r[0]) + r[2] > desc.Width ||
            static_cast<uint64_t>(r[1]) + r[3] > desc.Height) return false;
    }
    if (bridge.readbackDevice.Get() != device || !bridge.readback ||
        bridge.readbackDesc.Width != desc.Width || bridge.readbackDesc.Height != desc.Height ||
        bridge.readbackDesc.Format != desc.Format) {
        bridge.readback.Reset();
        if (FAILED(device->CreateOffscreenPlainSurface(desc.Width, desc.Height, desc.Format,
                D3DPOOL_SYSTEMMEM, &bridge.readback, nullptr))) return false;
        bridge.readbackDesc = desc;
        bridge.readbackDevice = device;
    }
    // shortcut: DX9 readback stalls the GPU, replace with a GPU copy if Link cannot sustain its refresh rate.
    if (FAILED(device->GetRenderTargetData(back.Get(), bridge.readback.Get()))) return false;
    D3DLOCKED_RECT lock{};
    if (FAILED(bridge.readback->LockRect(&lock, nullptr, D3DLOCK_READONLY))) return false;
    struct Unlock { IDirect3DSurface9* surface; ~Unlock() { surface->UnlockRect(); } } unlock{bridge.readback.Get()};
    const auto* pixels = static_cast<const uint8_t*>(lock.pBits);
    if (screen) {
        upload(bridge.screen, pixels, lock.Pitch, desc.Width, desc.Height, rects + 8);
        XrCompositionLayerQuad quad{XR_TYPE_COMPOSITION_LAYER_QUAD};
        quad.space = bridge.view;
        quad.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
        quad.subImage.swapchain = bridge.screen.chain;
        quad.subImage.imageRect.extent = {static_cast<int32_t>(desc.Width), static_cast<int32_t>(desc.Height)};
        quad.pose = Identity;
        quad.pose.position.z = -2.3f;
        quad.size = {2.0f, 2.0f * desc.Height / desc.Width};
        finish(reinterpret_cast<const XrCompositionLayerBaseHeader*>(&quad));
        return true;
    }
    XrCompositionLayerProjectionView projections[2]{{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW},
                                                    {XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW}};
    for (int eye = 0; eye < 2; ++eye) {
        const int32_t* r = rects + eye * 4;
        upload(bridge.eyes[eye], pixels + r[1] * lock.Pitch + r[0] * 4, lock.Pitch, r[2], r[3],
            rects + 8 + eye * 2);
        auto& view = projections[eye];
        view.pose = bridge.views[eye].pose;
        view.fov = bridge.views[eye].fov;
        view.subImage.swapchain = bridge.eyes[eye].chain;
        view.subImage.imageRect.extent = {r[2], r[3]};
    }
    XrCompositionLayerProjection layer{XR_TYPE_COMPOSITION_LAYER_PROJECTION};
    layer.space = bridge.local;
    layer.viewCount = 2;
    layer.views = projections;
    XrCompositionLayerQuad overlay{XR_TYPE_COMPOSITION_LAYER_QUAD};
    const bool showCalibration = calibrationOverlay(overlay, calibration);
    finish(reinterpret_cast<const XrCompositionLayerBaseHeader*>(&layer),
        showCalibration ? reinterpret_cast<const XrCompositionLayerBaseHeader*>(&overlay) : nullptr);
    return true;
}

int failed(const std::exception& exception) {
    strncpy_s(error, exception.what(), _TRUNCATE);
    close();
    return -1;
}
}

#define API extern "C" __declspec(dllexport)
API const char* BevrError() { return error; }

API int BevrStart(int checkOnly) {
    try {
        std::lock_guard lock(mutex);
        if (checkOnly) {
            openSystem();
            close();
        } else {
            openSession();
        }
        return 1;
    } catch (const std::exception& exception) {
        sprintf_s(error, "%s: %.170s", startStep, exception.what());
        close();
        return -1;
    }
}

API int BevrBegin(Frame* output) {
    std::lock_guard lock(mutex);
    if (!bridge.session || bridge.frameOpen) return 0;
    try {
        poll();
        if (!bridge.running) return 0;
        XrFrameWaitInfo wait{XR_TYPE_FRAME_WAIT_INFO};
        check(xrWaitFrame(bridge.session, &wait, &bridge.timing), "xrWaitFrame");
        XrFrameBeginInfo begin{XR_TYPE_FRAME_BEGIN_INFO};
        check(xrBeginFrame(bridge.session, &begin), "xrBeginFrame");
        bridge.frameOpen = true;
        if (!bridge.timing.shouldRender) {
            finish();
            return 0;
        }

        XrViewLocateInfo locate{XR_TYPE_VIEW_LOCATE_INFO};
        locate.viewConfigurationType = Stereo;
        locate.displayTime = bridge.timing.predictedDisplayTime;
        locate.space = bridge.local;
        XrViewState state{XR_TYPE_VIEW_STATE};
        uint32_t count{};
        check(xrLocateViews(bridge.session, &locate, &state, 2, &count, bridge.views), "xrLocateViews");
        constexpr auto required = XR_VIEW_STATE_POSITION_VALID_BIT | XR_VIEW_STATE_ORIENTATION_VALID_BIT;
        if (count != 2 || (state.viewStateFlags & required) != required) {
            finish();
            return 0;
        }
        // Blue Estate's foreground draw shares a projection center across the eyes.
        // Use one frustum that covers both eye fields, and submit the same frustum to OpenXR.
        const auto& left = bridge.views[0].fov;
        const auto& right = bridge.views[1].fov;
        const float halfWidth = std::max(std::max(-left.angleLeft, -right.angleLeft),
            std::max(left.angleRight, right.angleRight));
        const XrFovf fov{-halfWidth, halfWidth, std::max(left.angleUp, right.angleUp),
            std::min(left.angleDown, right.angleDown)};
        *output = {};
        for (int eye = 0; eye < 2; ++eye) {
            bridge.views[eye].fov = fov;
            output->eyes[eye] = {bridge.views[eye].pose, fov};
        }
        input(*output);
        bridge.frameValid = true;
        return 1;
    } catch (const std::exception& exception) { return failed(exception); }
}

API int BevrSubmit(IDirect3DDevice9* device, const int32_t* rects, int screen, const float* calibration) {
    std::lock_guard lock(mutex);
    try {
        if (bridge.frameValid && device && rects && submit(device, rects, screen != 0, calibration)) return 1;
        finish();
        return 0;
    } catch (const std::exception& exception) { return failed(exception); }
}

API void BevrStop() {
    std::lock_guard lock(mutex);
    close();
}
