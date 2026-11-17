// The fuzz harnesses (harness.hpp). Inputs a parser is allowed to refuse end in
// that parser's documented exception, which the harness catches; anything else
// leaves it, and the driver reports it (libFuzzer aborts on an uncaught
// exception, the smoke test's REQUIRE_NOTHROW fails).

#include "siann/fuzz/harness.hpp"

#include <algorithm>
#include <filesystem>
#include <memory>
#include <optional>
#include <random>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include "fake_transport.hpp"
#include "siann/command/command.hpp"
#include "siann/command/plan.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/protocol/realtime_channel.hpp"
#include "siann/session/session.hpp"

namespace siann::fuzz {

namespace {

namespace fs = std::filesystem;
using json::Object;
using json::Value;
using protocol::ConnectionId;
using protocol::HttpRequest;
using protocol::HttpResponse;
using protocol::testing::FakeTransport;

constexpr const char* kTime = "2026-11-17T00:00:00Z";
constexpr std::string_view kSessionPlaceholder = "$session";

fs::path freshDirectory() {
    std::random_device rd;
    fs::path dir = fs::temp_directory_path() /
                   ("siann-fuzz-" + std::to_string(rd()) + "-" + std::to_string(rd()));
    fs::create_directories(dir);
    return dir;
}

protocol::ServerOptions options() {
    protocol::ServerOptions out;
    out.pumpThread = false;                 // pump() on the caller's thread: deterministic
    out.clock = [] { return std::string(kTime); };
    out.jobs.workerThread = false;          // render jobs queue and never run: no disk work per input
    out.mcpScope = protocol::McpScope::trusted;  // the deepest tool set
    return out;
}

// One server over the in-memory transport, its session in a temporary bundle.
struct Server {
    fs::path dir = freshDirectory();
    session::Session session =
        session::Session::create(dir / "Fuzz.siann", model::Document::create("Fuzz", 48'000), "fuzz", kTime);
    FakeTransport transport;
    protocol::ProtocolServer server{transport, session, options()};
    std::string mcpSession;
    int nextId = 0;

    Server() { server.start(); }

    ~Server() {
        server.stop();
        std::error_code ec;
        fs::remove_all(dir, ec);
    }

    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    std::string authFrame() const {
        return jcs::canonicalize(Value(Object{{"type", Value("auth")}, {"token", Value(server.token())}}));
    }

    // A connection after the upgrade and the token handshake, or none when the
    // server refused it.
    std::optional<ConnectionId> authed() {
        auto upgrade = transport.connect();
        if (!upgrade.connection) {
            return std::nullopt;
        }
        transport.deliver(*upgrade.connection, authFrame());
        server.pump();
        return upgrade.connection;
    }

    void drop(ConnectionId connection) {
        transport.disconnect(connection);
        server.pump();
        transport.forget(connection);
    }

    // One POST /v0/mcp. handleMcp is what the transport's onHttp handler calls
    // (through waitMcp, which would block this thread waiting for its own pump).
    std::optional<HttpResponse> mcp(std::string body, bool withSession = true) {
        HttpRequest request{"POST", std::string(protocol::kMcpPath),
                            {{"authorization", "Bearer " + server.mcpToken()}, {"content-type", "application/json"}},
                            std::move(body)};
        if (withSession && !mcpSession.empty()) {
            request.headers["mcp-session-id"] = mcpSession;
        }
        // The completion can run later (a long poll); it owns its slot.
        auto slot = std::make_shared<std::optional<HttpResponse>>();
        server.handleMcp(request, [slot](HttpResponse response) { *slot = std::move(response); });
        if (!*slot) {
            server.pump();
        }
        return *slot;
    }

    void initializeMcp() {
        const auto response = mcp(
            R"({"id":0,"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"fuzz","version":"1"},"protocolVersion":"2025-06-18"}})",
            false);
        if (response) {
            const auto header = response->headers.find("Mcp-Session-Id");
            if (header != response->headers.end()) {
                mcpSession = header->second;
            }
        }
    }
};

std::unique_ptr<Server>& wsServer() {
    static std::unique_ptr<Server> server;
    if (!server) {
        server = std::make_unique<Server>();
    }
    return server;
}

std::unique_ptr<Server>& mcpServer() {
    static std::unique_ptr<Server> server;
    if (!server) {
        server = std::make_unique<Server>();
        server->initializeMcp();
    }
    return server;
}

// A document with a track, a media entry and a clip for commands to address.
const model::Document& baseDocument() {
    static const model::Document document = [] {
        std::vector<command::Command> setup;
        setup.push_back(command::Command::fromJson(json::parse(
            R"({"channels":2,"name":"Track","op":"track.add","trackId":"trk_a"})")));
        setup.push_back(command::Command::fromJson(json::parse(
            R"({"channels":2,"contentHash":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","format":"wav","frames":"480000","mediaId":"med_a","op":"media.add","sampleRate":48000})")));
        setup.push_back(command::Command::fromJson(json::parse(
            R"({"clipId":"clp_a","length":"48000","mediaId":"med_a","op":"clip.place","position":{"domain":"audio","value":"0"},"sourceStart":"0","trackId":"trk_a"})")));
        return command::prepareTransaction(model::Document::create("Fuzz", 48'000), setup).result;
    }();
    return document;
}

// Every '\n'-separated piece of the bytes.
std::vector<std::string_view> frames(std::string_view bytes) {
    std::vector<std::string_view> out;
    std::size_t start = 0;
    while (start <= bytes.size()) {
        const std::size_t end = bytes.find('\n', start);
        if (end == std::string_view::npos) {
            out.push_back(bytes.substr(start));
            break;
        }
        out.push_back(bytes.substr(start, end - start));
        start = end + 1;
    }
    return out;
}

template <typename Fn>
void refusable(Fn&& fn) {
    try {
        fn();
    } catch (const json::ParseError&) {
    } catch (const jcs::CanonicalizeError&) {
    } catch (const command::CommandError&) {
    } catch (const model::ModelError&) {
    }
}

}  // namespace

void protocolWs(std::string_view input) {
    Server& s = *wsServer();
    // The server's session id is random: the corpus names it as $session.
    std::string text(input);
    for (std::size_t at = text.find(kSessionPlaceholder); at != std::string::npos;
         at = text.find(kSessionPlaceholder, at + s.server.sessionId().size())) {
        text.replace(at, kSessionPlaceholder.size(), s.server.sessionId());
    }
    const std::string_view bytes(text);

    // The bytes as one frame on an authenticated connection.
    if (const auto connection = s.authed()) {
        s.transport.deliver(*connection, text);
        s.server.pump();
        s.drop(*connection);
    }
    // As a sequence of frames.
    if (const auto connection = s.authed()) {
        for (const std::string_view frame : frames(bytes)) {
            s.transport.deliver(*connection, std::string(frame));
        }
        s.server.pump();
        s.drop(*connection);
    }
    // As the first frame, where the server expects the token.
    auto upgrade = s.transport.connect();
    if (upgrade.connection) {
        s.transport.deliver(*upgrade.connection, text);
        s.server.pump();
        s.drop(*upgrade.connection);
    }
    // A realtime meter frame, as the app decodes it.
    (void)protocol::decodeMeterFrame(bytes);
}

void mcpHttp(std::string_view bytes) {
    Server& s = *mcpServer();
    (void)s.mcp(std::string(bytes));
}

void commandJson(std::string_view bytes) {
    const model::Document& document = baseDocument();
    refusable([&] {
        const Value value = json::parse(bytes);
        if (const Value* commands = value.find("commands");
            commands != nullptr && commands->kind() == Value::Kind::array) {
            std::vector<command::Command> transaction;
            for (const Value& item : commands->asArray()) {
                transaction.push_back(command::Command::fromJson(item));
            }
            (void)command::prepareTransaction(document, transaction);
        } else if (value.kind() == Value::Kind::array) {
            std::vector<command::Command> transaction;
            for (const Value& item : value.asArray()) {
                transaction.push_back(command::Command::fromJson(item));
            }
            (void)command::prepareTransaction(document, transaction);
        } else {
            (void)command::prepare(document, command::Command::fromJson(value));
        }
    });
    refusable([&] {
        const command::Plan plan = command::Plan::parse(bytes);
        (void)command::planHash(plan);
        (void)plan.toJson();
    });
}

bool protocolWsStillAnswers() {
    Server& s = *wsServer();
    const auto connection = s.authed();
    if (!connection) {
        return false;
    }
    const std::string request = jcs::canonicalize(Value(Object{{"method", Value("engine.capabilities")},
                                                               {"params", Value(Object{})},
                                                               {"requestId", Value("req_still")},
                                                               {"sessionId", Value(s.server.sessionId())}}));
    s.transport.deliver(*connection, request);
    s.server.pump();
    bool answered = false;
    for (const std::string& frame : s.transport.sent(*connection)) {
        refusable([&] {
            const Value value = json::parse(frame);
            const Value* id = value.find("requestId");
            const Value* ok = value.find("ok");
            answered = answered || (id != nullptr && id->kind() == Value::Kind::string &&
                                    id->asString() == "req_still" && ok != nullptr &&
                                    ok->kind() == Value::Kind::boolean && ok->asBool());
        });
    }
    s.drop(*connection);
    return answered;
}

bool mcpHttpStillAnswers() {
    Server& s = *mcpServer();
    const auto response = s.mcp(R"({"id":"still","jsonrpc":"2.0","method":"tools/list","params":{}})");
    if (!response || response->status != 200) {
        return false;
    }
    bool listed = false;
    refusable([&] {
        const Value value = json::parse(response->body);
        const Value* result = value.find("result");
        listed = result != nullptr && result->find("tools") != nullptr;
    });
    return listed;
}

void reset() {
    wsServer().reset();
    mcpServer().reset();
}

std::uint64_t SplitMix64::next() noexcept {
    std::uint64_t z = (state_ += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

std::size_t SplitMix64::below(std::size_t bound) noexcept {
    return static_cast<std::size_t>(next() % bound);
}

std::string mutate(SplitMix64& rng, const std::vector<std::string>& corpus, std::size_t maxLength) {
    const auto randomBytes = [&](std::size_t length) {
        std::string out(length, '\0');
        for (char& c : out) {
            c = static_cast<char>(rng.next() & 0xff);
        }
        return out;
    };
    // A quarter of the inputs are plain random bytes, or when there is no corpus.
    if (corpus.empty() || rng.below(4) == 0) {
        return randomBytes(rng.below(std::min<std::size_t>(maxLength, 256) + 1));
    }
    std::string out = corpus[rng.below(corpus.size())];
    const std::size_t edits = 1 + rng.below(4);
    for (std::size_t e = 0; e < edits; ++e) {
        switch (rng.below(7)) {
        case 0:  // flip a bit
            if (!out.empty()) {
                out[rng.below(out.size())] ^= static_cast<char>(1u << rng.below(8));
            }
            break;
        case 1:  // insert random bytes
            out.insert(rng.below(out.size() + 1), randomBytes(1 + rng.below(8)));
            break;
        case 2:  // erase a range
            if (!out.empty()) {
                const std::size_t at = rng.below(out.size());
                out.erase(at, 1 + rng.below(out.size() - at));
            }
            break;
        case 3:  // duplicate a range
            if (!out.empty()) {
                const std::size_t at = rng.below(out.size());
                const std::string piece = out.substr(at, 1 + rng.below(std::min<std::size_t>(out.size() - at, 64)));
                out.insert(rng.below(out.size() + 1), piece);
            }
            break;
        case 4:  // truncate
            out.resize(rng.below(out.size() + 1));
            break;
        case 5: {  // splice another entry in
            const std::string& other = corpus[rng.below(corpus.size())];
            const std::size_t cut = rng.below(out.size() + 1);
            const std::size_t from = rng.below(other.size() + 1);
            out = out.substr(0, cut) + other.substr(from);
            break;
        }
        default: {  // an interesting character: a structural JSON byte or a boundary value
            static constexpr char kInteresting[] = {'{', '}', '[', ']', '"', ':', ',', '\\', '\n', '\0',
                                                    '0', '-', 'e', '\x7f', '\xff', '\xc0'};
            const char c = kInteresting[rng.below(sizeof kInteresting)];
            if (!out.empty() && rng.below(2) == 0) {
                out[rng.below(out.size())] = c;
            } else {
                out.insert(out.begin() + static_cast<std::ptrdiff_t>(rng.below(out.size() + 1)), c);
            }
            break;
        }
        }
    }
    if (out.size() > maxLength) {
        out.resize(maxLength);
    }
    return out;
}

}  // namespace siann::fuzz
