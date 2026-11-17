#include "agent_requests.hpp"

#include <algorithm>
#include <random>
#include <utility>

#include "siann/model/display_text.hpp"
#include "siann/protocol/read_model.hpp"

namespace siann::protocol::detail {

namespace {

using json::Object;
using json::Value;

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

// Code points of text that is well-formed UTF-8: the bytes that do not continue
// a sequence (10xxxxxx).
std::size_t codePoints(std::string_view text) noexcept {
    return static_cast<std::size_t>(std::count_if(
        text.begin(), text.end(), [](char c) { return (static_cast<unsigned char>(c) & 0xC0) != 0x80; }));
}

}  // namespace

std::string_view requestStateName(RequestState state) noexcept {
    switch (state) {
        case RequestState::pending: return "pending";
        case RequestState::taken: return "taken";
        case RequestState::answered: return "answered";
        case RequestState::declined: return "declined";
        case RequestState::cancelled: return "cancelled";
        case RequestState::expired: return "expired";
    }
    return "pending";
}

Value requestJson(const AgentRequest& request) {
    Object out{{"id", Value(request.id)},
               {"agentId", Value(request.agentId)},
               {"text", Value(request.text)},
               {"context", request.context},
               {"state", Value(std::string(requestStateName(request.state)))},
               {"createdAt", Value(request.createdAt)}};
    if (request.plan) {
        out.emplace_back("plan", Value(*request.plan));
    }
    if (request.message) {
        out.emplace_back("message", Value(*request.message));
    }
    return Value(std::move(out));
}

void checkRequestText(std::string_view text, std::string_view what) {
    switch (model::textFault(text, "\t\n\r")) {
        case model::TextFault::none: break;
        case model::TextFault::invalid_utf8:
            throw ProtocolError("invalid_request_text", std::string(what) + " is not well-formed UTF-8");
        case model::TextFault::control:
            throw ProtocolError("invalid_request_text",
                                std::string(what) + " holds a control character other than tab, LF and CR");
        case model::TextFault::display_unsafe:
            throw ProtocolError("invalid_request_text",
                                std::string(what) + " holds a bidi formatting character or a line separator");
    }
    const std::size_t count = codePoints(text);
    if (count == 0 || count > kRequestTextMaxChars) {
        throw ProtocolError("invalid_request_text", std::string(what) + " must be 1 to 4000 characters");
    }
}

AgentRequestStore::AgentRequestStore(std::size_t perAgent) : perAgent_(std::max<std::size_t>(perAgent, 1)) {}

const AgentRequest& AgentRequestStore::queue(std::string agentId, std::string text, Value context,
                                             std::string createdAt) {
    const auto open = static_cast<std::size_t>(std::count_if(
        open_.begin(), open_.end(), [&](const AgentRequest& request) { return request.agentId == agentId; }));
    if (open >= perAgent_) {
        throw ProtocolError("agent_busy", "the agent has " + std::to_string(open) + " open requests, the most it may hold");
    }
    AgentRequest request;
    request.id = "arq_" + randomHex(8);
    request.agentId = std::move(agentId);
    request.text = std::move(text);
    request.context = std::move(context);
    request.createdAt = std::move(createdAt);
    open_.push_back(std::move(request));
    return open_.back();
}

std::optional<AgentRequest> AgentRequestStore::take(const std::string& agentId) {
    for (AgentRequest& request : open_) {
        if (request.agentId == agentId && request.state == RequestState::pending) {
            request.state = RequestState::taken;
            return request;
        }
    }
    return std::nullopt;
}

bool AgentRequestStore::hasPending(const std::string& agentId) const {
    return std::any_of(open_.begin(), open_.end(), [&](const AgentRequest& request) {
        return request.agentId == agentId && request.state == RequestState::pending;
    });
}

const AgentRequest* AgentRequestStore::findOpen(const std::string& id) const {
    const auto it = std::find_if(open_.begin(), open_.end(), [&](const AgentRequest& request) { return request.id == id; });
    return it == open_.end() ? nullptr : &*it;
}

const AgentRequest* AgentRequestStore::find(const std::string& id) const {
    if (const AgentRequest* open = findOpen(id)) {
        return open;
    }
    const auto it =
        std::find_if(closed_.begin(), closed_.end(), [&](const AgentRequest& request) { return request.id == id; });
    return it == closed_.end() ? nullptr : &*it;
}

void AgentRequestStore::retain(AgentRequest closed) {
    closed_.push_back(std::move(closed));
    while (closed_.size() > kRequestsClosedRetained) {
        closed_.pop_front();
    }
}

AgentRequest AgentRequestStore::close(const std::string& id, RequestState state, std::optional<std::string> plan,
                                      std::optional<std::string> message) {
    const auto it = std::find_if(open_.begin(), open_.end(), [&](const AgentRequest& request) { return request.id == id; });
    AgentRequest closed = std::move(*it);
    open_.erase(it);
    closed.state = state;
    closed.plan = std::move(plan);
    closed.message = std::move(message);
    retain(closed);
    return closed;
}

std::vector<AgentRequest> AgentRequestStore::expireAgent(const std::string& agentId) {
    std::vector<AgentRequest> expired;
    std::vector<AgentRequest> kept;
    for (AgentRequest& request : open_) {
        if (request.agentId == agentId) {
            request.state = RequestState::expired;
            expired.push_back(std::move(request));
        } else {
            kept.push_back(std::move(request));
        }
    }
    open_ = std::move(kept);
    for (const AgentRequest& request : expired) {
        retain(request);
    }
    return expired;
}

std::vector<AgentRequest> AgentRequestStore::expireAll() {
    std::vector<AgentRequest> expired = std::move(open_);
    open_.clear();
    for (AgentRequest& request : expired) {
        request.state = RequestState::expired;
        retain(request);
    }
    return expired;
}

std::vector<std::string> AgentRequestStore::agentsWithOpen() const {
    std::vector<std::string> out;
    for (const AgentRequest& request : open_) {
        if (std::find(out.begin(), out.end(), request.agentId) == out.end()) {
            out.push_back(request.agentId);
        }
    }
    return out;
}

std::vector<AgentRequest> AgentRequestStore::list() const {
    std::vector<AgentRequest> out(open_.begin(), open_.end());
    out.insert(out.end(), closed_.begin(), closed_.end());
    return out;
}

}  // namespace siann::protocol::detail
