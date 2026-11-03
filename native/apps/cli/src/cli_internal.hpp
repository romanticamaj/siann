#pragma once

// Shared between the siann-cli command sources. Not installed.

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/hash/json.hpp"

namespace siann::cli {
class CallbackTimer;
}

namespace siann::cli::detail {

class UsageError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

class CliError : public std::runtime_error {
public:
    CliError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

struct Args {
    std::vector<std::string> positional;
    std::map<std::string, std::string> options;

    const std::string& at(std::size_t i, const char* what) const {
        if (i >= positional.size()) {
            throw UsageError(std::string("missing ") + what);
        }
        return positional[i];
    }
    std::optional<std::string> option(const std::string& name) const {
        const auto it = options.find(name);
        return it == options.end() ? std::nullopt : std::optional<std::string>(it->second);
    }
    std::string required(const std::string& name) const {
        const auto value = option(name);
        if (!value) {
            throw UsageError("missing --" + name);
        }
        return *value;
    }
};

std::filesystem::path pathFromUtf8(const std::string& text);
std::string pathToUtf8(const std::filesystem::path& path);

// The option as an integer, or fallback when it is absent. UsageError when it
// is not an integer.
std::int64_t integerOption(const Args& args, const std::string& name, std::int64_t fallback);
// As integerOption, and UsageError unless it is at least 1.
std::int64_t positiveOption(const Args& args, const std::string& name, std::int64_t fallback);
// A required positive integer option.
std::int64_t requiredPositive(const Args& args, const std::string& name);

json::Value revisionJson(const command::Revision& revision);
json::Value ok(json::Object fields);
std::string actorOf(const Args& args);
std::string timeOf(const Args& args);

// Realtime commands (realtime_commands.cpp). `interrupt`, when set, ends an
// open-ended run (record without --seconds) at the next control tick.
json::Value cmdDevices();
json::Value cmdPlay(const Args& args, const std::atomic<bool>* interrupt);
json::Value cmdRecord(const Args& args, const std::atomic<bool>* interrupt);
json::Value cmdBench(const Args& args, const std::atomic<bool>* interrupt);
json::Value cmdRecover(const Args& args);

// The timing fields of a bench result: `callbacks`, `xruns` (the timer's
// deadline misses) and `maxCallbackMicros`. CliError `bench_no_callbacks` when
// nothing ran and `bench_rate_unknown` when a callback had no device rate, so
// an unmeasured run never reports zero xruns.
json::Object benchTiming(const CallbackTimer& timer);

}  // namespace siann::cli::detail
