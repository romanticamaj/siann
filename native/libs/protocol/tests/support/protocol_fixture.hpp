#pragma once

// A protocol server over the in-memory transport with a session in a
// temporary bundle, for the events, sync and realtime tests. pump() runs on
// the test thread, so every step is deterministic.

#include <catch2/catch_test_macros.hpp>

#include <filesystem>
#include <random>
#include <string>
#include <utility>
#include <vector>

#include "fake_transport.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/session/session.hpp"

namespace siann::protocol::testing {

using json::Array;
using json::Object;
using json::Value;

class TempDir {
public:
    TempDir() {
        std::random_device rd;
        path_ = std::filesystem::temp_directory_path() /
                ("siann-protocol-events-" + std::to_string(rd()) + "-" + std::to_string(rd()));
        std::filesystem::create_directories(path_);
    }
    ~TempDir() {
        std::error_code ec;
        std::filesystem::remove_all(path_, ec);
    }
    TempDir(const TempDir&) = delete;
    TempDir& operator=(const TempDir&) = delete;
    std::filesystem::path bundle() const { return path_ / "Song.siann"; }

private:
    std::filesystem::path path_;
};

inline ServerOptions manualOptions() {
    ServerOptions options;
    options.pumpThread = false;
    options.clock = [] { return std::string("2026-11-04T00:00:00Z"); };
    return options;
}

// Member lookup that fails the test instead of dereferencing null.
inline const Value& at(const Value& object, const char* key) {
    const Value* member = object.find(key);
    INFO("missing member " << key);
    REQUIRE(member != nullptr);
    return *member;
}

inline bool isEvent(const Value& frame) {
    const Value* schema = frame.find("schema");
    return schema != nullptr && schema->kind() == Value::Kind::string && schema->asString() == "siann.event.v1";
}

inline std::string canonical(const Value& value) {
    return jcs::canonicalize(value);
}

// Commands in their journal JSON form.
inline Value trackAdd(const std::string& id) {
    return Value(Object{{"op", Value("track.add")}, {"trackId", Value(id)}, {"name", Value(id)}, {"channels", Value(2)}});
}

inline Value mediaAdd(const std::string& id) {
    return Value(Object{{"op", Value("media.add")},
                        {"mediaId", Value(id)},
                        {"contentHash", Value("sha256:" + std::string(64, 'a'))},
                        {"format", Value("wav")},
                        {"channels", Value(2)},
                        {"sampleRate", Value(48000)},
                        {"frames", Value("480000")}});
}

inline Value clipPlace(const std::string& id, const std::string& track, const std::string& media, int position) {
    return Value(Object{{"op", Value("clip.place")},
                        {"clipId", Value(id)},
                        {"trackId", Value(track)},
                        {"mediaId", Value(media)},
                        {"position", Value(Object{{"domain", Value("audio")}, {"value", Value(std::to_string(position))}})},
                        {"sourceStart", Value("0")},
                        {"length", Value("48000")}});
}

inline Value clipRemove(const std::string& id) {
    return Value(Object{{"op", Value("clip.remove")}, {"clipId", Value(id)}});
}

struct Fixture {
    explicit Fixture(ServerOptions options = manualOptions())
        : session(session::Session::create(dir.bundle(), model::Document::create("Song", 48'000), "tester",
                                           "2026-11-04T00:00:00Z")),
          server(transport, session, std::move(options)) {
        server.start();
    }

    std::string authFrame(bool events) const {
        Object frame{{"type", Value("auth")}, {"token", Value(server.token())}};
        if (events) {
            frame.emplace_back("events", Value(true));
        }
        return jcs::canonicalize(Value(std::move(frame)));
    }

    // Opens a command connection, authenticates it (subscribed to events when
    // `events`) and returns it; the reply is sent()[0].
    ConnectionId authed(bool events = false) {
        auto upgrade = transport.connect();
        REQUIRE(upgrade.connection.has_value());
        transport.deliver(*upgrade.connection, authFrame(events));
        REQUIRE(transport.sent(*upgrade.connection).size() == 1);
        return *upgrade.connection;
    }

    // Opens a realtime connection and authenticates it.
    ConnectionId realtimeAuthed() {
        auto upgrade = transport.connectRealtime();
        REQUIRE(upgrade.connection.has_value());
        transport.deliver(*upgrade.connection, authFrame(false));
        return *upgrade.connection;
    }

    std::string request(const std::string& requestId, const std::string& method, Value params) const {
        return jcs::canonicalize(Value(Object{{"requestId", Value(requestId)},
                                              {"sessionId", Value(server.sessionId())},
                                              {"method", Value(method)},
                                              {"params", std::move(params)}}));
    }

    // Sends one request on `connection`, pumps, and returns its response.
    Value call(ConnectionId connection, const std::string& method, Value params = Value(Object{})) {
        const std::string id = "req_" + std::to_string(++nextRequest);
        transport.deliver(connection, request(id, method, std::move(params)));
        server.pump();
        const auto frames = transport.sent(connection);
        for (auto it = frames.rbegin(); it != frames.rend(); ++it) {
            Value frame = json::parse(*it);
            const Value* requestId = frame.find("requestId");
            if (requestId != nullptr && requestId->kind() == Value::Kind::string && requestId->asString() == id) {
                return frame;
            }
        }
        FAIL("no response to " << method);
        return Value();
    }

    // call() that requires ok:true and returns the result.
    Value ok(ConnectionId connection, const std::string& method, Value params = Value(Object{})) {
        Value response = call(connection, method, std::move(params));
        INFO(canonical(response));
        REQUIRE(at(response, "ok").asBool());
        return at(response, "result");
    }

    Value commit(ConnectionId connection, Array commands) {
        return ok(connection, "command.execute", Value(Object{{"commands", Value(std::move(commands))}}));
    }

    // The events the server sent on a connection, in order.
    std::vector<Value> events(ConnectionId connection) const {
        std::vector<Value> out;
        for (const auto& text : transport.sent(connection)) {
            Value frame = json::parse(text);
            if (isEvent(frame)) {
                out.push_back(std::move(frame));
            }
        }
        return out;
    }

    const command::Revision& head() const { return session.history().head(); }

    TempDir dir;
    session::Session session;
    FakeTransport transport;
    ProtocolServer server;
    int nextRequest = 0;
};

inline std::string errorCode(const Value& response) {
    const Value* error = response.find("error");
    REQUIRE(error != nullptr);
    return at(*error, "code").asString();
}

}  // namespace siann::protocol::testing
