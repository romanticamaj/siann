#include "clap_library.hpp"

#include <clap/clap.h>

#include <map>
#include <system_error>

#include "siann/host/plugin_error.hpp"

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace fs = std::filesystem;

namespace siann::host {

namespace {

[[noreturn]] void failLoad(const fs::path& path, const std::string& why) {
    throw PluginError("plugin_load_failed", pathToUtf8(path) + ": " + why);
}

}  // namespace

#if defined(_WIN32)

struct ClapLibrary::Module {
    HMODULE handle = nullptr;

    explicit Module(const fs::path& file) {
        // Windows answers a bad image with a modal box nobody can click in a headless
        // engine; this thread's mode turns it into a plain failure. The plugin's own
        // dependencies load from beside it. Backslashes: LoadLibrary needs them.
        DWORD previous = 0;
        SetThreadErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX, &previous);
        handle = LoadLibraryExW(fs::absolute(file).make_preferred().c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
        const DWORD error = handle == nullptr ? GetLastError() : 0;
        SetThreadErrorMode(previous, nullptr);
        if (handle == nullptr) {
            failLoad(file, "the module does not load (error " + std::to_string(error) + ")");
        }
    }
    ~Module() { FreeLibrary(handle); }

    const clap_plugin_entry_t* entry() const {
        return reinterpret_cast<const clap_plugin_entry_t*>(GetProcAddress(handle, "clap_entry"));
    }
};

#else

struct ClapLibrary::Module {
    void* handle = nullptr;

    explicit Module(const fs::path& file) {
        handle = dlopen(file.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (handle == nullptr) {
            failLoad(file, dlerror());
        }
    }
    ~Module() { dlclose(handle); }

    const clap_plugin_entry_t* entry() const { return static_cast<const clap_plugin_entry_t*>(dlsym(handle, "clap_entry")); }
};

#endif

ClapLibrary::ClapLibrary(std::unique_ptr<Module> module, const fs::path& path) : module_(std::move(module)) {
    const clap_plugin_entry_t* entry = module_->entry();
    if (entry == nullptr) {
        failLoad(path, "no clap_entry");
    }
    if (!clap_version_is_compatible(entry->clap_version)) {
        failLoad(path, "an incompatible CLAP version");
    }
    if (!entry->init(pathToUtf8(path).c_str())) {
        failLoad(path, "its init failed");
    }
    const auto* found = static_cast<const clap_plugin_factory_t*>(entry->get_factory(CLAP_PLUGIN_FACTORY_ID));
    if (found == nullptr || found->get_plugin_count(found) == 0) {
        entry->deinit();
        failLoad(path, "no plugin in it");
    }
    factory_ = found;
}

ClapLibrary::~ClapLibrary() { module_->entry()->deinit(); }

std::shared_ptr<ClapLibrary> ClapLibrary::open(const fs::path& path) {
    // Main thread only, so no lock.
    static std::map<fs::path, std::weak_ptr<ClapLibrary>> loaded;
    std::error_code ignored;
    auto key = fs::weakly_canonical(path, ignored);
    if (key.empty()) {
        key = path;
    }
    if (auto existing = loaded[key].lock()) {
        return existing;
    }
    auto module = std::make_unique<Module>(clapExecutablePath(path));
    std::shared_ptr<ClapLibrary> library(new ClapLibrary(std::move(module), path));
    loaded[key] = library;
    return library;
}

fs::path clapExecutablePath(const fs::path& path) {
    std::error_code ignored;
    if (!fs::is_directory(path, ignored)) {
        return path;
    }
    const fs::path directory = path / "Contents" / "MacOS";
    const fs::path named = directory / path.stem();
    if (fs::is_regular_file(named, ignored)) {
        return named;
    }
    fs::path only;
    int files = 0;
    for (const auto& entry : fs::directory_iterator(directory, ignored)) {
        if (entry.is_regular_file(ignored)) {
            only = entry.path();
            ++files;
        }
    }
    if (files != 1) {
        failLoad(path, "a directory that is not a CLAP bundle");
    }
    return only;
}

fs::path pathFromUtf8(const std::string& text) {
    return fs::path(std::u8string(reinterpret_cast<const char8_t*>(text.data()), text.size()));
}

std::string pathToUtf8(const fs::path& path) {
    const std::u8string text = path.u8string();
    return std::string(reinterpret_cast<const char*>(text.data()), text.size());
}

}  // namespace siann::host
