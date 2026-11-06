// The siann-engine executable and its launcher handshake (m0-electron-shell;
// spec, Protocol v0 item 17). The tests run the real executable as a child
// with piped stdin, stdout and stderr, as the Electron shell does: they read
// the ready line, talk to the server it names over loopback, close stdin and
// wait on the process exit. No sleeps: waits are on the process, the pipes
// and socket replies, each bounded.

#include <catch2/catch_test_macros.hpp>

#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <random>
#include <string>
#include <vector>

#include <ixwebsocket/IXNetSystem.h>

#include "siann/command/history.hpp"
#include "siann/engine_app/engine.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/protocol/about.hpp"
#include "siann/session/session.hpp"
#include "support/piped_process.hpp"
#include "support/ws_clients.hpp"

using namespace siann;
using engine_app::test::PipedProcess;
using json::Object;
using json::Value;
using protocol::testing::McpClient;
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

std::vector<std::string> launchArgs(const fs::path& bundle, bool trusted = false) {
    std::vector<std::string> args{"--session", utf8(bundle), "--port", "0"};
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

TEST_CASE("--mcp-trusted sets the MCP scope", "[engine][launch][mcp]") {
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
    };
    for (const auto& args : launches) {
        INFO("args: " << args.back());
        PipedProcess child(SIANN_ENGINE_EXE, args);
        CHECK(child.wait() == 1);
        CHECK(child.stdoutText().empty());
        const std::string err = child.stderrText();
        INFO("stderr: " << err);
        const Value error = json::parse(err.substr(0, err.find('\n')));
        CHECK_FALSE(at(error, "ok").asBool());
        CHECK_FALSE(at(at(error, "error"), "code").asString().empty());
        CHECK(at(at(error, "error"), "message").kind() == json::Value::Kind::string);
    }
    // Nothing was created for the rejected launches.
    CHECK_FALSE(fs::exists(dir.path() / "Other.siann"));
}
