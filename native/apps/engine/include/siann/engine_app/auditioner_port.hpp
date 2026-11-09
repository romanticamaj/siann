#pragma once

// The engine host's AuditionPort: a real playback::Auditioner behind the
// protocol's interface, its AuditionError translated into AuditionPortError
// with the budget as data. rebind() points it at another auditioner
// (session.open), or at none while the engine host has no graph: then
// heard() is main, the commit notices do nothing and the rest throws
// AuditionPortError audition_unavailable. Header-only: the protocol tests put it
// over their own engine.

#include <optional>
#include <string>
#include <utility>

#include "siann/playback/audition.hpp"
#include "siann/protocol/audition_port.hpp"

namespace siann::engine_app {

class AuditionerPort final : public protocol::AuditionPort {
public:
    AuditionerPort() = default;
    explicit AuditionerPort(playback::Auditioner& auditioner) : auditioner_(&auditioner) {}

    void rebind(playback::Auditioner& auditioner) { auditioner_ = &auditioner; }
    void unbind() { auditioner_ = nullptr; }

    void audition(const command::BranchId& branchId) override {
        translated([&] { bound().audition(branchId); });
    }
    void hearMain() override { bound().hear(playback::Auditioner::Side::main); }
    std::optional<command::BranchId> heard() const override {
        return auditioner_ != nullptr ? auditioner_->heard() : std::nullopt;
    }
    const command::Revision& merge(const command::BranchId& branchId, std::string actor, std::string time) override {
        const command::Revision* merged = nullptr;
        translated([&] { merged = &bound().merge(branchId, std::move(actor), std::move(time)); });
        return *merged;
    }
    void discard(const command::BranchId& branchId) override {
        translated([&] { bound().discard(branchId); });
    }
    void mainCommitted() override {
        if (auditioner_ != nullptr) {
            auditioner_->onMainCommitted();
        }
    }
    void branchCommitted(const command::BranchId& branchId) override {
        if (auditioner_ != nullptr) {
            auditioner_->onBranchCommitted(branchId);
        }
    }

private:
    playback::Auditioner& bound() const {
        if (auditioner_ == nullptr) {
            throw protocol::AuditionPortError("audition_unavailable",
                                              "the session's graph could not be built, so nothing can be auditioned");
        }
        return *auditioner_;
    }

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

    playback::Auditioner* auditioner_ = nullptr;
};

}  // namespace siann::engine_app
