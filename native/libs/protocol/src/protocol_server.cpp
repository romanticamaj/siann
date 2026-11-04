#include "siann/protocol/protocol_server.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <ctime>
#include <deque>
#include <exception>
#include <map>
#include <mutex>
#include <optional>
#include <string_view>
#include <random>
#include <thread>
#include <unordered_map>
#include <utility>

#include "request_inbox.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/read_model.hpp"
#include "siann/command/command.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/session/journal.hpp"

namespace siann::protocol {

namespace {

using json::Array;
using json::Object;
using json::Value;

// WebSocket close code 1008: policy violation (RFC 6455, section 7.4.1).
constexpr int kClosePolicy = 1008;

std::string randomHex(std::size_t bytes) {
    static constexpr char kDigits[] = "0123456789abcdef";
    std::random_device device;
    std::uniform_int_distribution<unsigned> byte(0, 255);
    std::string out;
    out.reserve(bytes * 2);
    for (std::size_t i = 0; i < bytes; ++i) {
        const unsigned b = byte(device);
        out.push_back(kDigits[b >> 4]);
        out.push_back(kDigits[b & 0xF]);
    }
    return out;
}

// Compares secrets without an early exit on the first differing byte.
bool sameSecret(std::string_view a, std::string_view b) noexcept {
    if (a.size() != b.size()) {
        return false;
    }
    unsigned char diff = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        diff = static_cast<unsigned char>(diff | (static_cast<unsigned char>(a[i]) ^ static_cast<unsigned char>(b[i])));
    }
    return diff == 0;
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

const Value* stringMember(const Value& object, std::string_view key) {
    const Value* member = object.find(key);
    return member != nullptr && member->kind() == Value::Kind::string ? member : nullptr;
}

// Length of the well-formed UTF-8 sequence at text[pos] (RFC 3629: no
// overlong forms, no surrogates, nothing above U+10FFFF), or 0.
std::size_t utf8Length(std::string_view text, std::size_t pos) noexcept {
    const auto byte = [&](std::size_t i) { return static_cast<unsigned char>(text[pos + i]); };
    const unsigned char first = byte(0);
    if (first < 0x80) {
        return 1;
    }
    std::size_t length = 0;
    unsigned char low = 0x80;
    unsigned char high = 0xBF;
    if (first >= 0xC2 && first <= 0xDF) {
        length = 2;
    } else if (first >= 0xE0 && first <= 0xEF) {
        length = 3;
        low = first == 0xE0 ? 0xA0 : 0x80;
        high = first == 0xED ? 0x9F : 0xBF;
    } else if (first >= 0xF0 && first <= 0xF4) {
        length = 4;
        low = first == 0xF0 ? 0x90 : 0x80;
        high = first == 0xF4 ? 0x8F : 0xBF;
    } else {
        return 0;
    }
    if (pos + length > text.size() || byte(1) < low || byte(1) > high) {
        return 0;
    }
    for (std::size_t i = 2; i < length; ++i) {
        if (byte(i) < 0x80 || byte(i) > 0xBF) {
            return 0;
        }
    }
    return length;
}

// Messages can carry bytes that are not UTF-8 (an exception's what() with a
// Windows path in the ANSI code page); canonical JSON would throw on them.
// Each offending byte becomes U+FFFD.
std::string validUtf8(std::string_view text) {
    std::string out;
    out.reserve(text.size());
    std::size_t pos = 0;
    while (pos < text.size()) {
        const std::size_t length = utf8Length(text, pos);
        if (length == 0) {
            out += "\xEF\xBF\xBD";
            ++pos;
        } else {
            out.append(text.substr(pos, length));
            pos += length;
        }
    }
    return out;
}

Value errorValue(const std::string& code, const std::string& message, std::optional<std::size_t> step = {}) {
    Object error{{"code", Value(validUtf8(code))}, {"message", Value(validUtf8(message))}};
    if (step) {
        error.emplace_back("step", Value(static_cast<double>(*step)));
    }
    return Value(std::move(error));
}

std::string failure(Value requestId, const std::string& code, const std::string& message,
                    std::optional<std::size_t> step = {}) {
    return jcs::canonicalize(Value(Object{{"requestId", std::move(requestId)},
                                          {"ok", Value(false)},
                                          {"error", errorValue(code, message, step)}}));
}

std::string success(const std::string& requestId, Value result) {
    return jcs::canonicalize(
        Value(Object{{"requestId", Value(requestId)}, {"ok", Value(true)}, {"result", std::move(result)}}));
}

Value revisionJson(const command::Revision& revision) {
    Array diff;
    for (const auto& entry : revision.diff) {
        diff.push_back(Value(std::string(model::entityTypeName(entry.entity.type)) + ":" + entry.entity.id));
    }
    Object out = session::envelopeToJson(revision.envelope).asObject();
    out.emplace_back("diff", Value(std::move(diff)));
    if (revision.target) {
        out.emplace_back("target", Value(*revision.target));
    }
    return Value(std::move(out));
}

HttpResponse jsonResponse(int status, std::string body) {
    return HttpResponse{status, "application/json", std::move(body)};
}

std::string httpError(const std::string& code, const std::string& message) {
    return jcs::canonicalize(Value(Object{{"ok", Value(false)}, {"error", errorValue(code, message)}}));
}

struct Pending {
    ConnectionId connection = 0;
    std::string requestId;
    std::string method;
    Value params;
    std::optional<std::string> expectedRevision;  // checked against the head before the method runs
};

struct Connection {
    bool authenticated = false;
    bool realtime = false;  // opened on kRealtimePath: binary frames only
};

}  // namespace

struct ProtocolServer::Impl {
    Impl(Transport& t, session::Session& s, ServerOptions o)
        : transport(t),
          session(s),
          options(std::move(o)),
          token(randomHex(32)),
          sessionId("ses_" + randomHex(16)),
          inbox(options.inboxCapacity),
          events(t, sessionId,
                 StreamPosition{0, s.history().head().envelope.id,
                                hash::formatHash(s.history().head().envelope.documentHash), json::Value()},
                 options.events),
          readModel(options.syncChunkEntities),
          realtime(t, options.realtime) {
        if (!options.clock) {
            options.clock = nowUtc;
        }
    }

    Transport& transport;
    session::Session& session;
    ServerOptions options;
    const std::string token;
    const std::string sessionId;
    std::uint16_t port = 0;
    detail::RequestInbox<Pending> inbox;
    EventStream events;
    ReadModel readModel;
    RealtimeChannel realtime;

    std::mutex mutex;                              // guards connections
    std::map<ConnectionId, Connection> connections;

    std::mutex pumpMutex;                          // one consumer at a time
    std::unordered_map<std::string, std::string> cache;  // requestId -> response text
    std::deque<std::string> cacheOrder;

    bool started = false;
    std::atomic<bool> running{false};
    std::thread pumpThread;

    std::optional<HttpResponse> onUpgrade(const HttpRequest& request) const {
        auto origin = request.headers.find("origin");
        if (origin == request.headers.end()) {
            return std::nullopt;
        }
        const auto& allowed = options.allowedOrigins;
        if (std::find(allowed.begin(), allowed.end(), origin->second) != allowed.end()) {
            return std::nullopt;
        }
        // The header bytes are not echoed: they come unchecked from the client
        // and need not be valid UTF-8, which canonical JSON requires.
        return jsonResponse(403, httpError("origin_not_allowed", "this Origin is not allowed"));
    }

    HttpResponse onHttp(const HttpRequest& request) const {
        auto authorization = request.headers.find("authorization");
        if (authorization == request.headers.end() ||
            !sameSecret(authorization->second, "Bearer " + token)) {
            return jsonResponse(401, httpError("unauthenticated", "Authorization: Bearer <token> is required"));
        }
        if (request.method == "GET" && request.path == "/v0/health") {
            return jsonResponse(200, R"({"ok":true})");
        }
        // Method and path are not echoed, for the same reason as the Origin.
        return jsonResponse(404, httpError("not_found", "no route for this method and path"));
    }

    void onOpen(ConnectionId connection, const std::string& path) {
        std::lock_guard lock(mutex);
        connections[connection] = Connection{false, path == kRealtimePath};
    }

    void onClose(ConnectionId connection) {
        std::lock_guard lock(mutex);
        connections.erase(connection);
        events.unsubscribe(connection);
        realtime.remove(connection);
        readModel.forget(connection);
    }

    // A realtime connection: one auth frame, then nothing but outgoing binary
    // frames. No text is ever sent on it; refusals are a close with a reason.
    void onRealtimeMessage(ConnectionId connection, bool authenticated, const std::optional<Value>& parsed) {
        if (authenticated) {
            realtime.remove(connection);
            transport.close(connection, kClosePolicy, "binary_only");
            return;
        }
        const bool isObject = parsed && parsed->kind() == Value::Kind::object;
        const Value* type = isObject ? stringMember(*parsed, "type") : nullptr;
        if (type == nullptr || type->asString() != "auth") {
            transport.close(connection, kClosePolicy, "unauthenticated");
            return;
        }
        const Value* given = stringMember(*parsed, "token");
        if (given == nullptr || !sameSecret(given->asString(), token)) {
            transport.close(connection, kClosePolicy, "invalid_token");
            return;
        }
        std::lock_guard lock(mutex);
        auto it = connections.find(connection);
        if (it == connections.end()) {
            return;
        }
        it->second.authenticated = true;
        realtime.add(connection);
    }

    void reject(ConnectionId connection, const std::string& text, const std::string& code) {
        transport.send(connection, text);
        transport.close(connection, kClosePolicy, code);
    }

    void onMessage(ConnectionId connection, const std::string& text) {
        Connection state;
        {
            std::lock_guard lock(mutex);
            auto it = connections.find(connection);
            if (it == connections.end()) {
                return;
            }
            state = it->second;
        }
        const bool authenticated = state.authenticated;

        std::optional<Value> parsed;
        try {
            parsed = json::parse(text);
        } catch (const json::ParseError&) {
        }
        if (state.realtime) {
            onRealtimeMessage(connection, authenticated, parsed);
            return;
        }
        const bool isObject = parsed && parsed->kind() == Value::Kind::object;
        const Value* requestIdMember = isObject ? stringMember(*parsed, "requestId") : nullptr;
        const Value requestId = requestIdMember != nullptr ? *requestIdMember : Value(nullptr);

        if (!authenticated) {
            const Value* type = isObject ? stringMember(*parsed, "type") : nullptr;
            if (type == nullptr || type->asString() != "auth") {
                reject(connection, failure(requestId, "unauthenticated", "authenticate first: {type:\"auth\", token}"),
                       "unauthenticated");
                return;
            }
            const Value* given = stringMember(*parsed, "token");
            if (given == nullptr || !sameSecret(given->asString(), token)) {
                reject(connection,
                       jcs::canonicalize(Value(Object{{"type", Value("auth")},
                                                      {"ok", Value(false)},
                                                      {"error", errorValue("invalid_token", "wrong token")}})),
                       "invalid_token");
                return;
            }
            const Value* wantsEvents = parsed->find("events");
            const bool subscribe = wantsEvents != nullptr && wantsEvents->kind() == Value::Kind::boolean &&
                                   wantsEvents->asBool();
            const auto reply = [this](const StreamPosition& current) {
                return jcs::canonicalize(Value(Object{{"type", Value("auth")},
                                                      {"ok", Value(true)},
                                                      {"sessionId", Value(sessionId)},
                                                      {"revision", Value(current.revision)},
                                                      {"documentHash", Value(current.documentHash)},
                                                      {"seq", Value(std::to_string(current.seq))},
                                                      {"meters", current.meters},
                                                      {"about", aboutJson()}}));
            };
            std::lock_guard lock(mutex);
            auto it = connections.find(connection);
            if (it == connections.end()) {
                return;
            }
            it->second.authenticated = true;
            // Under the connection lock, so a close cannot leave an outbox
            // behind; the stream sends the reply before any event.
            if (subscribe) {
                events.subscribe(connection, reply);
            } else {
                transport.send(connection, reply(events.position()));
            }
            return;
        }

        if (!isObject) {
            transport.send(connection, failure(nullptr, "bad_request", "a request is a JSON object"));
            return;
        }
        if (requestIdMember == nullptr) {
            transport.send(connection, failure(nullptr, "bad_request", "a request needs a string requestId"));
            return;
        }
        const Value* targetSession = stringMember(*parsed, "sessionId");
        if (targetSession == nullptr) {
            transport.send(connection, failure(requestId, "bad_request", "a request needs a string sessionId"));
            return;
        }
        const Value* method = stringMember(*parsed, "method");
        if (method == nullptr) {
            transport.send(connection, failure(requestId, "bad_request", "a request needs a string method"));
            return;
        }
        Value params = Value(Object{});
        if (const Value* given = parsed->find("params")) {
            if (given->kind() != Value::Kind::object) {
                transport.send(connection, failure(requestId, "bad_request", "params must be an object"));
                return;
            }
            params = *given;
        }
        std::optional<std::string> expectedRevision;
        if (const Value* expected = parsed->find("expectedRevision")) {
            if (expected->kind() != Value::Kind::string) {
                transport.send(connection, failure(requestId, "bad_request", "expectedRevision must be a string"));
                return;
            }
            expectedRevision = expected->asString();
        }
        if (targetSession->asString() != sessionId) {
            transport.send(connection,
                           failure(requestId, "session_mismatch", "this server serves session " + sessionId));
            return;
        }
        if (!inbox.tryPush(Pending{connection, requestIdMember->asString(), method->asString(), std::move(params),
                                   std::move(expectedRevision)})) {
            transport.send(connection, failure(requestId, "queue_full", "the command inbox is full; retry"));
        }
    }

    // Command thread: a revision the method just committed. The event goes
    // out after the response (handle() flushes after sending it).
    std::string published(const Pending& request, const command::Revision& revision) {
        std::string response = success(request.requestId, Value(Object{{"revision", revisionJson(revision)}}));
        events.publishRevision(revision);
        return response;
    }

    // Command thread.
    std::string execute(const Pending& request) {
        try {
            if (request.expectedRevision) {
                const std::string& current = session.history().head().envelope.id;
                if (*request.expectedRevision != current) {
                    return failure(Value(request.requestId), "revision_mismatch",
                                   "expected revision " + *request.expectedRevision + " but the head is " + current);
                }
            }
            if (request.method == "session.inspect") {
                const auto& history = session.history();
                return success(request.requestId,
                               Value(Object{{"revision", Value(history.head().envelope.id)},
                                            {"documentHash", Value(hash::formatHash(history.head().envelope.documentHash))},
                                            {"revisions", Value(static_cast<double>(history.revisions().size()))}}));
            }
            if (request.method == "command.execute") {
                const Value* list = request.params.find("commands");
                if (list == nullptr || list->kind() != Value::Kind::array || list->asArray().empty()) {
                    return failure(Value(request.requestId), "invalid_params",
                                   "command.execute needs a non-empty commands array");
                }
                std::vector<command::Command> commands;
                const auto& items = list->asArray();
                for (std::size_t i = 0; i < items.size(); ++i) {
                    try {
                        commands.push_back(command::Command::fromJson(items[i]));
                    } catch (const command::CommandError& e) {
                        throw command::CommandError(e.code(), e.what(), i);
                    }
                }
                const command::Revision* revision = &session.commit(std::move(commands), options.actor, options.clock());
                return published(request, *revision);
            }
            if (request.method == "session.undo") {
                return published(request, session.undo(options.actor, options.clock()));
            }
            if (request.method == "session.redo") {
                return published(request, session.redo(options.actor, options.clock()));
            }
            if (request.method == "session.sync") {
                return success(request.requestId,
                               readModel.sync(request.connection, request.params, session.history(), events.position()));
            }
            if (request.method == "session.fetch") {
                return success(request.requestId, readModel.fetch(request.params, session.history()));
            }
            if (request.method == "engine.about") {
                return success(request.requestId, aboutJson());
            }
            return failure(Value(request.requestId), "unknown_method", "unknown method " + request.method);
        } catch (const ProtocolError& e) {
            return failure(Value(request.requestId), e.code(), e.what());
        } catch (const command::CommandError& e) {
            return failure(Value(request.requestId), e.code(), e.what(), e.step());
        } catch (const session::SessionError& e) {
            return failure(Value(request.requestId), e.code(), e.what());
        } catch (const std::exception& e) {
            return failure(Value(request.requestId), "internal_error", e.what());
        } catch (...) {
            return failure(Value(request.requestId), "internal_error", "the method threw a non-standard exception");
        }
    }

    void remember(const std::string& requestId, const std::string& response) {
        const std::size_t capacity = std::max<std::size_t>(options.idempotencyCapacity, 1);
        while (cacheOrder.size() >= capacity) {
            cache.erase(cacheOrder.front());
            cacheOrder.pop_front();
        }
        cache.emplace(requestId, response);
        cacheOrder.push_back(requestId);
    }

    // Command thread, under pumpMutex.
    void handle(std::vector<Pending> requests) {
        for (const auto& request : requests) {
            auto cached = cache.find(request.requestId);
            if (cached != cache.end()) {
                transport.send(request.connection, cached->second);
                continue;
            }
            std::string response = execute(request);
            remember(request.requestId, response);
            transport.send(request.connection, response);
        }
        events.flush();
    }

    void stopPumpThread() {
        running = false;
        inbox.wake();
        if (pumpThread.joinable()) {
            pumpThread.join();
        }
    }
};

ProtocolServer::ProtocolServer(Transport& transport, session::Session& session, ServerOptions options)
    : impl_(std::make_unique<Impl>(transport, session, std::move(options))) {
    Impl* impl = impl_.get();
    TransportHandlers handlers;
    handlers.onUpgrade = [impl](const HttpRequest& request) { return impl->onUpgrade(request); };
    handlers.onOpen = [impl](ConnectionId connection, const std::string& path) { impl->onOpen(connection, path); };
    handlers.onMessage = [impl](ConnectionId connection, const std::string& text) { impl->onMessage(connection, text); };
    handlers.onClose = [impl](ConnectionId connection) { impl->onClose(connection); };
    handlers.onHttp = [impl](const HttpRequest& request) { return impl->onHttp(request); };
    impl_->transport.setHandlers(std::move(handlers));
}

ProtocolServer::~ProtocolServer() {
    stop();
}

void ProtocolServer::start() {
    if (impl_->started) {
        return;
    }
    impl_->port = impl_->transport.listen(impl_->options.host, impl_->options.port).port;
    impl_->started = true;
    if (impl_->options.pumpThread) {
        impl_->running = true;
        Impl* impl = impl_.get();
        impl_->pumpThread = std::thread([impl] {
            while (impl->running) {
                // A condition wait: wakes on a request or on stop(); the
                // timeout only bounds a missed wake-up.
                auto requests = impl->inbox.waitDrain(std::chrono::milliseconds(250));
                std::lock_guard lock(impl->pumpMutex);
                try {
                    impl->handle(std::move(requests));
                } catch (...) {
                    // execute() answers every exception itself; this only
                    // keeps the thread alive if sending or caching throws
                    // (bad_alloc, say). An exception leaving a thread
                    // function would end the process.
                }
            }
        });
    }
}

void ProtocolServer::stop() {
    impl_->stopPumpThread();
    if (impl_->started) {
        impl_->transport.stop();
        impl_->started = false;
    }
}

std::size_t ProtocolServer::pump() {
    std::lock_guard lock(impl_->pumpMutex);
    auto requests = impl_->inbox.drain();
    const std::size_t count = requests.size();
    impl_->handle(std::move(requests));
    return count;
}

const std::string& ProtocolServer::token() const noexcept {
    return impl_->token;
}

const std::string& ProtocolServer::sessionId() const noexcept {
    return impl_->sessionId;
}

std::uint16_t ProtocolServer::port() const noexcept {
    return impl_->port;
}

void ProtocolServer::publishRevision(const command::Revision& revision) {
    impl_->events.publishRevision(revision);
}

EventStream& ProtocolServer::events() noexcept {
    return impl_->events;
}

RealtimeChannel& ProtocolServer::realtime() noexcept {
    return impl_->realtime;
}

}  // namespace siann::protocol
