#include "siann/playback/audition.hpp"

#include <utility>

namespace siann::playback {

AuditionError::AuditionError(std::string code, const std::string& message, std::optional<AuditionBudgetDetail> detail)
    : std::runtime_error(message), code_(std::move(code)), detail_(std::move(detail)) {}

Auditioner::Auditioner(PlaybackEngine& engine, session::Session& session) : engine_(engine), session_(session) {}

Auditioner::~Auditioner() {
    engine_.setGestureBranch(std::nullopt);
}

const model::Document& Auditioner::proposalDocument(const command::BranchId& branchId) const {
    if (!session_.history().isOpen(branchId)) {
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
                                std::to_string(budget.maxBytes) + " bytes",
                            AuditionBudgetDetail{"memory", cost.bytes, budget.maxBytes});
    }
    if (cost.nodes > budget.maxNodes) {
        throw AuditionError("audition_budget_exceeded", "auditioning " + branchId + " needs " +
                                                            std::to_string(cost.nodes) +
                                                            " nodes, over the CPU budget of " +
                                                            std::to_string(budget.maxNodes) + " nodes",
                            AuditionBudgetDetail{"cpu", cost.nodes, budget.maxNodes});
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

const command::Revision& Auditioner::merge(const command::BranchId& branchId, std::string actor, std::string time) {
    (void)proposalDocument(branchId);  // audition_not_found
    const command::Revision& merged = session_.merge(branchId, std::move(actor), std::move(time));
    if (heard_ == branchId) {
        hear(Side::main);
    } else {
        onMainCommitted();  // main moved: follow it when main is heard
    }
    return merged;
}

void Auditioner::discard(const command::BranchId& branchId) {
    (void)proposalDocument(branchId);  // audition_not_found
    session_.discard(branchId);
    if (heard_ == branchId) {
        hear(Side::main);
    }
}

}  // namespace siann::playback
