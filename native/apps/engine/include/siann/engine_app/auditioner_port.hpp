#pragma once

// The engine host's AuditionPort: a real playback::Auditioner behind the
// protocol's interface, its AuditionError translated into AuditionPortError
// with the budget as data. rebind() points it at another auditioner
// (session.open). Header-only: the protocol tests put it over their own engine.

#include <optional>
#include <string>
#include <utility>

#include "siann/playback/audition.hpp"
#include "siann/protocol/audition_port.hpp"

namespace siann::engine_app {

class AuditionerPort final : public protocol::AuditionPort {
public:
    explicit AuditionerPort(playback::Auditioner& auditioner) : auditioner_(&auditioner) {}

    void rebind(playback::Auditioner& auditioner) { auditioner_ = &auditioner; }

    void audition(const command::BranchId& branchId) override {
        translated([&] { auditioner_->audition(branchId); });
    }
    void hearMain() override { auditioner_->hear(playback::Auditioner::Side::main); }
    std::optional<command::BranchId> heard() const override { return auditioner_->heard(); }
    const command::Revision& merge(const command::BranchId& branchId, std::string actor, std::string time) override {
        const command::Revision* merged = nullptr;
        translated([&] { merged = &auditioner_->merge(branchId, std::move(actor), std::move(time)); });
        return *merged;
    }
    void discard(const command::BranchId& branchId) override {
        translated([&] { auditioner_->discard(branchId); });
    }
    void mainCommitted() override { auditioner_->onMainCommitted(); }
    void branchCommitted(const command::BranchId& branchId) override { auditioner_->onBranchCommitted(branchId); }

private:
    template <class Fn>
    static void translated(Fn&& fn) {
        try {
            fn();
        } catch (const playback::AuditionError& error) {
            std::optional<protocol::AuditionBudgetData> budget;
            if (const auto& detail = error.detail()) {
                budget = protocol::AuditionBudgetData{detail->resource, detail->needed, detail->budget};
            }
            throw protocol::AuditionPortError(error.code(), error.what(), std::move(budget));
        }
    }

    playback::Auditioner* auditioner_;
};

}  // namespace siann::engine_app
