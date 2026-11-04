#include "siann/playback/audition.hpp"

#include <algorithm>
#include <utility>
#include <vector>

namespace siann::playback {

AuditionError::AuditionError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

Auditioner::Auditioner(PlaybackEngine& engine, session::Session& session) : engine_(engine), session_(session) {}

Auditioner::~Auditioner() {
    engine_.setGestureBranch(std::nullopt);
}

const model::Document& Auditioner::proposalDocument(const command::BranchId& branchId) const {
    const std::vector<command::BranchId> open = session_.history().branches();
    if (std::find(open.begin(), open.end(), branchId) == open.end()) {
        throw AuditionError("audition_not_found", "no open proposal branch " + branchId);
    }
    return session_.history().branchHead(branchId).document;
}

void Auditioner::audition(const command::BranchId& branchId) {
    const model::Document& document = proposalDocument(branchId);
    const AuditionCost cost = engine_.estimateCost(document);
    const AuditionBudget& budget = engine_.options().auditionBudget;
    if (cost.bytes > budget.maxBytes) {
        throw AuditionError("audition_budget_exceeded",
                            "auditioning " + branchId + " needs " + std::to_string(cost.bytes) + " bytes for " +
                                std::to_string(cost.newStreams) + " new streams, over the memory budget of " +
                                std::to_string(budget.maxBytes) + " bytes");
    }
    if (cost.nodes > budget.maxNodes) {
        throw AuditionError("audition_budget_exceeded", "auditioning " + branchId + " needs " +
                                                            std::to_string(cost.nodes) +
                                                            " nodes, over the CPU budget of " +
                                                            std::to_string(budget.maxNodes) + " nodes");
    }
    engine_.update(document);
    heard_ = branchId;
    engine_.setGestureBranch(branchId);
}

void Auditioner::hear(Side) {
    engine_.update(session_.history().head().document);
    heard_.reset();
    engine_.setGestureBranch(std::nullopt);
}

void Auditioner::onMainCommitted() {
    if (!heard_) {
        engine_.update(session_.history().head().document);
    }
}

void Auditioner::onBranchCommitted(const command::BranchId& branchId) {
    if (heard_ == branchId) {
        engine_.update(proposalDocument(branchId));
    }
}

void Auditioner::discard(const command::BranchId& branchId) {
    (void)proposalDocument(branchId);  // audition_not_found
    session_.discard(branchId);
    if (heard_ == branchId) {
        hear(Side::main);
    }
}

}  // namespace siann::playback
