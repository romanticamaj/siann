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
#include <random>
#include <thread>
#include <unordered_map>
#include <utility>

#include "request_inbox.hpp"
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

Value errorValue(const std::string& code, const std::string& message, std::optional<std::size_t> step = {}) {
    Object error{{"code", Value(code)}, {"message", Value(message)}};
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

// What the authentication reply reports, kept current by the command thread.
struct Head {
    std::string revision;
    std::string documentHash;
    std::size_t revisions = 0;
};

}  // namespace

struct ProtocolServer::Impl {
    Impl(Transport& t, session::Session& s, ServerOptions o)
        : transport(t),
          session(s),
          options(std::move(o)),
          token(randomHex(32)),
          sessionId("ses_" + randomHex(16)),
          inbox(options.inboxCapacity) {
        if (!options.clock) {
            options.clock = nowUtc;
        }
        refreshHead();
    }

    Transport& transport;
    session::Session& session;
    ServerOptions options;
    const std::string token;
    const std::string sessionId;
    std::uint16_t port = 0;
    detail::RequestInbox<Pending> inbox;

    std::mutex mutex;                              // guards connections and head
    std::map<ConnectionId, bool> connections;      // open connection -> authenticated
    Head head;

    std::mutex pumpMutex;                          // one consumer at a time
    std::unordered_map<std::string, std::string> cache;  // requestId -> response text
    std::deque<std::string> cacheOrder;

    bool started = false;
    std::atomic<bool> running{false};
    std::thread pumpThread;

    // Command thread only (under pumpMutex), or the constructor.
    void refreshHead() {
        const auto& history = session.history();
        Head next{history.head().envelope.id, hash::formatHash(history.head().envelope.documentHash),
                  history.revisions().size()};
        std::lock_guard lock(mutex);
        head = std::move(next);
    }

    std::optional<HttpResponse> onUpgrade(const HttpRequest& request) const {
        auto origin = request.headers.find("origin");
        if (origin == request.headers.end()) {
            return std::nullopt;
        }
        const auto& allowed = options.allowedOrigins;
        if (std::find(allowed.begin(), allowed.end(), origin->second) != allowed.end()) {
            return std::nullopt;
        }
        return jsonResponse(403, httpError("origin_not_allowed", "Origin " + origin->second + " is not allowed"));
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
        return jsonResponse(404, httpError("not_found", "no route " + request.method + " " + request.path));
    }

    void onOpen(ConnectionId connection) {
        std::lock_guard lock(mutex);
        connections[connection] = false;
    }

    void onClose(ConnectionId connection) {
        std::lock_guard lock(mutex);
        connections.erase(connection);
    }

    void reject(ConnectionId connection, const std::string& text, const std::string& code) {
        transport.send(connection, text);
        transport.close(connection, kClosePolicy, code);
    }

    void onMessage(ConnectionId connection, const std::string& text) {
        bool authenticated = false;
        {
            std::lock_guard lock(mutex);
            auto it = connections.find(connection);
            if (it == connections.end()) {
                return;
            }
            authenticated = it->second;
        }

        std::optional<Value> parsed;
        try {
            parsed = json::parse(text);
        } catch (const json::ParseError&) {
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
            Head current;
            {
                std::lock_guard lock(mutex);
                auto it = connections.find(connection);
                if (it == connections.end()) {
                    return;
                }
                it->second = true;
                current = head;
            }
            transport.send(connection, jcs::canonicalize(Value(Object{{"type", Value("auth")},
                                                                      {"ok", Value(true)},
                                                                      {"sessionId", Value(sessionId)},
                                                                      {"revision", Value(current.revision)},
                                                                      {"documentHash", Value(current.documentHash)}})));
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
                const command::Revision& revision =
                    session.commit(std::move(commands), options.actor, options.clock());
                Value result(Object{{"revision", revisionJson(revision)}});
                refreshHead();
                return success(request.requestId, std::move(result));
            }
            return failure(Value(request.requestId), "unknown_method", "unknown method " + request.method);
        } catch (const command::CommandError& e) {
            return failure(Value(request.requestId), e.code(), e.what(), e.step());
        } catch (const session::SessionError& e) {
            return failure(Value(request.requestId), e.code(), e.what());
        } catch (const std::exception& e) {
            return failure(Value(request.requestId), "internal_error", e.what());
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
    handlers.onOpen = [impl](ConnectionId connection) { impl->onOpen(connection); };
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
                impl->handle(std::move(requests));
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

}  // namespace siann::protocol
