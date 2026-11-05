// End to end (m3-mcp acceptance 3, M3 exit m3-exit-e2e): an MCP client over
// real HTTP on 127.0.0.1 (IXWebSocket's HTTP client) drives the protocol
// server, with its pump thread, the trusted scope and a real auditioner on a
// ManualAudioDevice behind the AuditionPort. It builds a session through
// approved plans, auditions and merges a proposal, rolls it back, renders,
// saves and opens another bundle. Waits are condition waits, never sleeps.

#include <catch2/catch_test_macros.hpp>

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <ixwebsocket/IXHttpClient.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>

#include "live_rig.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/playback/audition.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/ix_transport.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "support/auditioner_port.hpp"

using namespace siann;
using json::Array;
using json::Object;
using json::Value;
using protocol::testing::AuditionerPort;

namespace {

constexpr auto kTimeout = std::chrono::seconds(10);

const Value& at(const Value& object, const char* key) {
    const Value* member = object.find(key);
    INFO("missing member " << key);
    REQUIRE(member != nullptr);
    return *member;
}

std::string utf8(const std::filesystem::path& path) {
    const std::u8string text = path.u8string();
    return std::string(text.begin(), text.end());
}

// An MCP client over Streamable HTTP (JSON responses).
class McpClient {
public:
    McpClient(std::uint16_t port, std::string token)
        : url_("http://127.0.0.1:" + std::to_string(port) + "/v0/mcp"), token_(std::move(token)) {}

    ix::HttpResponsePtr post(const std::string& body, bool withToken = true) {
        auto args = client_.createRequest();
        args->connectTimeout = 10;
        args->transferTimeout = 30;
        args->extraHeaders["Content-Type"] = "application/json";
        if (withToken) {
            args->extraHeaders["Authorization"] = "Bearer " + token_;
        }
        if (!session_.empty()) {
            args->extraHeaders["Mcp-Session-Id"] = session_;
        }
        return client_.post(url_, body, args);
    }

    void initialize() {
        const auto response = post(rpc("initialize", Value(Object{{"protocolVersion", Value("2025-06-18")},
                                                                  {"capabilities", Value(Object{})},
                                                                  {"clientInfo", Value(Object{{"name", Value("e2e")},
                                                                                              {"version", Value("1")}})}})));
        REQUIRE(response->statusCode == 200);
        const auto header = response->headers.find("Mcp-Session-Id");
        REQUIRE(header != response->headers.end());
        session_ = header->second;
        const Value body = json::parse(response->body);
        CHECK(at(at(at(body, "result"), "serverInfo"), "name").asString() == protocol::buildInfo().name);
        CHECK(post(R"({"jsonrpc":"2.0","method":"notifications/initialized"})")->statusCode == 202);
    }

    // A tool call's JSON-RPC result.
    Value tool(const std::string& name, Value arguments = Value(Object{})) {
        const auto response = post(rpc("tools/call", Value(Object{{"name", Value(name)}, {"arguments", std::move(arguments)}})));
        INFO(name << ": " << response->body);
        REQUIRE(response->statusCode == 200);
        const Value body = json::parse(response->body);
        return at(body, "result");
    }

    Value ok(const std::string& name, Value arguments = Value(Object{})) {
        const Value result = tool(name, std::move(arguments));
        INFO(name << ": " << jcs::canonicalize(result));
        REQUIRE_FALSE(at(result, "isError").asBool());
        return at(result, "structuredContent");
    }

private:
    std::string rpc(const std::string& method, Value params) {
        return jcs::canonicalize(Value(Object{{"jsonrpc", Value("2.0")},
                                              {"id", Value(++nextId_)},
                                              {"method", Value(method)},
                                              {"params", std::move(params)}}));
    }

    ix::HttpClient client_;
    std::string url_;
    std::string token_;
    std::string session_;
    int nextId_ = 0;
};

// A WebSocket client on the same server, to show the UI side works alongside.
class WsClient {
public:
    explicit WsClient(std::uint16_t port) {
        socket_.setUrl("ws://127.0.0.1:" + std::to_string(port) + "/");
        ix::WebSocketHttpHeaders headers;
        headers["Origin"] = std::string(protocol::kAppOrigin);
        socket_.setExtraHeaders(headers);
        socket_.disableAutomaticReconnection();
        socket_.setOnMessageCallback([this](const ix::WebSocketMessagePtr& message) {
            std::lock_guard lock(mutex_);
            if (message->type == ix::WebSocketMessageType::Open) {
                open_ = true;
            } else if (message->type == ix::WebSocketMessageType::Message && !message->binary) {
                received_.push_back(message->str);
            }
            changed_.notify_all();
        });
    }
    ~WsClient() { socket_.stop(); }

    bool start() {
        socket_.start();
        std::unique_lock lock(mutex_);
        return changed_.wait_for(lock, kTimeout, [this] { return open_; });
    }

    Value call(const std::string& text) {
        socket_.sendText(text);
        std::unique_lock lock(mutex_);
        REQUIRE(changed_.wait_for(lock, kTimeout, [this] { return !received_.empty(); }));
        Value out = json::parse(received_.front());
        received_.pop_front();
        return out;
    }

private:
    ix::WebSocket socket_;
    std::mutex mutex_;
    std::condition_variable changed_;
    std::deque<std::string> received_;
    bool open_ = false;
};

// The second bundle open_session switches to: one track, no media.
std::filesystem::path makeOtherBundle(const std::filesystem::path& dir) {
    const std::filesystem::path bundle = dir / "Other.siann";
    session::Session other =
        session::Session::create(bundle, model::Document::create("Other", 48'000), "tester", "2026-11-04T00:00:00Z");
    other.commit({command::Command::fromJson(json::parse(live_rig::addTrack("trk_other")))}, "tester", "t");
    return bundle;
}

// The engine host: the session, its playback engine on a manual device and its
// auditioner behind the port; openSession rebinds all three.
struct Host {
    Host() : live(std::make_unique<live_rig::Live>(media.session)),
             auditioner(std::make_unique<playback::Auditioner>(live->engine, media.session)),
             port(*auditioner) {}

    session::Session& open(const std::filesystem::path& bundle) {
        auto session = std::make_unique<session::Session>(session::Session::open(bundle));
        auto nextLive = std::make_unique<live_rig::Live>(*session);
        auto nextAuditioner = std::make_unique<playback::Auditioner>(nextLive->engine, *session);
        port.rebind(*nextAuditioner);
        retired.push_back(std::move(auditioner));
        retiredLive.push_back(std::move(live));
        opened.push_back(std::move(session));
        live = std::move(nextLive);
        auditioner = std::move(nextAuditioner);
        return *opened.back();
    }

    live_rig::Fixture media;
    std::vector<std::unique_ptr<session::Session>> opened;  // outlive their engines
    std::vector<std::unique_ptr<live_rig::Live>> retiredLive;
    std::vector<std::unique_ptr<playback::Auditioner>> retired;
    std::unique_ptr<live_rig::Live> live;
    std::unique_ptr<playback::Auditioner> auditioner;
    AuditionerPort port;
};

}  // namespace

TEST_CASE("an MCP client builds a session through approved plans, rolls back and auditions a branch",
          "[protocol][mcp][e2e]") {
    ix::initNetSystem();
    Host host;
    const std::filesystem::path other = makeOtherBundle(host.media.dir.path());

    protocol::ServerOptions options;
    options.pumpThread = true;
    options.mcpScope = protocol::McpScope::trusted;
    options.auditionPort = &host.port;
    options.openSession = [&host](const std::filesystem::path& bundle) -> session::Session& {
        return host.open(bundle);
    };
    protocol::IxTransport transport;
    protocol::ProtocolServer server(transport, host.media.session, options);
    server.start();

    McpClient mcp(server.port(), server.token());
    // Without the bearer token the MCP route is 401.
    CHECK(mcp.post(R"({"jsonrpc":"2.0","id":1,"method":"initialize"})", false)->statusCode == 401);
    mcp.initialize();

    const Value capabilities = mcp.ok("describe_capabilities");
    CHECK(at(capabilities, "scope").asString() == "trusted");
    CHECK(at(at(capabilities, "features"), "audition").asBool());

    // Build: a track with media and a clip through an approved plan.
    const Value plan1 = mcp.ok(
        "submit_plan",
        Value(Object{{"steps", Value(Array{json::parse(live_rig::addTrack("trk_c")),
                                           json::parse(live_rig::place("clp_c", "trk_c", "med_st", 0, 0, 20'000))})}}));
    const std::string hash1 = at(plan1, "hash").asString();
    CHECK(at(mcp.ok("approve_plan", Value(Object{{"plan", Value(hash1)}})), "state").asString() == "approved");
    const Value applied = mcp.ok("apply_plan", Value(Object{{"plan", Value(hash1)}}));
    CHECK(at(at(applied, "revision"), "cause").asString() == "plan");
    CHECK(at(mcp.ok("plan_status", Value(Object{{"plan", Value(hash1)}})), "state").asString() == "applied");

    // A second plan, proposed onto a branch and auditioned.
    const std::string preMerge = at(mcp.ok("inspect_session"), "documentHash").asString();
    const Value plan2 = mcp.ok(
        "submit_plan",
        Value(Object{{"steps", Value(Array{json::parse(live_rig::addTrack("trk_d")),
                                           json::parse(live_rig::place("clp_d", "trk_d", "med_mono", 500, 0, 9'000))})}}));
    const std::string hash2 = at(plan2, "hash").asString();
    mcp.ok("approve_plan", Value(Object{{"plan", Value(hash2)}}));
    const std::string branch = at(mcp.ok("propose_plan", Value(Object{{"plan", Value(hash2)}})), "branch").asString();
    CHECK(branch == "p1");
    CHECK(at(mcp.ok("audition", Value(Object{{"side", Value(branch)}})), "heard").asString() == branch);
    CHECK(at(mcp.ok("inspect_session"), "heard").asString() == branch);
    const Value merged = mcp.ok("merge_proposal", Value(Object{{"branch", Value(branch)}}));
    CHECK(at(at(merged, "revision"), "cause").asString() == "branch-merge");
    CHECK(at(mcp.ok("inspect_session"), "heard").asString() == "main");
    CHECK(at(mcp.ok("plan_status", Value(Object{{"plan", Value(hash2)}})), "state").asString() == "applied");

    // Roll the merged proposal back.
    const Value rolled = mcp.ok("rollback_plan", Value(Object{{"plan", Value(hash2)}}));
    CHECK(at(at(rolled, "revision"), "cause").asString() == "rollback");
    CHECK(at(at(rolled, "revision"), "documentHash").asString() == preMerge);
    CHECK(at(mcp.ok("inspect_session"), "documentHash").asString() == preMerge);

    // Render, poll the job, save.
    const std::string jobId = at(mcp.ok("render", Value(Object{{"name", Value("mix")}})), "jobId").asString();
    REQUIRE(server.waitJob(jobId, std::chrono::seconds(60)));
    const Value job = mcp.ok("job_status", Value(Object{{"jobId", Value(jobId)}}));
    CHECK(at(job, "state").asString() == "done");
    CHECK(std::filesystem::exists(host.media.bundle() / "renders" / "mix.wav"));
    const Value saved = mcp.ok("save_session");
    CHECK(std::filesystem::exists(host.media.bundle() / "session.json"));
    CHECK(at(saved, "revision").asString() == at(mcp.ok("inspect_session"), "revision").asString());

    // The WebSocket side works alongside.
    WsClient ws(server.port());
    REQUIRE(ws.start());
    const Value authed = ws.call(jcs::canonicalize(Value(Object{{"type", Value("auth")}, {"token", Value(server.token())}})));
    CHECK(at(authed, "sessionId").asString() == server.sessionId());

    // Open the other bundle; the next inspect is of the new session.
    const std::string oldSessionId = server.sessionId();
    const Value opened = mcp.ok("open_session", Value(Object{{"path", Value(utf8(other))}}));
    CHECK(at(opened, "sessionId").asString() != oldSessionId);
    const Value inspected = mcp.ok("inspect_session");
    CHECK(at(inspected, "documentHash").asString() == at(opened, "documentHash").asString());
    CHECK(at(inspected, "revisions").asNumber() == 2);
    CHECK(at(inspected, "heard").asString() == "main");

    server.stop();
}
