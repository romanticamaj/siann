// The siann-engine executable and its launcher handshake (m0-electron-shell;
// spec, Protocol v0 item 17). The tests run the real executable as a child
// with piped stdin, stdout and stderr, as the Electron shell does: they read
// the ready line, talk to the server it names over loopback, close stdin and
// wait on the process exit. No sleeps: waits are on the process, the pipes
// and socket replies, each bounded.
//
// A SIANN_WITH_JUCE build also hosts plugins (m0-plugin-hosting): the same tests
// run against an engine serving from the JUCE message loop, and the editor tests
// below open siann_test_plugin in it.
//
// The engine runs the graph driver on a device (m4-engine-device). These tests pass
// --device fake unless the device is what they test, so nothing here depends on a
// runner's audio hardware. Waits on the transport read frames or status replies, each
// bounded by a count.

#include <catch2/catch_test_macros.hpp>

#include <atomic>
#include <cctype>
#include <cstdlib>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <future>
#include <optional>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include <ixwebsocket/IXNetSystem.h>

#include "live_rig.hpp"
#include "siann/command/history.hpp"
#include "siann/engine_app/engine.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/realtime_channel.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"
#include "support/piped_process.hpp"
#include "support/ws_clients.hpp"

#if defined(_WIN32) && defined(SIANN_ENGINE_WITH_JUCE)
#include <windows.h>
#endif

#ifndef SIANN_ENGINE_EXE
#define SIANN_ENGINE_EXE "siann-engine"  // set by CMake; the fallback keeps a plain syntax check building
#endif

using namespace siann;
using engine_app::test::PipedProcess;
using json::Object;
using json::Value;
using protocol::MeterFrame;
using protocol::testing::McpClient;
using protocol::testing::RealtimeClient;
using protocol::testing::WsClient;

namespace {

namespace fs = std::filesystem;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = fs::temp_directory_path() / ("siann-engine-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        fs::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        fs::remove_all(path_, ec);
    }
    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;
    const fs::path& path() const { return path_; }

private:
    fs::path path_;
};

std::string utf8(const fs::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

const Value& at(const Value& object, const char* key) {
    const Value* member = object.find(key);
    INFO("missing member " << key);
    REQUIRE(member != nullptr);
    return *member;
}

bool lowerHex64(const std::string& text) {
    if (text.size() != 64) {
        return false;
    }
    for (const char c : text) {
        if (!(std::isdigit(static_cast<unsigned char>(c)) || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

// Without --device: the build's default device, or none.
std::vector<std::string> bareArgs(const fs::path& bundle) {
    return {"--session", utf8(bundle), "--port", "0"};
}

std::vector<std::string> launchArgs(const fs::path& bundle, bool trusted = false) {
    std::vector<std::string> args{"--session", utf8(bundle), "--port", "0", "--device", "fake"};
    if (trusted) {
        args.push_back("--mcp-trusted");
    }
    return args;
}

// The ready line, parsed with the strict parser.
Value readyLine(PipedProcess& child) {
    const std::optional<std::string> line = child.firstLine();
    INFO("stderr: " << (line ? std::string() : child.stderrText()));
    REQUIRE(line.has_value());
    return json::parse(*line);
}

std::string authFrame(const std::string& token) {
    return jcs::canonicalize(Value(Object{{"type", Value("auth")}, {"token", Value(token)}}));
}

// Closes stdin (the launcher stopping the engine) and waits for the exit.
int stopEngine(PipedProcess& child) {
    child.closeStdin();
    return child.wait();
}

std::vector<std::string> withArgs(std::vector<std::string> args, const std::vector<std::string>& more) {
    args.insert(args.end(), more.begin(), more.end());
    return args;
}

// The last line of stderr: JUCE and hosted plugins may print before it.
Value errorLine(PipedProcess& child) {
    const std::string err = child.stderrText();
    INFO("stderr: " << err);
    const std::string trimmed = err.substr(0, err.find_last_not_of("\r\n") + 1);
    return json::parse(trimmed.substr(trimmed.rfind('\n') + 1));
}

std::string errorCode(PipedProcess& child) {
    return at(at(errorLine(child), "error"), "code").asString();
}

// A closed bundle with two tracks of WAV media.
void writeBundle(const fs::path& bundle, const fs::path& scratch) {
    session::Session s =
        session::Session::create(bundle, model::Document::create("Song", 48'000), "test", "2026-11-07T00:00:00Z");
    const fs::path wav = scratch / "tone.wav";
    io::writeFileAtomic(wav, media::encodeWavFloat32(live_rig::distinct(2, 480'000)));
    session::importMedia(s, wav, "med_st", "test", "2026-11-07T00:00:00Z");
    for (const std::string& json : {live_rig::addTrack("trk_a"), live_rig::addTrack("trk_b"),
                                    live_rig::place("clp_a", "trk_a", "med_st", 0, 0, 480'000),
                                    live_rig::place("clp_b", "trk_b", "med_st", 1'000, 0, 400'000)}) {
        s.commit({live_rig::cmd(json)}, "test", "2026-11-07T00:00:00Z");
    }
}

// A client of a running engine: the command socket and the realtime socket.
class EngineClient {
public:
    explicit EngineClient(const Value& ready)
        : port_(static_cast<std::uint16_t>(at(ready, "port").asNumber())), ws_(port_), realtime_(port_) {
        REQUIRE(ws_.start());
        const std::string token = at(ready, "token").asString();
        REQUIRE(at(ws_.call(authFrame(token)), "ok").asBool());
        sessionId_ = at(ready, "sessionId").asString();
        REQUIRE(realtime_.start(token));
    }

    Value call(const std::string& method, Value params = Value(Object{})) {
        return ws_.call(jcs::canonicalize(Value(Object{{"requestId", Value("req_" + std::to_string(++next_))},
                                                       {"sessionId", Value(sessionId_)},
                                                       {"method", Value(method)},
                                                       {"params", std::move(params)}})));
    }

    Value ok(const std::string& method, Value params = Value(Object{})) {
        const Value response = call(method, std::move(params));
        INFO(method << ": " << jcs::canonicalize(response));
        REQUIRE(at(response, "ok").asBool());
        return at(response, "result");
    }

    std::string errorOf(const std::string& method, Value params = Value(Object{})) {
        const Value response = call(method, std::move(params));
        INFO(method << ": " << jcs::canonicalize(response));
        REQUIRE_FALSE(at(response, "ok").asBool());
        return at(at(response, "error"), "code").asString();
    }

    MeterFrame frame() {
        const std::optional<MeterFrame> next = realtime_.next();
        REQUIRE(next.has_value());
        return *next;
    }

    // The first of the next frames that `wanted` accepts; at most kFrameBound read.
    template <class Predicate>
    MeterFrame frameWhere(Predicate wanted) {
        for (int i = 0; i < kFrameBound; ++i) {
            MeterFrame candidate = frame();
            if (wanted(candidate)) {
                return candidate;
            }
        }
        FAIL("no such frame in " << kFrameBound << " frames");
        return {};
    }

    // engine.status once it shows a device; at most kFrameBound replies read, each a
    // tick apart.
    Value waitForDevice() {
        for (int i = 0; i < kFrameBound; ++i) {
            Value status = ok("engine.status");
            if (at(status, "device").kind() == Value::Kind::object) {
                return status;
            }
        }
        FAIL("no device after " << kFrameBound << " status replies");
        return Value();
    }

    // Two consecutive frames, playing, the second further on.
    void waitAdvancing() {
        MeterFrame last = frameWhere([](const MeterFrame& f) { return f.playing; });
        for (int i = 0; i < kFrameBound; ++i) {
            const MeterFrame current = frame();
            if (current.playing && last.playing && current.playheadSamples > last.playheadSamples) {
                return;
            }
            last = current;
        }
        FAIL("the playhead did not advance in " << kFrameBound << " frames");
    }

private:
    static constexpr int kFrameBound = 3'000;

    std::uint16_t port_;
    WsClient ws_;
    RealtimeClient realtime_;
    std::string sessionId_;
    int next_ = 0;
};

std::uint64_t decimalOf(const Value& status, const char* key) {
    return std::stoull(at(status, key).asString());
}

#if defined(SIANN_ENGINE_WITH_JUCE)

bool displayAvailable() {
#if defined(__linux__)
    return std::getenv("DISPLAY") != nullptr;
#else
    return true;
#endif
}

#if defined(_WIN32)

// The Electron window's part: a top-level window in another process, on a thread
// that pumps, because an owner and its windows share an input queue.
class OwnerWindow {
public:
    OwnerWindow() {
        std::promise<HWND> created;
        auto window = created.get_future();
        thread_ = std::thread([this, &created] {
            threadId_.store(GetCurrentThreadId());
            HWND hwnd = CreateWindowExW(0, L"STATIC", L"SIANN test owner", WS_OVERLAPPEDWINDOW, 0, 0, 100, 100, nullptr,
                                        nullptr, GetModuleHandleW(nullptr), nullptr);
            created.set_value(hwnd);
            MSG message;
            while (GetMessageW(&message, nullptr, 0, 0) > 0) {
                DispatchMessageW(&message);
            }
            DestroyWindow(hwnd);
        });
        hwnd_ = window.get();
    }
    ~OwnerWindow() {
        PostThreadMessageW(threadId_.load(), WM_QUIT, 0, 0);
        thread_.join();
    }
    OwnerWindow(const OwnerWindow&) = delete;
    OwnerWindow& operator=(const OwnerWindow&) = delete;

    HWND hwnd() const { return hwnd_; }
    std::string handleArgument() const { return std::to_string(reinterpret_cast<std::uintptr_t>(hwnd_)); }

private:
    std::thread thread_;
    std::atomic<DWORD> threadId_{0};
    HWND hwnd_ = nullptr;
};

struct OwnedWindowSearch {
    DWORD process = 0;
    HWND owner = nullptr;
    HWND found = nullptr;
};

BOOL CALLBACK findOwnedWindow(HWND window, LPARAM parameter) {
    auto& search = *reinterpret_cast<OwnedWindowSearch*>(parameter);
    DWORD process = 0;
    GetWindowThreadProcessId(window, &process);
    if (process == search.process && GetWindow(window, GW_OWNER) == search.owner) {
        search.found = window;
        return FALSE;
    }
    return TRUE;
}

// The window of `process` that `owner` owns; nullptr when there is none.
HWND ownedWindow(long process, HWND owner) {
    OwnedWindowSearch search{static_cast<DWORD>(process), owner, nullptr};
    EnumWindows(findOwnedWindow, reinterpret_cast<LPARAM>(&search));
    return search.found;
}

#endif  // _WIN32
#endif  // SIANN_ENGINE_WITH_JUCE

}  // namespace

TEST_CASE("siann-engine prints one ready line and serves the token handshake", "[engine][launch]") {
    ix::initNetSystem();
    TempDir dir;
    PipedProcess child(SIANN_ENGINE_EXE, launchArgs(dir.path() / "Song.siann"));
    const std::optional<std::string> line = child.firstLine();
    INFO("stderr: " << (line ? std::string() : child.stderrText()));
    REQUIRE(line.has_value());
    const Value ready = json::parse(*line);

    CHECK(at(ready, "schema").asString() == engine_app::kReadySchema);
    const auto port = static_cast<std::uint16_t>(at(ready, "port").asNumber());
    CHECK(port != 0);
    const std::string token = at(ready, "token").asString();
    const std::string mcpToken = at(ready, "mcpToken").asString();
    CHECK(lowerHex64(token));
    CHECK(lowerHex64(mcpToken));
    CHECK(token != mcpToken);
    const std::string sessionId = at(ready, "sessionId").asString();
    CHECK(sessionId.rfind("ses_", 0) == 0);
    CHECK(static_cast<long>(at(ready, "pid").asNumber()) == child.pid());
    CHECK(at(at(ready, "about"), "name").asString() == protocol::buildInfo().name);

    {
        WsClient ws(port);
        REQUIRE(ws.start());
        const Value reply = ws.call(authFrame(token));
        CHECK(at(reply, "type").asString() == "auth");
        CHECK(at(reply, "ok").asBool());
        CHECK(at(reply, "sessionId").asString() == sessionId);
    }
    {
        // The MCP token is not the UI credential.
        WsClient wrong(port);
        REQUIRE(wrong.start());
        const Value reply = wrong.call(authFrame(mcpToken));
        CHECK_FALSE(at(reply, "ok").asBool());
        CHECK(at(at(reply, "error"), "code").asString() == "invalid_token");
        CHECK(wrong.waitClosed());
    }

    CHECK(stopEngine(child) == 0);
    CHECK(child.stdoutText() == *line + "\n");
}

TEST_CASE("a missing bundle directory is created as a new session", "[engine][launch]") {
    ix::initNetSystem();
    TempDir dir;
    const fs::path bundle = dir.path() / "New Song.siann";
    REQUIRE_FALSE(fs::exists(bundle));

    std::string revision;
    std::string documentHash;
    {
        PipedProcess child(SIANN_ENGINE_EXE, launchArgs(bundle));
        const Value ready = readyLine(child);
        CHECK(fs::is_directory(bundle));
        WsClient ws(static_cast<std::uint16_t>(at(ready, "port").asNumber()));
        REQUIRE(ws.start());
        const Value reply = ws.call(authFrame(at(ready, "token").asString()));
        REQUIRE(at(reply, "ok").asBool());
        revision = at(reply, "revision").asString();
        documentHash = at(reply, "documentHash").asString();
        CHECK(stopEngine(child) == 0);
    }

    // The bundle on disk is that new session: its head is the served one, and
    // it holds one revision (the created document, named after the bundle).
    {
        const session::Session opened = session::Session::open(bundle);
        CHECK(opened.history().head().envelope.id == revision);
        CHECK(hash::formatHash(opened.history().head().envelope.documentHash) == documentHash);
        CHECK(opened.history().head().document.root().name == "New Song");
    }

    // A second launch opens it instead of creating another.
    PipedProcess again(SIANN_ENGINE_EXE, launchArgs(bundle));
    const Value ready = readyLine(again);
    WsClient ws(static_cast<std::uint16_t>(at(ready, "port").asNumber()));
    REQUIRE(ws.start());
    const Value reply = ws.call(authFrame(at(ready, "token").asString()));
    REQUIRE(at(reply, "ok").asBool());
    CHECK(at(reply, "revision").asString() == revision);
    CHECK(at(reply, "documentHash").asString() == documentHash);
    CHECK(stopEngine(again) == 0);
}

TEST_CASE("the --mcp-trusted flag sets the MCP scope", "[engine][launch][mcp]") {
    ix::initNetSystem();
    TempDir dir;
    for (const bool trusted : {true, false}) {
        INFO("trusted: " << trusted);
        PipedProcess child(SIANN_ENGINE_EXE, launchArgs(dir.path() / "Song.siann", trusted));
        const Value ready = readyLine(child);
        McpClient mcp(static_cast<std::uint16_t>(at(ready, "port").asNumber()), at(ready, "mcpToken").asString());
        mcp.initialize();
        const Value capabilities = mcp.ok("describe_capabilities");
        CHECK(at(capabilities, "scope").asString() == (trusted ? "trusted" : "propose"));
        CHECK(stopEngine(child) == 0);
    }
}

TEST_CASE("a bad --session exits 1 with a JSON error on stderr and nothing on stdout", "[engine][launch]") {
    TempDir dir;
    const fs::path file = dir.path() / "Song.siann";
    {
        std::ofstream(file) << "not a bundle";
    }
    const std::vector<std::vector<std::string>> launches{
        {"--session", utf8(file), "--port", "0"},  // an existing file
        {"--port", "0"},                            // no --session
        {"--session", utf8(dir.path() / "Other.siann"), "--port", "seventy"},
        {"--session", utf8(dir.path() / "Other.siann"), "--frobnicate"},
        {"--session", utf8(dir.path() / "Other.siann"), "--owner-window", "the big one"},
        {"--session", utf8(dir.path() / "Other.siann"), "--owner-window"},
        {"--session", utf8(dir.path() / "Other.siann"), "--open-editor"},
        // M4 removed the flag: plugin.open_editor opens editors now.
        {"--session", utf8(dir.path() / "Other.siann"), "--open-editor", "x.vst3"},
    };
    for (const auto& args : launches) {
        INFO("args: " << args.back());
        PipedProcess child(SIANN_ENGINE_EXE, args);
        CHECK(child.wait() == 1);
        CHECK(child.stdoutText().empty());
        const Value error = errorLine(child);
        CHECK_FALSE(at(error, "ok").asBool());
        CHECK_FALSE(at(at(error, "error"), "code").asString().empty());
        CHECK(at(at(error, "error"), "message").kind() == json::Value::Kind::string);
    }
    // Nothing was created for the rejected launches.
    CHECK_FALSE(fs::exists(dir.path() / "Other.siann"));
}

TEST_CASE("a client on the fake device plays, sees an advancing playhead in binary frames, locates and stops",
          "[engine][transport]") {
    ix::initNetSystem();
    TempDir dir;
    const fs::path bundle = dir.path() / "Song.siann";
    writeBundle(bundle, dir.path());

    PipedProcess child(SIANN_ENGINE_EXE, launchArgs(bundle));
    const std::optional<std::string> line = child.firstLine();
    REQUIRE(line.has_value());
    const Value ready = json::parse(*line);
    {
        EngineClient client(ready);

        // The session's graph is live on the device; nothing plays yet.
        const Value idle = client.ok("engine.status");
        CHECK(at(at(idle, "device"), "id").asString() == "fake");
        CHECK(at(at(idle, "device"), "sampleRate").asNumber() == 48'000);
        CHECK(at(at(idle, "device"), "bufferFrames").asNumber() == 256);
        CHECK_FALSE(at(idle, "playing").asBool());
        CHECK(client.frameWhere([](const MeterFrame&) { return true; }).playheadSamples == 0);

        const Value played = client.ok("transport.play");
        CHECK(at(played, "playing").asBool());
        client.waitAdvancing();
        // The graph has the session's tracks: both meter, and they carry sound.
        const MeterFrame metered = client.frameWhere([](const MeterFrame& f) {
            return f.playing && f.entries.size() == 3 && f.entries[0].peak[0] > 0.0f;
        });
        CHECK(metered.epoch != 0);

        const Value located = client.ok("transport.locate", Value(Object{{"frames", Value("96000")}}));
        CHECK(at(located, "position").asString() == "96000");
        client.frameWhere([](const MeterFrame& f) { return f.playheadSamples >= 96'000; });
        client.waitAdvancing();

        const Value stopped = client.ok("transport.stop");
        CHECK_FALSE(at(stopped, "playing").asBool());
        MeterFrame last = client.frameWhere([](const MeterFrame& f) { return !f.playing; });
        const MeterFrame frozen = client.frameWhere([&last](const MeterFrame& f) {
            const bool same = f.playheadSamples == last.playheadSamples;
            last = f;
            return same;
        });
        CHECK_FALSE(frozen.playing);
        CHECK(frozen.playheadSamples >= 96'000);

        const Value status = client.ok("engine.status");
        CHECK(at(status, "device").kind() == Value::Kind::object);
        CHECK_FALSE(at(status, "playing").asBool());
        CHECK(at(status, "xruns").kind() == Value::Kind::string);
        CHECK(at(status, "maxCallbackMicros").kind() == Value::Kind::number);
        CHECK(at(status, "unmeasuredCallbacks").asString() == "0");
    }
    CHECK(stopEngine(child) == 0);
    CHECK(child.stdoutText() == *line + "\n");
}

TEST_CASE("a known deadline miss reaches a client", "[engine][transport]") {
    ix::initNetSystem();
    TempDir dir;
    SECTION("every callback over its 5.3 ms period") {
        PipedProcess child(SIANN_ENGINE_EXE,
                           withArgs(launchArgs(dir.path() / "Miss.siann"), {"--fake-callback-nanos", "20000000"}));
        const Value ready = readyLine(child);
        EngineClient client(ready);
        client.ok("transport.play");
        client.waitAdvancing();
        const Value first = client.ok("engine.status");
        CHECK(decimalOf(first, "xruns") > 0);
        CHECK(at(first, "maxCallbackMicros").asNumber() == 20'000.0);
        CHECK(at(first, "unmeasuredCallbacks").asString() == "0");
        // A count that keeps growing, not a flag.
        bool grew = false;
        for (int i = 0; i < 3'000 && !grew; ++i) {
            grew = decimalOf(client.ok("engine.status"), "xruns") > decimalOf(first, "xruns");
        }
        CHECK(grew);
        CHECK(stopEngine(child) == 0);
    }
    SECTION("every callback within its period") {
        PipedProcess child(SIANN_ENGINE_EXE,
                           withArgs(launchArgs(dir.path() / "Fine.siann"), {"--fake-callback-nanos", "1000000"}));
        const Value ready = readyLine(child);
        EngineClient client(ready);
        client.ok("transport.play");
        client.waitAdvancing();  // callbacks have run
        const Value status = client.ok("engine.status");
        CHECK(at(status, "xruns").asString() == "0");
        CHECK(at(status, "maxCallbackMicros").asNumber() == 1'000.0);
        CHECK(stopEngine(child) == 0);
    }
}

// Not named after the flag: a test name starting with -- reads as an option to
// the test runner under ctest.
TEST_CASE("a fake callback time needs the fake device and sane bounds", "[engine][transport]") {
    TempDir dir;
    const fs::path bundle = dir.path() / "Song.siann";
    const std::vector<std::vector<std::string>> launches{
        {"--session", utf8(bundle), "--fake-callback-nanos", "20000000"},
        {"--session", utf8(bundle), "--device", "ASIO/Any", "--fake-callback-nanos", "20000000"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-callback-nanos", "0"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-callback-nanos", "-1"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-callback-nanos", "soon"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-callback-nanos", "1000000000001"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-callback-nanos"},
        {"--session", utf8(bundle), "--device"},
        {"--session", utf8(bundle), "--fake-open-failures", "2"},
        {"--session", utf8(bundle), "--device", "ASIO/Any", "--fake-open-failures", "2"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-open-failures", "-1"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-open-failures", "many"},
        {"--session", utf8(bundle), "--device", "fake", "--fake-open-failures"},
        {"--session", utf8(bundle), "--device-backoff", "250:10000"},
        {"--session", utf8(bundle), "--device-backoff", "250:10000:30000:1"},
        {"--session", utf8(bundle), "--device-backoff", "soon:10000:30000"},
        {"--session", utf8(bundle), "--device-backoff", "250:-1:30000"},
        {"--session", utf8(bundle), "--device-backoff", "500:250:30000"},
        {"--session", utf8(bundle), "--device-backoff", "1:2:99999999999"},
        {"--session", utf8(bundle), "--device-backoff"},
    };
    for (const auto& args : launches) {
        INFO("args: " << args.back());
        PipedProcess child(SIANN_ENGINE_EXE, args);
        CHECK(child.wait() == 1);
        CHECK(child.stdoutText().empty());
        CHECK(errorCode(child) == "usage");
    }
    CHECK_FALSE(fs::exists(bundle));
}

TEST_CASE("without a device the engine still starts and serves", "[engine][transport]") {
    ix::initNetSystem();
    TempDir dir;
#if defined(SIANN_ENGINE_WITH_JUCE)
    const std::vector<std::string> args =
        withArgs(bareArgs(dir.path() / "Song.siann"), {"--device", "No Such Type/No Such Device"});
#else
    const std::vector<std::string> args = bareArgs(dir.path() / "Song.siann");
#endif
    PipedProcess child(SIANN_ENGINE_EXE, args);
    const std::optional<std::string> line = child.firstLine();
    REQUIRE(line.has_value());
    const Value ready = json::parse(*line);
    {
        EngineClient client(ready);
        CHECK(at(client.ok("session.inspect"), "revisions").asNumber() == 1);

        const Value status = client.ok("engine.status");
        CHECK(at(status, "device").kind() == Value::Kind::null);
        const std::string code = at(at(status, "deviceError"), "code").asString();
#if defined(SIANN_ENGINE_WITH_JUCE)
        CHECK((code == "no_device" || code == "device_open_failed"));
#else
        CHECK(code == "no_audio_backend");
#endif
        CHECK_FALSE(at(at(status, "deviceError"), "message").asString().empty());
        CHECK_FALSE(at(status, "playing").asBool());

        CHECK(client.errorOf("transport.play") == "no_device");
        CHECK(client.errorOf("transport.stop") == "no_device");
        CHECK(client.errorOf("transport.locate", Value(Object{{"frames", Value("0")}})) == "no_device");
    }
    CHECK(stopEngine(child) == 0);
    CHECK(child.stdoutText() == *line + "\n");  // the diagnostic went to stderr
    CHECK(child.stderrText().find("no audio device") != std::string::npos);
}

TEST_CASE("a restarted engine reopens the device", "[engine][transport]") {
    ix::initNetSystem();
    TempDir dir;
    const fs::path bundle = dir.path() / "Song.siann";
    writeBundle(bundle, dir.path());
    {
        PipedProcess crashed(SIANN_ENGINE_EXE, launchArgs(bundle));
        const Value ready = readyLine(crashed);
        EngineClient client(ready);
        client.ok("transport.play");
        client.waitAdvancing();
        crashed.kill();  // the shell then relaunches it, under its backoff
    }

    PipedProcess restarted(SIANN_ENGINE_EXE, launchArgs(bundle));
    const Value ready = readyLine(restarted);
    {
        EngineClient client(ready);
        const Value status = client.ok("engine.status");
        CHECK(at(at(status, "device"), "id").asString() == "fake");
        CHECK_FALSE(at(status, "playing").asBool());  // a restart never starts playing
        CHECK(at(client.ok("transport.play"), "playing").asBool());
        client.waitAdvancing();
    }
    CHECK(stopEngine(restarted) == 0);
}

// The case the retry exists for: the crash left the device held for a moment.
TEST_CASE("a relaunched engine that finds the device held keeps trying until it opens", "[engine][transport]") {
    ix::initNetSystem();
    TempDir dir;
    const fs::path bundle = dir.path() / "Song.siann";
    writeBundle(bundle, dir.path());
    {
        PipedProcess crashed(SIANN_ENGINE_EXE, launchArgs(bundle));
        const Value ready = readyLine(crashed);
        EngineClient client(ready);
        client.ok("transport.play");
        client.waitAdvancing();
        crashed.kill();
    }

    PipedProcess restarted(SIANN_ENGINE_EXE,
                           withArgs(launchArgs(bundle), {"--fake-open-failures", "3", "--device-backoff", "1:4:1000"}));
    const Value ready = readyLine(restarted);
    {
        EngineClient client(ready);
        const Value status = client.waitForDevice();
        CHECK(at(at(status, "device"), "id").asString() == "fake");
        CHECK_FALSE(at(status, "playing").asBool());
        CHECK(status.find("deviceError") == nullptr);
        CHECK(at(client.ok("transport.play"), "playing").asBool());
        client.waitAdvancing();
    }
    CHECK(stopEngine(restarted) == 0);
    const std::string log = restarted.stderrText();
    INFO("stderr: " << log);
    CHECK(log.find("device_open_failed") != std::string::npos);
    CHECK(log.find("running") != std::string::npos);
}

// One bad file must not fail the launch: the shell would restart the engine until it
// gave up, and the session could not be opened (spec, "Process model").
TEST_CASE("a corrupt media file does not fail the launch", "[engine][transport]") {
    ix::initNetSystem();
    TempDir dir;
    const fs::path bundle = dir.path() / "Song.siann";
    writeBundle(bundle, dir.path());
    fs::path file;
    for (const fs::directory_entry& entry : fs::recursive_directory_iterator(bundle / "media")) {
        if (entry.is_regular_file()) {
            file = entry.path();
        }
    }
    REQUIRE_FALSE(file.empty());
    const std::string whole = io::readFile(file);

    const auto served = [&](const std::string& code) {
        PipedProcess child(SIANN_ENGINE_EXE, launchArgs(bundle));
        const Value ready = readyLine(child);
        {
            EngineClient client(ready);
            CHECK(at(client.ok("session.inspect"), "revisions").asNumber() > 1);
            const Value status = client.ok("engine.status");
            CHECK(at(status, "device").kind() == Value::Kind::null);
            CHECK(at(at(status, "deviceError"), "code").asString() == code);
            CHECK(client.errorOf("transport.play") == "no_device");
        }
        CHECK(stopEngine(child) == 0);
    };

    SECTION("a header that is not one") {
        std::string bytes = whole;
        bytes.replace(0, 4, "JUNK");
        io::writeFileAtomic(file, bytes);
        served("unsupported_media");
    }
    SECTION("cut off inside the header") {
        io::writeFileAtomic(file, whole.substr(0, 20));
        served("decode_failed");
    }
    SECTION("cut off inside the audio") {
        io::writeFileAtomic(file, whole.substr(0, whole.size() / 2));
        served("media_mismatch");  // the reader sees fewer frames than the entity says
    }
}

TEST_CASE("every build accepts --owner-window, used or not", "[engine][launch]") {
    TempDir dir;
    PipedProcess child(SIANN_ENGINE_EXE, withArgs(launchArgs(dir.path() / "Song.siann"), {"--owner-window", "4242"}));
    readyLine(child);
    CHECK(stopEngine(child) == 0);
}

// m4-plugin-node: editors open through the protocol (Protocol v0 item 19).
Value trackAddCommand(const std::string& trackId) {
    return Value(Object{{"commands", Value(json::Array{Value(Object{{"op", Value("track.add")},
                                                              {"trackId", Value(trackId)},
                                                              {"name", Value(trackId)},
                                                              {"channels", Value(2)}})})}});
}

Value instantiateParams(const std::string& format, const std::string& path) {
    return Value(Object{{"trackId", Value("trk_1")},
                        {"index", Value(0)},
                        {"descriptor", Value(Object{{"format", Value(format)}, {"path", Value(path)}})}});
}

TEST_CASE("the --open-editor flag is a usage error now", "[engine][launch]") {
    TempDir dir;
    PipedProcess child(SIANN_ENGINE_EXE, withArgs(launchArgs(dir.path() / "Song.siann"),
                                                  {"--open-editor", utf8(dir.path() / "missing.vst3")}));
    CHECK(child.wait() == 1);
    CHECK(child.stdoutText().empty());
    CHECK(errorCode(child) == "usage");
}

TEST_CASE("an editor that cannot open is an error of the method, the engine serves on", "[engine][launch]") {
    ix::initNetSystem();
    TempDir dir;
    PipedProcess child(SIANN_ENGINE_EXE, launchArgs(dir.path() / "Song.siann"));
    const Value ready = readyLine(child);
    {
        EngineClient client(ready);
        client.ok("command.execute", trackAddCommand("trk_1"));
        const Value missing = client.ok("plugin.instantiate", instantiateParams("vst3", utf8(dir.path() / "missing.vst3")));
        CHECK(at(missing, "state").asString() == "failed");
#if defined(SIANN_ENGINE_WITH_JUCE)
        CHECK(at(at(missing, "error"), "code").asString() == "plugin_not_found");
#else
        CHECK(at(at(missing, "error"), "code").asString() == "no_plugin_host");
#endif
        CHECK(client.errorOf("plugin.open_editor", Value(Object{{"slotId", Value("slt_9")}})) == "not_found");
        CHECK(client.ok("engine.status").kind() == Value::Kind::object);
    }
    CHECK(stopEngine(child) == 0);
}

#if defined(SIANN_ENGINE_WITH_JUCE)

TEST_CASE("the desktop engine opens the default output device, or says why not", "[engine][transport][juce]") {
    ix::initNetSystem();
    TempDir dir;
    PipedProcess child(SIANN_ENGINE_EXE, bareArgs(dir.path() / "Song.siann"));
    const Value ready = readyLine(child);
    {
        EngineClient client(ready);
        const Value status = client.ok("engine.status");
        if (at(status, "device").kind() == Value::Kind::object) {
            CHECK(at(at(status, "device"), "id").asString() == "default");
            CHECK(at(at(status, "device"), "sampleRate").asNumber() > 0);
        } else {
            const std::string code = at(at(status, "deviceError"), "code").asString();
            CHECK((code == "no_device" || code == "device_open_failed"));
        }
    }
    CHECK(stopEngine(child) == 0);
}

TEST_CASE("the desktop engine opens an editor through plugin.open_editor and still serves", "[engine][launch][juce]") {
    if (!displayAvailable()) {
        SKIP("no display: set DISPLAY or run under xvfb-run");
    }
    ix::initNetSystem();
    TempDir dir;
    PipedProcess child(SIANN_ENGINE_EXE, launchArgs(dir.path() / "Song.siann"));
    const std::optional<std::string> line = child.firstLine();
    REQUIRE(line.has_value());
    const Value ready = json::parse(*line);
    CHECK(at(ready, "schema").asString() == engine_app::kReadySchema);
    {
        EngineClient client(ready);
        client.ok("command.execute", trackAddCommand("trk_1"));
        const Value loaded = client.ok("plugin.instantiate", instantiateParams("vst3", SIANN_TEST_PLUGIN_VST3));
        REQUIRE(at(loaded, "state").asString() == "done");
        const std::string slotId = at(at(loaded, "result"), "slotId").asString();
        CHECK(at(at(at(loaded, "result"), "capabilities"), "editor").asBool());
        const Value opened = client.ok("plugin.open_editor", Value(Object{{"slotId", Value(slotId)}}));
        CHECK(at(opened, "editorOpen").asBool());
        CHECK(at(opened, "nativeHandle").asString() != "0");
        const Value closed = client.ok("plugin.close_editor", Value(Object{{"slotId", Value(slotId)}}));
        CHECK_FALSE(at(closed, "editorOpen").asBool());
    }
    CHECK(stopEngine(child) == 0);
    // The plugin prints a line to stdout when it loads: the handshake stays the
    // first and only stdout line, the plugin's output goes to stderr.
    CHECK(child.stdoutText() == *line + "\n");
    CHECK(child.stderrText().find("siann_test_plugin: loaded") != std::string::npos);
}

TEST_CASE("a CLAP plugin on the desktop target has no editor window yet", "[engine][launch][juce]") {
    ix::initNetSystem();
    TempDir dir;
    PipedProcess child(SIANN_ENGINE_EXE, launchArgs(dir.path() / "Song.siann"));
    const Value ready = readyLine(child);
    {
        EngineClient client(ready);
        client.ok("command.execute", trackAddCommand("trk_1"));
        const Value loaded = client.ok("plugin.instantiate", instantiateParams("clap", SIANN_TEST_PLUGIN_CLAP));
        REQUIRE(at(loaded, "state").asString() == "done");
        const std::string slotId = at(at(loaded, "result"), "slotId").asString();
        CHECK(client.errorOf("plugin.open_editor", Value(Object{{"slotId", Value(slotId)}})) == "editor_failed");
    }
    CHECK(stopEngine(child) == 0);
}

#if defined(_WIN32)

TEST_CASE("the editor belongs to the window named by --owner-window, and the JUCE loop runs it",
          "[engine][launch][juce]") {
    TempDir dir;
    const OwnerWindow owner;
    PipedProcess child(SIANN_ENGINE_EXE,
                       withArgs(launchArgs(dir.path() / "Song.siann"), {"--owner-window", owner.handleArgument()}));
    const Value ready = readyLine(child);
    EngineClient client(ready);
    client.ok("command.execute", trackAddCommand("trk_1"));
    const Value loaded = client.ok("plugin.instantiate", instantiateParams("vst3", SIANN_TEST_PLUGIN_VST3));
    const std::string slotId = at(at(loaded, "result"), "slotId").asString();
    const Value opened = client.ok("plugin.open_editor", Value(Object{{"slotId", Value(slotId)}}));

    HWND editor = ownedWindow(child.pid(), owner.hwnd());
    CHECK(at(opened, "nativeHandle").asString() == std::to_string(reinterpret_cast<std::uintptr_t>(editor)));
    REQUIRE(editor != nullptr);
    CHECK(IsWindowVisible(editor));
    // Only a thread dispatching messages answers: this fails when main() does not
    // run the loop.
    DWORD_PTR answer = 0;
    CHECK(SendMessageTimeoutW(editor, WM_NULL, 0, 0, SMTO_ABORTIFHUNG, 20'000, &answer) != 0);

    CHECK(stopEngine(child) == 0);
    CHECK_FALSE(IsWindow(editor));
}

#endif  // _WIN32
#endif  // SIANN_ENGINE_WITH_JUCE
