#include "siann/cli/cli.hpp"

#include <chrono>
#include <ctime>
#include <filesystem>
#include <map>
#include <optional>
#include <stdexcept>

#include "siann/command/command.hpp"
#include "siann/engine/offline.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/media/audio.hpp"
#include "siann/session/media_import.hpp"
#include "siann/session/session.hpp"

namespace siann::cli {

namespace fs = std::filesystem;
using json::Array;
using json::Object;
using json::Value;

namespace {

constexpr const char* kUsage =
    "usage: siann-cli <command> [arguments] [--actor NAME] [--time ISO8601]\n"
    "  create <bundle> --name NAME [--rate HZ] [--milli-bpm N]\n"
    "  import <bundle> <file.wav> --media-id ID\n"
    "  exec <bundle> <command-json | @file>      one command\n"
    "  plan <bundle> <commands-json | @file>     a JSON array, applied as one revision\n"
    "  undo <bundle>\n"
    "  redo <bundle>\n"
    "  render <bundle> <out.wav> [--start N] [--frames N]\n"
    "  info <bundle>\n"
    "  verify <bundle>\n"
    "  commands\n";

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

fs::path pathFromUtf8(const std::string& text) {
    return fs::path(std::u8string(text.begin(), text.end()));
}

std::string pathToUtf8(const fs::path& path) {
    const std::u8string u8 = path.u8string();
    return std::string(u8.begin(), u8.end());
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

Args parseArgs(const std::vector<std::string>& args) {
    Args parsed;
    for (std::size_t i = 0; i < args.size(); ++i) {
        const std::string& arg = args[i];
        if (arg.rfind("--", 0) == 0) {
            if (i + 1 >= args.size()) {
                throw UsageError("option " + arg + " needs a value");
            }
            parsed.options[arg.substr(2)] = args[++i];
        } else {
            parsed.positional.push_back(arg);
        }
    }
    return parsed;
}

std::int64_t integerOption(const Args& args, const std::string& name, std::int64_t fallback) {
    const auto value = args.option(name);
    if (!value) {
        return fallback;
    }
    try {
        std::size_t used = 0;
        const long long parsed = std::stoll(*value, &used);
        if (used != value->size()) {
            throw std::invalid_argument("trailing characters");
        }
        return parsed;
    } catch (const std::exception&) {
        throw UsageError("--" + name + " must be an integer");
    }
}

Value readJsonArgument(const std::string& argument) {
    std::string text = argument;
    if (!argument.empty() && argument[0] == '@') {
        text = io::readFile(pathFromUtf8(argument.substr(1)));
    }
    try {
        return json::parse(text);
    } catch (const json::ParseError& error) {
        throw CliError("invalid_json", error.what());
    }
}

Value str(const std::string& s) {
    return Value(s);
}

Value revisionJson(const command::Revision& revision) {
    Array diff;
    for (const auto& entry : revision.diff) {
        diff.push_back(Value(std::string(model::entityTypeName(entry.entity.type)) + ":" + entry.entity.id));
    }
    Object out = session::envelopeToJson(revision.envelope).asObject();
    out.emplace_back("diff", Value(std::move(diff)));
    if (revision.target) {
        out.emplace_back("target", Value(*revision.target));
    }
    return Value(std::move(out));
}

Value ok(Object fields) {
    fields.insert(fields.begin(), json::Member("ok", Value(true)));
    return Value(std::move(fields));
}

std::string actorOf(const Args& args) {
    return args.option("actor").value_or("cli");
}

std::string timeOf(const Args& args) {
    return args.option("time").value_or(nowUtc());
}

Value cmdCreate(const Args& args) {
    const fs::path bundle = pathFromUtf8(args.at(1, "bundle"));
    const auto rate = integerOption(args, "rate", 48'000);
    const auto milliBpm = integerOption(args, "milli-bpm", 120'000);
    const session::Session s = session::Session::create(
        bundle, model::Document::create(args.required("name"), rate, static_cast<std::int32_t>(milliBpm)),
        actorOf(args), timeOf(args));
    return ok({{"bundle", str(pathToUtf8(bundle))}, {"revision", revisionJson(s.history().head())}});
}

Value cmdImport(const Args& args) {
    session::Session s = session::Session::open(pathFromUtf8(args.at(1, "bundle")));
    const auto result = session::importMedia(s, pathFromUtf8(args.at(2, "file")), args.required("media-id"),
                                             actorOf(args), timeOf(args));
    return ok({{"revision", revisionJson(*result.revision)},
               {"storedFile", str(pathToUtf8(result.storedFile))},
               {"converted", Value(result.converted)}});
}

Value cmdExec(const Args& args, bool plan) {
    session::Session s = session::Session::open(pathFromUtf8(args.at(1, "bundle")));
    const Value input = readJsonArgument(args.at(2, plan ? "commands" : "command"));
    std::vector<command::Command> commands;
    if (plan) {
        if (input.kind() != Value::Kind::array) {
            throw CliError("invalid_json", "a plan must be a JSON array of commands");
        }
        for (const Value& item : input.asArray()) {
            commands.push_back(command::Command::fromJson(item));
        }
    } else {
        commands.push_back(command::Command::fromJson(input));
    }
    const auto& revision =
        s.commit(std::move(commands), actorOf(args), timeOf(args), plan ? command::Cause::plan : command::Cause::command);
    return ok({{"revision", revisionJson(revision)}});
}

Value cmdUndoRedo(const Args& args, bool redo) {
    session::Session s = session::Session::open(pathFromUtf8(args.at(1, "bundle")));
    const auto& revision = redo ? s.redo(actorOf(args), timeOf(args)) : s.undo(actorOf(args), timeOf(args));
    return ok({{"revision", revisionJson(revision)}});
}

Value cmdRender(const Args& args) {
    const fs::path bundle = pathFromUtf8(args.at(1, "bundle"));
    const fs::path outFile = pathFromUtf8(args.at(2, "output file"));
    const session::Session s = session::Session::open(bundle);
    const auto& document = s.history().head().document;
    engine::RenderOptions options;
    options.start = integerOption(args, "start", 0);
    options.frames = integerOption(args, "frames", -1);
    const media::AudioBuffer rendered = engine::renderOffline(document, engine::loadMedia(document, bundle), options);
    const std::string wav = media::encodeWavFloat32(rendered);
    io::writeFileAtomic(outFile, wav);
    return ok({{"output", str(pathToUtf8(outFile))},
               {"frames", Value(std::to_string(rendered.info.frames))},
               {"sampleRate", Value(static_cast<double>(rendered.info.sampleRate))},
               {"channels", Value(static_cast<double>(rendered.info.channels))},
               {"revision", str(s.history().head().envelope.id)},
               {"documentHash", str(hash::formatHash(s.history().head().envelope.documentHash))},
               {"outputHash", str(hash::formatHash(hash::sha256(wav)))}});
}

Value cmdInfo(const Args& args) {
    const session::Session s = session::Session::open(pathFromUtf8(args.at(1, "bundle")));
    const auto& head = s.history().head();
    Array tracks;
    for (const model::Track* t : head.document.tracksInOrder()) {
        tracks.push_back(Value(Object{{"id", str(t->id)},
                                      {"name", str(t->name)},
                                      {"clips", Value(static_cast<double>(head.document.clipsOnTrack(t->id).size()))}}));
    }
    return ok({{"head", revisionJson(head)},
               {"seq", Value(std::to_string(s.lastSeq()))},
               {"canUndo", Value(s.history().canUndo())},
               {"canRedo", Value(s.history().canRedo())},
               {"tracks", Value(std::move(tracks))},
               {"media", Value(static_cast<double>(head.document.allMedia().size()))},
               {"endFrames", Value(std::to_string(engine::documentEnd(head.document)))}});
}

Value cmdVerify(const Args& args) {
    session::OpenReport report;
    const session::Session s = session::Session::open(pathFromUtf8(args.at(1, "bundle")), &report);
    Object out{{"recordsReplayed", Value(std::to_string(report.recordsReplayed))},
               {"checkpointVerified", Value(report.checkpointVerified)},
               {"documentHash", str(hash::formatHash(s.history().head().envelope.documentHash))},
               {"removedTempFiles", Value(static_cast<double>(report.removedTempFiles.size()))}};
    if (report.quarantinedTail) {
        out.emplace_back("quarantinedTail", str(pathToUtf8(*report.quarantinedTail)));
        out.emplace_back("tailError", str(report.tailError.value_or("")));
    }
    return ok(std::move(out));
}

Value cmdCommands() {
    Array names;
    for (const auto& name : command::commandNames()) {
        names.push_back(Value(name));
    }
    return ok({{"commands", Value(std::move(names))}});
}

Value failure(const std::string& code, const std::string& message) {
    return Value(Object{{"ok", Value(false)}, {"error", Value(Object{{"code", str(code)}, {"message", str(message)}})}});
}

}  // namespace

int runCli(const std::vector<std::string>& rawArgs, std::ostream& out) {
    int exitCode = 0;
    Value result;
    try {
        const Args args = parseArgs(rawArgs);
        if (args.positional.empty()) {
            throw UsageError("missing command");
        }
        const std::string& name = args.positional[0];
        if (name == "create") result = cmdCreate(args);
        else if (name == "import") result = cmdImport(args);
        else if (name == "exec") result = cmdExec(args, false);
        else if (name == "plan") result = cmdExec(args, true);
        else if (name == "undo") result = cmdUndoRedo(args, false);
        else if (name == "redo") result = cmdUndoRedo(args, true);
        else if (name == "render") result = cmdRender(args);
        else if (name == "info") result = cmdInfo(args);
        else if (name == "verify") result = cmdVerify(args);
        else if (name == "commands") result = cmdCommands();
        else throw UsageError("unknown command " + name);
    } catch (const UsageError& error) {
        result = failure("usage", std::string(error.what()) + "\n" + kUsage);
        exitCode = 2;
    } catch (const CliError& error) {
        result = failure(error.code(), error.what());
        exitCode = 1;
    } catch (const command::CommandError& error) {
        result = failure(error.code(), error.what());
        exitCode = 1;
    } catch (const session::SessionError& error) {
        result = failure(error.code(), error.what());
        exitCode = 1;
    } catch (const model::ModelError& error) {
        result = failure(error.code(), error.what());
        exitCode = 1;
    } catch (const media::MediaError& error) {
        result = failure(error.code(), error.what());
        exitCode = 1;
    } catch (const engine::EngineError& error) {
        result = failure(error.code(), error.what());
        exitCode = 1;
    } catch (const io::IoError& error) {
        result = failure("io_error", error.what());
        exitCode = 1;
    } catch (const std::exception& error) {
        result = failure("internal_error", error.what());
        exitCode = 1;
    }
    out << jcs::canonicalize(result) << "\n";
    return exitCode;
}

}  // namespace siann::cli
