#pragma once

// One loaded `.clap` file: the module, its clap_entry, init on open and deinit on
// the way out, so instances keep it alive by holding it.

#include <filesystem>
#include <memory>
#include <string>

struct clap_plugin_factory;

namespace siann::host {

class ClapLibrary {
public:
    // Main thread. The library at this path, already open or opened now: CLAP asks for
    // init and deinit once per load, however many hosts and instances use it. Throws
    // plugin_load_failed when the file is no CLAP this host can use.
    static std::shared_ptr<ClapLibrary> open(const std::filesystem::path& path);

    ~ClapLibrary();
    ClapLibrary(const ClapLibrary&) = delete;
    ClapLibrary& operator=(const ClapLibrary&) = delete;

    // Never null, and with at least one plugin.
    const clap_plugin_factory* factory() const { return factory_; }

private:
    struct Module;

    ClapLibrary(std::unique_ptr<Module> module, const std::filesystem::path& path);

    std::unique_ptr<Module> module_;
    const clap_plugin_factory* factory_ = nullptr;
};

// The file to load for a plugin path: the path itself, or the executable inside a
// macOS bundle (Contents/MacOS/<bundle name>, or the only file there). Throws
// plugin_load_failed for a directory that holds neither.
std::filesystem::path clapExecutablePath(const std::filesystem::path& path);

std::filesystem::path pathFromUtf8(const std::string& text);
std::string pathToUtf8(const std::filesystem::path& path);

}  // namespace siann::host
