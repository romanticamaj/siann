#pragma once

// Requests from the user to a connected agent (spec, Protocol v0 item 32,
// m5b-engine-agent-requests; human gate agent-request-shape). A request is a
// message: the UI queues it for an agent, the agent takes it with next_request
// and answers it with a plan, a message or a decline. It executes nothing: its
// text and context are data for the agent, and a plan the user approves stays
// the only way into the document.
//
// Command thread only, so no mutex: the protocol server's handle() is the only
// caller. Requests are engine state, never a revision; nothing here is written
// to the bundle or the journal, and an engine restart drops every request.
// Nothing here touches the audio thread.

#include <cstddef>
#include <deque>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/json.hpp"

namespace siann::protocol::detail {

enum class RequestState { pending, taken, answered, declined, cancelled, expired };

std::string_view requestStateName(RequestState state) noexcept;

// The gate's bounds: 4,000 characters per text, the closed requests kept for
// agent.requests, and the ids a selection list may hold.
inline constexpr std::size_t kRequestTextMaxChars = 4000;
inline constexpr std::size_t kRequestsClosedRetained = 16;
inline constexpr std::size_t kSelectionMaxIds = 256;

struct AgentRequest {
    std::string id;  // arq_<hex>
    std::string agentId;
    std::string text;
    json::Value context;  // {selection, locators, cursor, headRevision}, stamped by the engine
    RequestState state = RequestState::pending;
    std::optional<std::string> plan;     // the plan hash that answered it
    std::optional<std::string> message;  // the agent's answer or reason
    std::string createdAt;

    bool open() const noexcept { return state == RequestState::pending || state == RequestState::taken; }
};

// {id, agentId, text, context, state, plan?, message?, createdAt}.
json::Value requestJson(const AgentRequest& request);

// A request's text or an agent's message: 1 to kRequestTextMaxChars code
// points of well-formed UTF-8 without a control character other than tab, LF
// and CR and without a display-unsafe character (siann/model/display_text.hpp).
// Throws ProtocolError invalid_request_text naming `what`.
void checkRequestText(std::string_view text, std::string_view what);

class AgentRequestStore {
public:
    // At most `perAgent` open requests per agent.
    explicit AgentRequestStore(std::size_t perAgent);

    std::size_t perAgent() const noexcept { return perAgent_; }

    // Queues a pending request. Throws ProtocolError agent_busy when the agent
    // already has perAgent() open requests (nothing is queued then).
    const AgentRequest& queue(std::string agentId, std::string text, json::Value context, std::string createdAt);

    // The agent's oldest pending request, now taken; nullopt when it has none.
    std::optional<AgentRequest> take(const std::string& agentId);
    bool hasPending(const std::string& agentId) const;

    // An open request by id, or nullptr.
    const AgentRequest* findOpen(const std::string& id) const;
    // An open or a retained closed request by id, or nullptr.
    const AgentRequest* find(const std::string& id) const;

    // Closes an open request (the caller checked it is open) with its final
    // state; returns it as closed.
    AgentRequest close(const std::string& id, RequestState state, std::optional<std::string> plan = std::nullopt,
                       std::optional<std::string> message = std::nullopt);

    // Expires the agent's open requests, or every open request; returns them in
    // the order they were queued.
    std::vector<AgentRequest> expireAgent(const std::string& agentId);
    std::vector<AgentRequest> expireAll();

    // The agents with an open request, in the order of their oldest one.
    std::vector<std::string> agentsWithOpen() const;

    // agent.requests: the open requests oldest first, then the retained closed
    // ones in the order they closed.
    std::vector<AgentRequest> list() const;

private:
    void retain(AgentRequest closed);

    std::size_t perAgent_;
    std::vector<AgentRequest> open_;    // queue order
    std::deque<AgentRequest> closed_;  // closing order, at most kRequestsClosedRetained
};

}  // namespace siann::protocol::detail
