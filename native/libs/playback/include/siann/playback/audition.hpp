#pragma once

// Proposal audition (architecture spec, "Proposal audition (A/B)", decisions
// of 2026-11-05). One side is heard: main or one open proposal branch. Hearing
// a side hands its document to the playback engine, so a switch is an
// ordinary structural transition (duck-and-swap) and only the live graph
// exists; the side not heard keeps only its document. Before a proposal is
// heard, the cost of the switch is estimated against the engine's audition
// budget and the switch is refused with a reason when it is over.
//
// The heard side follows its own commits only: call onMainCommitted() after a
// main commit and onBranchCommitted() after a branch commit. Fader gestures
// that end while a proposal is heard commit onto its branch.

#include <optional>
#include <stdexcept>
#include <string>

#include "siann/command/history.hpp"
#include "siann/playback/playback_engine.hpp"
#include "siann/session/session.hpp"

namespace siann::playback {

class AuditionError : public std::runtime_error {
public:
    AuditionError(std::string code, const std::string& message);

    // Stable codes: audition_budget_exceeded (the reason names what the switch
    // needs against the budget), audition_not_found (no open proposal).
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

class Auditioner {
public:
    enum class Side { main };

    // The engine must be loaded and must outlive the auditioner.
    Auditioner(PlaybackEngine& engine, session::Session& session);
    ~Auditioner();
    Auditioner(const Auditioner&) = delete;
    Auditioner& operator=(const Auditioner&) = delete;

    // Hears an open proposal, replacing the side heard. Throws AuditionError;
    // a refusal changes nothing.
    void audition(const command::BranchId& branchId);
    // Hears main's head again. Never refused.
    void hear(Side side);
    // The proposal heard, or nothing when main is heard.
    const std::optional<command::BranchId>& heard() const noexcept { return heard_; }

    // A commit landed on main or on a branch: the engine follows it only when
    // that side is heard.
    void onMainCommitted();
    void onBranchCommitted(const command::BranchId& branchId);

    // Merges a proposal into main (session.merge); if it was heard, main is
    // heard at once and gestures commit onto main again. Throws AuditionError
    // audition_not_found, or the merge's CommandError (branch_conflict, ...),
    // which changes nothing: the proposal stays heard.
    const command::Revision& merge(const command::BranchId& branchId, std::string actor, std::string time);
    // Discards a proposal (session.discard); if it was heard, main is heard.
    // Throws AuditionError audition_not_found.
    //
    // Close branches through these two: a heard branch closed on the session
    // directly leaves heard() naming it until hear(main), and a gesture that
    // ends meanwhile is audition_not_found.
    void discard(const command::BranchId& branchId);

private:
    const model::Document& proposalDocument(const command::BranchId& branchId) const;

    PlaybackEngine& engine_;
    session::Session& session_;
    std::optional<command::BranchId> heard_;
};

}  // namespace siann::playback
