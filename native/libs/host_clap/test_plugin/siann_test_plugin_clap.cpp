// The entry point alone: a factory with no plugins in it.

#include <clap/clap.h>

#include <cstdint>
#include <cstring>

namespace {

std::uint32_t factoryCount(const clap_plugin_factory_t*) { return 0; }

const clap_plugin_descriptor_t* factoryDescriptor(const clap_plugin_factory_t*, std::uint32_t) { return nullptr; }

const clap_plugin_t* factoryCreate(const clap_plugin_factory_t*, const clap_host_t*, const char*) { return nullptr; }

const clap_plugin_factory_t factory = {factoryCount, factoryDescriptor, factoryCreate};

bool entryInit(const char*) { return true; }

void entryDeinit() {}

const void* entryGetFactory(const char* id) {
    return std::strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : nullptr;
}

}  // namespace

extern "C" CLAP_EXPORT const clap_plugin_entry_t clap_entry = {CLAP_VERSION_INIT, entryInit, entryDeinit, entryGetFactory};
