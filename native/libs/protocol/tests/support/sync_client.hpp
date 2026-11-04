#pragma once

// A gap-detecting protocol client for tests (docs/schemas/protocol-events-v1.md,
// "Delivery and gaps"). It keeps a read model of the session: a full
// session.sync on connect and after a gap or a reconnect that missed events,
// and session.changed applied through session.fetch otherwise. Reused by the
// MCP end-to-end test and the m3-exit-sync criterion.
//
// It plays the client over the in-memory transport on the test thread:
// `pump` runs the server's command thread (ProtocolServer::pump).

#include <catch2/catch_test_macros.hpp>

#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "fake_transport.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/protocol_server.hpp"

namespace siann::protocol::testing {

class SyncClient {
public:
    struct SyncResult {
        std::string revision;
        std::uint64_t seq = 0;
        std::size_t chunks = 0;
    };

    SyncClient(FakeTransport& transport, ProtocolServer& server, std::function<void()> pump)
        : transport_(transport), server_(server), pump_(std::move(pump)) {}

    // Opens a subscribed connection. Syncs when there is no read model yet or
    // the reply's seq shows that events were missed.
    void connect() {
        auto upgrade = transport_.connect();
        REQUIRE(upgrade.connection.has_value());
        connection_ = *upgrade.connection;
        consumed_ = 0;
        inbox_.clear();
        transport_.deliver(*connection_,
                           jcs::canonicalize(json::Value(json::Object{{"type", json::Value("auth")},
                                                                      {"token", json::Value(server_.token())},
                                                                      {"events", json::Value(true)}})));
        readNew();
        REQUIRE_FALSE(inbox_.empty());
        hello_ = inbox_.front();
        inbox_.pop_front();
        REQUIRE(member(hello_, "ok").asBool());
        const std::uint64_t seq = parseSeq(member(hello_, "seq"));
        if (!root_ || lastSeq_ < seq) {
            sync();
        }
    }

    void disconnect() {
        REQUIRE(connection_.has_value());
        transport_.disconnect(*connection_);
        connection_.reset();
        inbox_.clear();
    }

    // Handles every frame the server sent since the last call.
    void poll() {
        readNew();
        while (!inbox_.empty()) {
            json::Value frame = std::move(inbox_.front());
            inbox_.pop_front();
            if (!isEventFrame(frame)) {
                continue;  // a late response nobody waits for
            }
            const std::uint64_t seq = parseSeq(member(frame, "seq"));
            if (seq <= lastSeq_) {
                continue;  // already covered by a sync
            }
            if (seq != lastSeq_ + 1) {
                ++gaps_;
                sync();
                continue;
            }
            apply(frame);
            lastSeq_ = seq;
            seqsApplied_.push_back(seq);
        }
    }

    // Sends one request and returns its response; events that arrive
    // meanwhile stay queued for poll(), in order.
    json::Value request(const std::string& method, json::Value params = json::Value(json::Object{})) {
        REQUIRE(connection_.has_value());
        const std::string id = "sync_client_" + std::to_string(++nextRequest_);
        transport_.deliver(*connection_,
                           jcs::canonicalize(json::Value(json::Object{{"requestId", json::Value(id)},
                                                                      {"sessionId", json::Value(server_.sessionId())},
                                                                      {"method", json::Value(method)},
                                                                      {"params", std::move(params)}})));
        pump_();
        readNew();
        for (auto it = inbox_.begin(); it != inbox_.end(); ++it) {
            const json::Value* requestId = it->find("requestId");
            if (requestId != nullptr && requestId->kind() == json::Value::Kind::string && requestId->asString() == id) {
                json::Value response = std::move(*it);
                inbox_.erase(it);
                return response;
            }
        }
        FAIL("no response to " << method);
        return json::Value();
    }

    // The read model as a document (validated by Document::fromJson).
    model::Document document() const {
        REQUIRE(root_.has_value());
        json::Array media;
        json::Array tracks;
        json::Array clips;
        for (const auto& [id, entity] : media_) {
            media.push_back(entity);
        }
        for (const auto& [id, entity] : tracks_) {
            tracks.push_back(entity);
        }
        for (const auto& [id, entity] : clips_) {
            clips.push_back(entity);
        }
        return model::Document::fromJson(json::Value(json::Object{{"schemaVersion", json::Value("siann.session_document.v1")},
                                                                  {"root", *root_},
                                                                  {"media", json::Value(std::move(media))},
                                                                  {"tracks", json::Value(std::move(tracks))},
                                                                  {"clips", json::Value(std::move(clips))}}));
    }

    std::string modelHash() const { return hash::formatHash(document().documentHash()); }

    std::optional<ConnectionId> connection() const noexcept { return connection_; }
    const json::Value& hello() const noexcept { return hello_; }
    std::uint64_t lastSeq() const noexcept { return lastSeq_; }
    const std::string& revision() const noexcept { return revision_; }
    const std::string& documentHash() const noexcept { return documentHash_; }
    std::size_t syncs() const noexcept { return syncs_.size(); }
    const SyncResult& lastSync() const {
        REQUIRE_FALSE(syncs_.empty());
        return syncs_.back();
    }
    std::size_t gaps() const noexcept { return gaps_; }
    std::size_t fetches() const noexcept { return fetches_; }
    const std::vector<std::uint64_t>& seqsApplied() const noexcept { return seqsApplied_; }

    static std::uint64_t parseSeq(const json::Value& value) {
        REQUIRE(value.kind() == json::Value::Kind::string);
        return std::stoull(value.asString());
    }

    static const json::Value& member(const json::Value& object, const char* key) {
        const json::Value* found = object.find(key);
        INFO("missing member " << key);
        REQUIRE(found != nullptr);
        return *found;
    }

private:
    static bool isEventFrame(const json::Value& frame) {
        const json::Value* schema = frame.find("schema");
        return schema != nullptr && schema->kind() == json::Value::Kind::string &&
               schema->asString() == "siann.event.v1";
    }

    void readNew() {
        if (!connection_) {
            return;
        }
        const auto frames = transport_.sent(*connection_);
        for (; consumed_ < frames.size(); ++consumed_) {
            inbox_.push_back(json::parse(frames[consumed_]));
        }
    }

    // Replaces the read model with a full sync, all chunks.
    void sync() {
        std::optional<std::string> cursor;
        SyncResult result;
        std::optional<json::Value> root;
        std::map<std::string, json::Value> media;
        std::map<std::string, json::Value> tracks;
        std::map<std::string, json::Value> clips;
        std::string digest;
        for (;;) {
            json::Object params;
            if (cursor) {
                params.emplace_back("cursor", json::Value(*cursor));
            }
            const json::Value response = request("session.sync", json::Value(std::move(params)));
            INFO(jcs::canonicalize(response));
            REQUIRE(member(response, "ok").asBool());
            const json::Value& body = member(response, "result");
            const std::string revision = member(body, "revision").asString();
            const std::uint64_t seq = parseSeq(member(body, "seq"));
            if (result.chunks == 0) {
                result.revision = revision;
                result.seq = seq;
                digest = member(body, "documentHash").asString();
            } else {
                REQUIRE(revision == result.revision);
                REQUIRE(seq == result.seq);
            }
            ++result.chunks;
            const json::Value& chunk = member(body, "chunk");
            if (const json::Value* r = chunk.find("root")) {
                root = *r;
            }
            const auto take = [&](const char* key, std::map<std::string, json::Value>& into) {
                for (const auto& entity : member(chunk, key).asArray()) {
                    into[member(entity, "id").asString()] = entity;
                }
            };
            take("media", media);
            take("tracks", tracks);
            take("clips", clips);
            const json::Value& next = member(body, "next");
            if (next.isNull()) {
                break;
            }
            cursor = next.asString();
        }
        REQUIRE(root.has_value());
        root_ = std::move(root);
        media_ = std::move(media);
        tracks_ = std::move(tracks);
        clips_ = std::move(clips);
        revision_ = result.revision;
        documentHash_ = digest;
        lastSeq_ = result.seq;
        syncs_.push_back(result);
    }

    void apply(const json::Value& event) {
        const std::string type = member(event, "type").asString();
        const std::string revision = member(event, "revision").asString();
        if (type != "session.changed") {
            revision_ = revision;
            return;
        }
        json::Array refs;
        for (const auto& changed : member(event, "changedIds").asArray()) {
            const std::string ref = member(changed, "ref").asString();
            if (member(changed, "change").asString() == "removed") {
                erase(ref);
            } else {
                refs.push_back(json::Value(ref));
            }
        }
        if (!refs.empty()) {
            ++fetches_;
            const json::Value response = request("session.fetch", json::Value(json::Object{{"refs", json::Value(refs)}}));
            REQUIRE(member(response, "ok").asBool());
            const json::Value& body = member(response, "result");
            if (member(body, "revision").asString() != revision) {
                // More commits happened since this event: fetch is at a later
                // head, so start over from a full read model.
                sync();
                return;
            }
            for (const auto& item : member(body, "entities").asArray()) {
                const std::string ref = member(item, "ref").asString();
                if (const json::Value* entity = item.find("entity")) {
                    put(ref, *entity);
                } else {
                    erase(ref);
                }
            }
        }
        revision_ = revision;
        documentHash_ = member(event, "documentHash").asString();
    }

    std::map<std::string, json::Value>* table(const std::string& type) {
        if (type == "media") {
            return &media_;
        }
        if (type == "track") {
            return &tracks_;
        }
        if (type == "clip") {
            return &clips_;
        }
        return nullptr;
    }

    void put(const std::string& ref, const json::Value& entity) {
        const auto colon = ref.find(':');
        REQUIRE(colon != std::string::npos);
        const std::string type = ref.substr(0, colon);
        if (type == "root") {
            root_ = entity;
            return;
        }
        auto* into = table(type);
        REQUIRE(into != nullptr);
        (*into)[ref.substr(colon + 1)] = entity;
    }

    void erase(const std::string& ref) {
        const auto colon = ref.find(':');
        REQUIRE(colon != std::string::npos);
        if (auto* from = table(ref.substr(0, colon))) {
            from->erase(ref.substr(colon + 1));
        }
    }

    FakeTransport& transport_;
    ProtocolServer& server_;
    std::function<void()> pump_;
    std::optional<ConnectionId> connection_;
    std::size_t consumed_ = 0;
    std::deque<json::Value> inbox_;
    json::Value hello_;
    int nextRequest_ = 0;

    std::optional<json::Value> root_;
    std::map<std::string, json::Value> media_;
    std::map<std::string, json::Value> tracks_;
    std::map<std::string, json::Value> clips_;
    std::string revision_;
    std::string documentHash_;
    std::uint64_t lastSeq_ = 0;
    std::vector<SyncResult> syncs_;
    std::size_t gaps_ = 0;
    std::size_t fetches_ = 0;
    std::vector<std::uint64_t> seqsApplied_;
};

}  // namespace siann::protocol::testing
