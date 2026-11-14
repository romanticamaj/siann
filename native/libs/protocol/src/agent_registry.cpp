#include "agent_registry.hpp"

#include <algorithm>
#include <random>
#include <utility>

namespace siann::protocol::detail {

namespace {

using json::Object;
using json::Value;

std::string randomHex(std::size_t bytes) {
    static constexpr char kDigits[] = "0123456789abcdef";
    std::random_device device;
    std::uniform_int_distribution<unsigned> byte(0, 255);
    std::string out;
    for (std::size_t i = 0; i < bytes; ++i) {
        const unsigned b = byte(device);
        out.push_back(kDigits[b >> 4]);
        out.push_back(kDigits[b & 0xF]);
    }
    return out;
}

bool isSpace(char c) noexcept {
    return c == ' ';
}

void trim(std::string& text) {
    while (!text.empty() && isSpace(text.back())) {
        text.pop_back();
    }
    const auto first = std::find_if_not(text.begin(), text.end(), isSpace);
    text.erase(text.begin(), first);
}

}  // namespace

std::string sanitizeClientName(const Value* name, std::string_view fallback) {
    if (name == nullptr || name->kind() != Value::Kind::string) {
        return std::string(fallback);
    }
    const std::string& given = name->asString();
    std::string out;
    out.reserve(given.size());
    for (std::size_t i = 0; i < given.size(); ++i) {
        const auto byte = static_cast<unsigned char>(given[i]);
        if (byte < 0x20 || byte == 0x7F) {
            continue;  // C0 and DEL
        }
        if (byte == 0xC2 && i + 1 < given.size()) {
            const auto next = static_cast<unsigned char>(given[i + 1]);
            if (next >= 0x80 && next <= 0x9F) {
                ++i;  // C1, two bytes in UTF-8
                continue;
            }
        }
        out.push_back(given[i]);
    }
    trim(out);
    if (out.size() > kClientNameMaxBytes) {
        // Back to the start of the character the limit falls in (the parser
        // only lets valid UTF-8 through, so continuation bytes are 10xxxxxx).
        std::size_t cut = kClientNameMaxBytes;
        while (cut > 0 && (static_cast<unsigned char>(out[cut]) & 0xC0) == 0x80) {
            --cut;
        }
        out.resize(cut);
        trim(out);
    }
    return out.empty() ? std::string(fallback) : out;
}

Value agentJson(const AgentView& agent) {
    return Value(Object{{"id", Value(agent.id)},
                        {"name", Value(agent.name)},
                        {"transport", Value("mcp")},
                        {"connected", Value(agent.connected)},
                        {"lastAction", agent.lastAction ? Value(*agent.lastAction) : Value(nullptr)},
                        {"lastActionAt", agent.lastActionAt ? Value(*agent.lastActionAt) : Value(nullptr)}});
}

AgentRegistry::AgentRegistry(std::size_t retained, Clock clock, std::function<void()> changed)
    : retained_(std::max<std::size_t>(retained, 1)), clock_(std::move(clock)), changed_(std::move(changed)) {}

std::string AgentRegistry::connect(std::string name) {
    std::string session = "mcp_" + randomHex(16);
    {
        std::lock_guard lock(mutex_);
        if (agents_.size() >= retained_) {
            auto oldest = std::find_if(agents_.begin(), agents_.end(),
                                       [](const Entry& entry) { return !entry.view.connected; });
            agents_.erase(oldest != agents_.end() ? oldest : agents_.begin());
        }
        Entry entry;
        entry.view.id = "agt_" + randomHex(8);
        entry.view.name = std::move(name);
        entry.view.connected = true;
        entry.session = session;
        entry.lastSeen = clock_();
        agents_.push_back(std::move(entry));
    }
    changed_();
    return session;
}

std::optional<AgentRegistry::Caller> AgentRegistry::seen(const std::string& session) {
    std::optional<Caller> caller;
    bool reconnected = false;
    {
        std::lock_guard lock(mutex_);
        for (Entry& entry : agents_) {
            if (entry.session == session) {
                entry.lastSeen = clock_();
                reconnected = !entry.view.connected;
                entry.view.connected = true;
                caller = Caller{entry.view.id, entry.view.name};
                break;
            }
        }
    }
    if (reconnected) {
        changed_();
    }
    return caller;
}

bool AgentRegistry::end(const std::string& session) {
    {
        std::lock_guard lock(mutex_);
        const auto it = std::find_if(agents_.begin(), agents_.end(),
                                     [&](const Entry& entry) { return entry.session == session; });
        if (it == agents_.end()) {
            return false;
        }
        it->session.reset();
        it->view.connected = false;
    }
    changed_();
    return true;
}

void AgentRegistry::acted(const std::string& agentId, std::string tool, std::string time) {
    std::lock_guard lock(mutex_);
    for (Entry& entry : agents_) {
        if (entry.view.id == agentId) {
            entry.view.lastAction = std::move(tool);
            entry.view.lastActionAt = std::move(time);
            ++entry.view.actions;
            return;
        }
    }
}

void AgentRegistry::expire(std::chrono::milliseconds idle) {
    std::lock_guard lock(mutex_);
    const auto now = clock_();
    for (Entry& entry : agents_) {
        if (entry.view.connected && now - entry.lastSeen >= idle) {
            entry.view.connected = false;
        }
    }
}

std::vector<AgentView> AgentRegistry::snapshot() const {
    std::lock_guard lock(mutex_);
    std::vector<AgentView> out;
    out.reserve(agents_.size());
    for (const Entry& entry : agents_) {
        out.push_back(entry.view);
    }
    return out;
}

}  // namespace siann::protocol::detail
