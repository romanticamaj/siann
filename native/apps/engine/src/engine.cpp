#include "siann/engine_app/engine.hpp"

#include <chrono>
#include <cstdint>
#include <ctime>
#include <exception>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include "siann/hash/jcs.hpp"
#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"
#include "siann/protocol/about.hpp"
#include "siann/protocol/ix_transport.hpp"
#include "siann/protocol/protocol_server.hpp"
#include "siann/session/journal.hpp"
#include "siann/session/session.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace siann::engine_app {

namespace fs = std::filesystem;
using json::Object;
using json::Value;

namespace {

// A launch the engine refuses: exit 1 with {ok:false, error:{code, message}}.
class LaunchError : public std::runtime_error {
public:
    LaunchError(std::string code, const std::string& message) : std::runtime_error(message), code_(std::move(code)) {}
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

struct Options {
    fs::path session;
    std::string host = "127.0.0.1";
    std::uint16_t port = 0;
    bool mcpTrusted = false;
};

fs::path pathFromUtf8(const std::string& text) {
    return fs::path(std::u8string(text.begin(), text.end()));
}

Options parseOptions(const std::vector<std::string>& args) {
    Options options;
    bool haveSession = false;
    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& arg = args[i];
        const auto value = [&]() -> const std::string& {
            if (i + 1 >= args.size()) {
                throw LaunchError("usage", arg + " needs a value");
            }
            return args[++i];
        };
        if (arg == "--session") {
            options.session = pathFromUtf8(value());
            haveSession = true;
        } else if (arg == "--host") {
            options.host = value();
        } else if (arg == "--port") {
            const std::string& text = value();
            std::size_t used = 0;
            unsigned long parsed = 0;
            try {
                parsed = std::stoul(text, &used);
            } catch (const std::exception&) {
                used = 0;
            }
            if (used == 0 || used != text.size() || parsed > 65'535) {
                throw LaunchError("usage", "--port must be an integer from 0 to 65535");
            }
            options.port = static_cast<std::uint16_t>(parsed);
        } else if (arg == "--mcp-trusted") {
            options.mcpTrusted = true;
        } else {
            throw LaunchError("usage", "unknown option " + arg +
                                           "; usage: siann-engine --session <bundle> [--host 127.0.0.1] [--port 0] "
                                           "[--mcp-trusted]");
        }
    }
    if (!haveSession || options.session.empty()) {
        throw LaunchError("usage", "--session <bundle> is required");
    }
    return options;
}

std::string nowUtc() {
    const std::time_t t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm tm{};
#if defined(_WIN32)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buffer[32];
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buffer;
}

// Opens the bundle, or creates an empty session named after it when the
// directory does not exist (spec, "Process model": session at launch).
session::Session openOrCreate(const fs::path& bundle) {
    std::error_code ec;
    const fs::file_status status = fs::status(bundle, ec);
    if (fs::exists(status)) {
        if (!fs::is_directory(status)) {
            throw LaunchError("invalid_session", "--session names a file, not a session bundle directory");
        }
        return session::Session::open(bundle);
    }
    if (bundle.has_parent_path()) {
        fs::create_directories(bundle.parent_path());
    }
    const std::u8string stem = bundle.stem().u8string();
    return session::Session::create(bundle, model::Document::create(std::string(stem.begin(), stem.end()), 48'000, 120'000),
                                    "siann-engine", nowUtc());
}

long processId() {
#if defined(_WIN32)
    return static_cast<long>(GetCurrentProcessId());
#else
    return static_cast<long>(getpid());
#endif
}

// Canonical JSON throws on bytes that are not UTF-8 (an exception message with
// a Windows path in the ANSI code page); each such byte becomes U+FFFD.
std::string validUtf8(const std::string& text) {
    std::string out;
    std::size_t pos = 0;
    while (pos < text.size()) {
        const auto byte = [&](std::size_t i) { return static_cast<unsigned char>(text[pos + i]); };
        const unsigned char first = byte(0);
        std::size_t length = 0;
        unsigned char low = 0x80;
        unsigned char high = 0xBF;
        if (first < 0x80) {
            length = 1;
        } else if (first >= 0xC2 && first <= 0xDF) {
            length = 2;
        } else if (first >= 0xE0 && first <= 0xEF) {
            length = 3;
            low = first == 0xE0 ? 0xA0 : 0x80;
            high = first == 0xED ? 0x9F : 0xBF;
        } else if (first >= 0xF0 && first <= 0xF4) {
            length = 4;
            low = first == 0xF0 ? 0x90 : 0x80;
            high = first == 0xF4 ? 0x8F : 0xBF;
        }
        bool valid = length > 0 && pos + length <= text.size();
        if (valid && length > 1) {
            valid = byte(1) >= low && byte(1) <= high;
            for (std::size_t i = 2; valid && i < length; ++i) {
                valid = byte(i) >= 0x80 && byte(i) <= 0xBF;
            }
        }
        if (valid) {
            out.append(text, pos, length);
            pos += length;
        } else {
            out += "\xEF\xBF\xBD";
            ++pos;
        }
    }
    return out;
}

void writeError(std::ostream& err, const std::string& code, const std::string& message) {
    err << jcs::canonicalize(Value(Object{{"ok", Value(false)},
                                          {"error", Value(Object{{"code", Value(validUtf8(code))},
                                                                 {"message", Value(validUtf8(message))}})}}))
        << "\n";
    err.flush();
}

}  // namespace

int runEngine(const std::vector<std::string>& args, std::ostream& out, std::ostream& err,
              const std::atomic<bool>* stop) {
    try {
        const Options options = parseOptions(args);
        session::Session served = openOrCreate(options.session);

        protocol::ServerOptions serverOptions;
        serverOptions.host = options.host;
        serverOptions.port = options.port;
        serverOptions.pumpThread = true;
        serverOptions.actor = "siann-engine";
        serverOptions.mcpScope = options.mcpTrusted ? protocol::McpScope::trusted : protocol::McpScope::propose;
        protocol::IxTransport transport;
        protocol::ProtocolServer server(transport, served, serverOptions);
        server.start();

        // The launcher handshake: exactly one line, and nothing else on out.
        out << jcs::canonicalize(Value(Object{{"schema", Value(std::string(kReadySchema))},
                                              {"port", Value(static_cast<double>(server.port()))},
                                              {"token", Value(server.token())},
                                              {"mcpToken", Value(server.mcpToken())},
                                              {"sessionId", Value(server.sessionId())},
                                              {"pid", Value(static_cast<double>(processId()))},
                                              {"about", protocol::aboutJson()}}))
            << "\n";
        out.flush();

        // The stop flag is set from a signal handler or the stdin watcher, so
        // it is polled; the pump thread serves meanwhile.
        while (stop == nullptr || !stop->load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        server.stop();
        return 0;
    } catch (const LaunchError& error) {
        writeError(err, error.code(), error.what());
    } catch (const session::SessionError& error) {
        writeError(err, error.code(), error.what());
    } catch (const std::exception& error) {
        writeError(err, "internal_error", error.what());
    } catch (...) {
        writeError(err, "internal_error", "unknown exception");
    }
    return 1;
}

}  // namespace siann::engine_app
