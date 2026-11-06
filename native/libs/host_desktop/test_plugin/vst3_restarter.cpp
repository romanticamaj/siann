#include "vst3_restarter.hpp"

#include <pluginterfaces/vst/ivsteditcontroller.h>

namespace siann::test_plugin {

void Vst3Restarter::restart() {
    using Steinberg::Vst::IComponentHandler;
    IComponentHandler* handler = nullptr;
    if (handler_ == nullptr ||
        handler_->queryInterface(Steinberg::Vst::IComponentHandler_iid, reinterpret_cast<void**>(&handler)) !=
            Steinberg::kResultOk) {
        return;
    }
    handler->restartComponent(Steinberg::Vst::kReloadComponent | Steinberg::Vst::kIoChanged);
    handler->release();
}

}  // namespace siann::test_plugin
