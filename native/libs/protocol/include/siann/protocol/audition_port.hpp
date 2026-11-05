#pragma once

// The protocol server's way to the auditioner (architecture spec,
// "siann-protocol", AuditionPort). siann-protocol does not link the playback
// engine; the engine host implements this interface over
// playback::Auditioner and hands it to the server in ServerOptions. Every
// call runs on the command thread.

#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>

#include "siann/command/history.hpp"

namespace siann::protocol {

// What an audition_budget_exceeded refusal needed against the budget.
struct AuditionBudgetData {
    std::string resource;  // "memory" (bytes) or "cpu" (graph nodes)
    std::uint64_t needed = 0;
    std::uint64_t budget = 0;
};

// Thrown by a port. Codes: audition_budget_exceeded (with budget()),
// audition_not_found.
class AuditionPortError : public std::runtime_error {
public:
    AuditionPortError(std::string code, const std::string& message, std::optional<AuditionBudgetData> budget = {})
        : std::runtime_error(message), code_(std::move(code)), budget_(std::move(budget)) {}

    const std::string& code() const noexcept { return code_; }
    const std::optional<AuditionBudgetData>& budget() const noexcept { return budget_; }

private:
    std::string code_;
    std::optional<AuditionBudgetData> budget_;
};

class AuditionPort {
public:
    virtual ~AuditionPort() = default;

    // Hears an open proposal branch. Throws AuditionPortError; a refusal
    // changes nothing.
    virtual void audition(const command::BranchId& branchId) = 0;
    // Hears main's head again.
    virtual void hearMain() = 0;
    // The proposal heard, or nothing when main is heard.
    virtual std::optional<command::BranchId> heard() const = 0;
    // Merges or discards a branch so the sound follows. Throw
    // AuditionPortError audition_not_found, or the session's CommandError.
    virtual const command::Revision& merge(const command::BranchId& branchId, std::string actor,
                                           std::string time) = 0;
    virtual void discard(const command::BranchId& branchId) = 0;
    // A revision the server committed on main or on a branch.
    virtual void mainCommitted() {}
    virtual void branchCommitted(const command::BranchId& branchId) { (void)branchId; }
};

}  // namespace siann::protocol
