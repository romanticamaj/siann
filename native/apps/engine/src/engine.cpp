#include "siann/engine_app/engine.hpp"

#include <atomic>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <exception>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "device.hpp"
#include "launch_error.hpp"
#include "main_thread.hpp"
#include "siann/engine_app/engine_host.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/host/fake_audio_device.hpp"
#include "siann/host/fake_callback_clock.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/ix_transport.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/session/journal.hpp"
#include "siann/session/session.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <stdlib.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace siann::engine_app {

namespace fs = std::filesystem;
using json::Object;
using json::Value;

namespace {

constexpr const char* kFakeDevice = "fake";

struct Options {
    fs::path session;
    std::string host = "127.0.0.1";
    std::uint16_t port = 0;
    bool mcpTrusted = false;
    std::uintptr_t ownerWindow = 0;
    std::optional<std::string> device;
    std::optional<std::int64_t> fakeCallbackNanos;
    std::optional<int> fakeOpenFailures;
    std::optional<DeviceBackoff> deviceBackoff;
    std::vector<std::string> pluginDirs;  // UTF-8, absolute
    fs::path pluginRegistry;
    // Test-only: serve with no stop flag (spec, "Process model"; m5-shell-hardening).
    bool testWedge = false;
};

std::string environmentValue(const char* name) {
#if defined(_MSC_VER)
    char* value = nullptr;
    std::size_t size = 0;
    if (_dupenv_s(&value, &size, name) != 0 || value == nullptr) {
        return {};
    }
    std::string result(value);
    std::free(value);
    return result;
#else
    const char* value = std::getenv(name);
    return value == nullptr ? std::string() : std::string(value);
#endif
}

fs::path pathFromUtf8(const std::string& text) {
    return fs::path(std::u8string(text.begin(), text.end()));
}

// As siann-cli: positive, and at most host::kMaxFakeCallbackNanos.
std::int64_t parseCallbackNanos(const std::string& text) {
    std::int64_t parsed = 0;
    const char* end = text.data() + text.size();
    const auto [next, error] = std::from_chars(text.data(), end, parsed);
    if (error != std::errc() || next != end || parsed <= 0 || parsed > host::kMaxFakeCallbackNanos) {
        throw LaunchError("usage", "--fake-callback-nanos must be an integer from 1 to " +
                                       std::to_string(host::kMaxFakeCallbackNanos));
    }
    return parsed;
}

int parseOpenFailures(const std::string& text) {
    int parsed = 0;
    const char* end = text.data() + text.size();
    const auto [next, error] = std::from_chars(text.data(), end, parsed);
    if (error != std::errc() || next != end || parsed < 0) {
        throw LaunchError("usage", "--fake-open-failures must be a non-negative integer");
    }
    return parsed;
}

// <initialMs>:<maxMs>:<resetAfterMs>, each at most a day, the maximum not below the
// initial delay. Zero is allowed, as the shell's SIANN_SHELL_BACKOFF_MS allows it.
DeviceBackoff parseBackoff(const std::string& text) {
    constexpr std::int64_t kMaxMs = 86'400'000;
    std::int64_t parts[3] = {};
    const char* cursor = text.data();
    const char* end = text.data() + text.size();
    bool valid = true;
    for (int i = 0; valid && i < 3; ++i) {
        const auto [next, error] = std::from_chars(cursor, end, parts[i]);
        valid = error == std::errc() && parts[i] >= 0 && parts[i] <= kMaxMs &&
                (i < 2 ? next != end && *next == ':' : next == end);
        cursor = next + 1;
    }
    if (!valid || parts[1] < parts[0]) {
        throw LaunchError("usage", "--device-backoff must be <initialMs>:<maxMs>:<resetAfterMs>, in milliseconds");
    }
    return {std::chrono::milliseconds(parts[0]), std::chrono::milliseconds(parts[1]),
            std::chrono::milliseconds(parts[2])};
}

Options parseOptions(const std::vector<std::string>& args) {
    Options options;
    bool haveSession = false;
    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& arg = args[i];
        const auto value = [&]() -> const std::string& {
            if (i + 1 >= args.size()) {
                throw LaunchError("usage", arg + " needs a value");
            }
            return args[++i];
        };
        if (arg == "--session") {
            options.session = pathFromUtf8(value());
            haveSession = true;
        } else if (arg == "--host") {
            options.host = value();
        } else if (arg == "--port") {
            const std::string& text = value();
            std::size_t used = 0;
            unsigned long parsed = 0;
            try {
                parsed = std::stoul(text, &used);
            } catch (const std::exception&) {
                used = 0;
            }
            if (used == 0 || used != text.size() || parsed > 65'535) {
                throw LaunchError("usage", "--port must be an integer from 0 to 65535");
            }
            options.port = static_cast<std::uint16_t>(parsed);
        } else if (arg == "--mcp-trusted") {
            options.mcpTrusted = true;
        } else if (arg == "--owner-window") {
            const std::string& text = value();
            std::size_t used = 0;
            unsigned long long parsed = 0;
            try {
                parsed = std::stoull(text, &used);
            } catch (const std::exception&) {
                used = 0;
            }
            if (used == 0 || used != text.size()) {
                throw LaunchError("usage", "--owner-window must be a native window handle, in decimal");
            }
            options.ownerWindow = static_cast<std::uintptr_t>(parsed);
        } else if (arg == "--device") {
            options.device = value();
        } else if (arg == "--fake-callback-nanos") {
            options.fakeCallbackNanos = parseCallbackNanos(value());
        } else if (arg == "--fake-open-failures") {
            options.fakeOpenFailures = parseOpenFailures(value());
        } else if (arg == "--device-backoff") {
            options.deviceBackoff = parseBackoff(value());
        } else if (arg == "--plugin-dir") {
            options.pluginDirs.push_back(value());
        } else if (arg == "--plugin-registry") {
            options.pluginRegistry = pathFromUtf8(value());
        } else if (arg == "--test-wedge") {
            options.testWedge = true;
        } else {
            throw LaunchError("usage", "unknown option " + arg +
                                           "; usage: siann-engine --session <bundle> [--host 127.0.0.1] [--port 0] "
                                           "[--mcp-trusted] [--owner-window <handle>] "
                                           "[--device <id>] [--device-backoff <initialMs>:<maxMs>:<resetAfterMs>] "
                                           "[--fake-callback-nanos N] [--fake-open-failures N] "
                                           "[--plugin-dir <dir>]... [--plugin-registry <file>] [--test-wedge]");
        }
    }
    if (!haveSession || options.session.empty()) {
        throw LaunchError("usage", "--session <bundle> is required");
    }
    if (options.fakeCallbackNanos && options.device != kFakeDevice) {
        throw LaunchError("usage", "--fake-callback-nanos needs --device fake");
    }
    if (options.fakeOpenFailures && options.device != kFakeDevice) {
        throw LaunchError("usage", "--fake-open-failures needs --device fake");
    }
    // A plugin directory holds code the engine may run: never a share, never the
    // session's own bundle (Protocol v0 item 21).
    for (std::string& dir : options.pluginDirs) {
        if (const auto refused = model::pluginPathRefusal(dir, options.session)) {
            throw LaunchError("usage", "--plugin-dir " + dir + " is refused (" + *refused + ")");
        }
        std::error_code ec;
        const fs::path absolute = fs::absolute(pathFromUtf8(dir), ec);
        if (!ec) {
            const std::u8string text = absolute.lexically_normal().u8string();
            dir.assign(text.begin(), text.end());
        }
    }
    // Only a shell under test (which passes SIANN_SHELL_TEST=1 on) may wedge an engine.
    if (options.testWedge && environmentValue("SIANN_SHELL_TEST") != "1") {
        throw LaunchError("usage", "--test-wedge needs SIANN_SHELL_TEST=1 in the environment");
    }
    return options;
}

// --device fake: a paced software device with loopback, reporting one buffer of
// input and output latency, as siann-cli's. Anything else is the build's real
// device; a build or machine without one leaves deviceError for the host to report.
// engine.devices lists fake and the build's hardware devices; engine.select_device
// makes either kind the same way (Protocol v0 item 22).
EngineHostOptions hostOptions(const Options& options, std::ostream& err) {
    EngineHostOptions chosen;
    chosen.deviceId = options.device.value_or("");
    chosen.backoff = options.deviceBackoff.value_or(DeviceBackoff{});
    chosen.ownerWindow = options.ownerWindow;
    chosen.pluginDirs = options.pluginDirs;
    chosen.pluginRegistryFile = options.pluginRegistry;
    chosen.diagnostic = [&err](const std::string& line) {
        err << "siann-engine: " << line << "\n";
        err.flush();
    };
    host::FakeAudioDevice::Options fake;
    fake.paced = true;
    fake.loopback = true;
    fake.inputLatencyFrames = chosen.bufferFrames;
    fake.outputLatencyFrames = chosen.bufferFrames;
    // One budget for every fake handle: a selection makes a new one, and the device
    // stays held for N opens in all, whichever handle tries.
    fake.sharedRefusals = std::make_shared<std::atomic<int>>(options.fakeOpenFailures.value_or(0));
    chosen.listDevices = [] {
        std::vector<protocol::DeviceDescription> listed{{kFakeDevice, kFakeDevice, kFakeDevice, false, false}};
        for (protocol::DeviceDescription& one : listHardwareDevices()) {
            listed.push_back(std::move(one));
        }
        return listed;
    };
    chosen.deviceFactory = [fake](const std::string& id) -> std::unique_ptr<host::AudioDevice> {
        if (id == kFakeDevice) {
            return std::make_unique<host::FakeAudioDevice>(fake);
        }
        return hardwareDevice();
    };
    if (options.device == kFakeDevice) {
        chosen.device = std::make_unique<host::FakeAudioDevice>(fake);
        if (options.fakeCallbackNanos) {
            host::setFakeCallbackNanos(*options.fakeCallbackNanos);
            chosen.playback.callbackClock = &host::fakeCallbackClock;
        }
        return chosen;
    }
    try {
        chosen.device = hardwareDevice();
    } catch (const host::DeviceError& error) {
        chosen.deviceError = protocol::DeviceProblem{error.code(), error.what()};
    }
    return chosen;
}

std::string nowUtc() {
    const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buffer;
}

// Opens the bundle, or creates an empty session named after it when the
// directory does not exist (spec, "Process model": session at launch).
session::Session openOrCreate(const fs::path& bundle) {
    std::error_code ec;
    const fs::file_status status = fs::status(bundle, ec);
    if (fs::exists(status)) {
        if (!fs::is_directory(status)) {
            throw LaunchError("invalid_session", "--session names a file, not a session bundle directory");
        }
        return session::Session::open(bundle);
    }
    if (bundle.has_parent_path()) {
        fs::create_directories(bundle.parent_path());
    }
    const std::u8string stem = bundle.stem().u8string();
    return session::Session::create(bundle, model::Document::create(std::string(stem.begin(), stem.end()), 48'000, 120'000),
                                    "siann-engine", nowUtc());
}

long processId() {
#if defined(_WIN32)
    return static_cast<long>(GetCurrentProcessId());
#else
    return static_cast<long>(getpid());
#endif
}

// Canonical JSON throws on bytes that are not UTF-8 (an exception message with
// a Windows path in the ANSI code page); each such byte becomes U+FFFD.
std::string validUtf8(const std::string& text) {
    std::string out;
    std::size_t pos = 0;
    while (pos < text.size()) {
        const auto byte = [&](std::size_t i) { return static_cast<unsigned char>(text[pos + i]); };
        const unsigned char first = byte(0);
        std::size_t length = 0;
        unsigned char low = 0x80;
        unsigned char high = 0xBF;
        if (first < 0x80) {
            length = 1;
        } else if (first >= 0xC2 && first <= 0xDF) {
            length = 2;
        } else if (first >= 0xE0 && first <= 0xEF) {
            length = 3;
            low = first == 0xE0 ? 0xA0 : 0x80;
            high = first == 0xED ? 0x9F : 0xBF;
        } else if (first >= 0xF0 && first <= 0xF4) {
            length = 4;
            low = first == 0xF0 ? 0x90 : 0x80;
            high = first == 0xF4 ? 0x8F : 0xBF;
        }
        bool valid = length > 0 && pos + length <= text.size();
        if (valid && length > 1) {
            valid = byte(1) >= low && byte(1) <= high;
            for (std::size_t i = 2; valid && i < length; ++i) {
                valid = byte(i) >= 0x80 && byte(i) <= 0xBF;
            }
        }
        if (valid) {
            out.append(text, pos, length);
            pos += length;
        } else {
            out += "\xEF\xBF\xBD";
            ++pos;
        }
    }
    return out;
}

void writeError(std::ostream& err, const std::string& code, const std::string& message) {
    err << jcs::canonicalize(Value(Object{{"ok", Value(false)},
                                          {"error", Value(Object{{"code", Value(validUtf8(code))},
                                                                 {"message", Value(validUtf8(message))}})}}))
        << "\n";
    err.flush();
}

}  // namespace

void disableCrashDialogs() {
#if defined(_WIN32)
    SetErrorMode(GetErrorMode() | SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    _set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
#endif
}

int runEngine(const std::vector<std::string>& args, std::ostream& out, std::ostream& err,
              const std::atomic<bool>* stop) {
    try {
        const Options options = parseOptions(args);
        MainThread mainThread;
        // Stable while served; session.open replaces it (Protocol v0 item 22).
        auto served = std::make_unique<session::Session>(openOrCreate(options.session));

        EngineHost host(*served, hostOptions(options, err));

        // No pump thread: this thread is the command and control thread.
        protocol::ServerOptions serverOptions;
        serverOptions.host = options.host;
        serverOptions.port = options.port;
        serverOptions.pumpThread = false;
        serverOptions.actor = "siann-engine";
        serverOptions.mcpScope = options.mcpTrusted ? protocol::McpScope::trusted : protocol::McpScope::propose;
        serverOptions.transportPort = &host;
        serverOptions.pluginPort = &host;
        serverOptions.gesturePort = &host;
        serverOptions.auditionPort = host.auditionPort();
        // The new bundle is opened (and locked) first, so a refusal changes nothing;
        // the old one is released once the host plays the new one.
        serverOptions.openSession = [&served, &host](const fs::path& path) -> session::Session& {
            auto next = std::make_unique<session::Session>(session::Session::open(path));
            host.rebind(*next);
            served = std::move(next);
            return *served;
        };
        protocol::IxTransport transport;
        protocol::ProtocolServer server(transport, *served, serverOptions);
        host.attachPublisher(server.realtime(), server.events());
        server.start();

        // The launcher handshake: exactly one line, and nothing else on out.
        out << jcs::canonicalize(Value(Object{{"schema", Value(std::string(kReadySchema))},
                                              {"port", Value(static_cast<double>(server.port()))},
                                              {"token", Value(server.token())},
                                              {"mcpToken", Value(server.mcpToken())},
                                              {"sessionId", Value(server.sessionId())},
                                              {"pid", Value(static_cast<double>(processId()))},
                                              {"about", protocol::aboutJson()}}))
            << "\n";
        out.flush();

        // --test-wedge: no stop flag, so neither stdin EOF nor SIGTERM ends it.
        mainThread.serve(options.testWedge ? nullptr : stop, [&server, &host, &err] {
            try {
                server.pump();
                host.tick();
            } catch (const std::exception& error) {
                // Methods answer their own exceptions; this keeps the engine up
                // if sending or caching throws (bad_alloc, say).
                err << "siann-engine: tick failed: " << validUtf8(error.what()) << "\n";
                err.flush();
            }
        });
        // No client after this, then the device, on the thread that opened it.
        server.stop();
        host.shutdown();
        return 0;
    } catch (const LaunchError& error) {
        writeError(err, error.code(), error.what());
    } catch (const session::SessionError& error) {
        writeError(err, error.code(), error.what());
    } catch (const std::exception& error) {
        writeError(err, "internal_error", error.what());
    } catch (...) {
        writeError(err, "internal_error", "unknown exception");
    }
    return 1;
}

}  // namespace siann::engine_app
