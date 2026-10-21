#include "siann/session/session.hpp"

#include <utility>

#include "siann/hash/jcs.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/model/field_reader.hpp"

namespace siann::session {

namespace fs = std::filesystem;
using command::Cause;
using command::History;
using command::Revision;
using json::Object;
using json::Value;

namespace {

constexpr std::string_view kCheckpointSchema = "siann.checkpoint.v1";
const char* const kJournalFile = "journal.ndjson";
const char* const kCheckpointFile = "session.json";

void requireSameEnvelope(const command::RevisionEnvelope& expected, const Revision& actual,
                         const std::optional<std::string>& expectedTarget) {
    const auto& got = actual.envelope;
    if (got.id != expected.id || got.parents != expected.parents || got.documentHash != expected.documentHash ||
        got.cause != expected.cause || got.actor != expected.actor || got.time != expected.time ||
        actual.target != expectedTarget) {
        throw SessionError("replay_mismatch", "replaying " + expected.id + " did not reproduce the recorded revision");
    }
}

fs::path quarantinePath(const fs::path& bundle, std::int64_t lastValidSeq) {
    const std::string base = "journal.corrupt-after-" + std::to_string(lastValidSeq);
    fs::path candidate = bundle / (base + ".ndjson");
    for (int n = 2; fs::exists(candidate); ++n) {
        candidate = bundle / (base + "-" + std::to_string(n) + ".ndjson");
    }
    return candidate;
}

}  // namespace

struct Session::State {
    fs::path bundle;
    History history;
    std::int64_t lastSeq = 0;

    State(fs::path path, History h, std::int64_t seq) : bundle(std::move(path)), history(std::move(h)), lastSeq(seq) {}

    void installJournalHook() {
        history.setBeforePublish([this](const Revision& revision) {
            const std::int64_t seq = lastSeq + 1;
            io::appendDurable(bundle / kJournalFile, encodeRecord(recordFromRevision(seq, revision)) + "\n");
            lastSeq = seq;
        });
    }

    void writeCheckpoint() const {
        const Revision& head = history.head();
        const Value checkpoint(Object{
            {"schemaVersion", Value(std::string(kCheckpointSchema))},
            {"coversSeq", Value(std::to_string(lastSeq))},
            {"head", envelopeToJson(head.envelope)},
            {"document", head.document.toJson()},
        });
        io::writeFileAtomic(bundle / kCheckpointFile, jcs::canonicalize(checkpoint) + "\n");
    }

    void afterRevision() const {
        if (lastSeq % kCheckpointInterval == 0) {
            writeCheckpoint();
        }
    }
};

Session::Session(std::unique_ptr<State> state) : state_(std::move(state)) {}
Session::Session(Session&&) noexcept = default;
Session& Session::operator=(Session&&) noexcept = default;
Session::~Session() = default;

Session Session::create(const fs::path& bundle, model::Document initial, std::string actor, std::string time) {
    if (fs::exists(bundle) && !fs::is_empty(bundle)) {
        throw SessionError("bundle_exists", "refusing to create a session in a non-empty directory: " + bundle.string());
    }
    io::createDirectoriesDurable(bundle / "media");
    io::createDirectoriesDurable(bundle / "blobs");

    History history(std::move(initial), std::move(actor), std::move(time));
    io::appendDurable(bundle / kJournalFile, encodeRecord(recordFromRevision(1, history.head())) + "\n");
    auto state = std::make_unique<State>(bundle, std::move(history), 1);
    state->writeCheckpoint();
    state->installJournalHook();
    return Session(std::move(state));
}

Session Session::open(const fs::path& bundle, OpenReport* report) {
    OpenReport local;
    OpenReport& out = report ? *report : local;
    out = OpenReport{};

    const fs::path journalPath = bundle / kJournalFile;
    const fs::path checkpointPath = bundle / kCheckpointFile;
    if (!fs::exists(journalPath) && !fs::exists(checkpointPath)) {
        throw SessionError("not_a_bundle", "no journal or checkpoint in " + bundle.string());
    }

    for (const char* name : {kCheckpointFile, kJournalFile}) {
        fs::path temp = bundle / name;
        temp += std::string(io::kTempSuffix);
        if (fs::exists(temp)) {
            fs::remove(temp);
            out.removedTempFiles.push_back(temp);
        }
    }

    const std::string content = fs::exists(journalPath) ? io::readFile(journalPath) : std::string();
    JournalScan scan = scanJournal(content);
    if (scan.tailError) {
        const fs::path quarantine = quarantinePath(bundle, static_cast<std::int64_t>(scan.records.size()));
        io::writeFileAtomic(quarantine, std::string_view(content).substr(scan.validBytes));
        io::writeFileAtomic(journalPath, std::string_view(content).substr(0, scan.validBytes));
        out.quarantinedTail = quarantine;
        out.tailError = scan.tailError;
    }

    // Checkpoint, if readable. The journal is the source of truth.
    std::optional<Value> checkpoint;
    if (fs::exists(checkpointPath)) {
        try {
            checkpoint = json::parse(io::readFile(checkpointPath));
        } catch (const json::ParseError&) {
            checkpoint.reset();
        }
    }
    std::int64_t coversSeq = 0;
    if (checkpoint) {
        try {
            model::detail::FieldReader r(*checkpoint, "checkpoint");
            if (r.string("schemaVersion") != kCheckpointSchema) {
                throw SessionError("unsupported_version", "checkpoint schema is not supported");
            }
            coversSeq = r.int64String("coversSeq");
        } catch (const model::ModelError& error) {
            throw SessionError("checkpoint_mismatch", error.what());
        }
    }
    const auto recordCount = static_cast<std::int64_t>(scan.records.size());
    if (coversSeq > recordCount) {
        throw SessionError("journal_behind_checkpoint", "the checkpoint covers seq " + std::to_string(coversSeq) +
                                                            " but the journal ends at " + std::to_string(recordCount));
    }
    if (scan.records.empty() || scan.records.front().envelope.cause != Cause::create ||
        !scan.records.front().document) {
        throw SessionError("missing_create_record", "the journal does not start with a create record");
    }

    const JournalRecord& first = scan.records.front();
    History history(*first.document, first.envelope.actor, first.envelope.time);
    requireSameEnvelope(first.envelope, history.head(), first.target);

    for (std::size_t i = 1; i < scan.records.size(); ++i) {
        const JournalRecord& record = scan.records[i];
        try {
            switch (record.envelope.cause) {
                case Cause::command:
                case Cause::plan:
                    history.commit(record.commands, record.envelope.actor, record.envelope.time, record.envelope.cause);
                    break;
                case Cause::undo:
                    history.undo(record.envelope.actor, record.envelope.time);
                    break;
                case Cause::redo:
                    history.redo(record.envelope.actor, record.envelope.time);
                    break;
                case Cause::create:
                    throw SessionError("replay_mismatch", "a create record can only be first");
            }
        } catch (const command::CommandError& error) {
            throw SessionError("replay_mismatch", "replaying " + record.envelope.id + " failed: " + error.what());
        }
        requireSameEnvelope(record.envelope, history.head(), record.target);
    }
    out.recordsReplayed = recordCount;

    if (checkpoint && coversSeq > 0) {
        try {
            const model::Document document = model::Document::fromJson(*checkpoint->find("document"));
            const Revision& covered = history.revisions()[static_cast<std::size_t>(coversSeq - 1)];
            if (document.documentHash() != covered.envelope.documentHash) {
                throw SessionError("checkpoint_mismatch",
                                   "the checkpoint document differs from revision " + covered.envelope.id);
            }
        } catch (const model::ModelError& error) {
            throw SessionError("checkpoint_mismatch", error.what());
        }
        out.checkpointVerified = true;
    }

    auto state = std::make_unique<State>(bundle, std::move(history), recordCount);
    state->installJournalHook();
    return Session(std::move(state));
}

const fs::path& Session::bundlePath() const noexcept {
    return state_->bundle;
}

const History& Session::history() const noexcept {
    return state_->history;
}

std::int64_t Session::lastSeq() const noexcept {
    return state_->lastSeq;
}

const Revision& Session::commit(std::vector<command::Command> commands, std::string actor, std::string time,
                                Cause cause) {
    const Revision& revision = state_->history.commit(std::move(commands), std::move(actor), std::move(time), cause);
    state_->afterRevision();
    return revision;
}

const Revision& Session::undo(std::string actor, std::string time) {
    const Revision& revision = state_->history.undo(std::move(actor), std::move(time));
    state_->afterRevision();
    return revision;
}

const Revision& Session::redo(std::string actor, std::string time) {
    const Revision& revision = state_->history.redo(std::move(actor), std::move(time));
    state_->afterRevision();
    return revision;
}

void Session::checkpoint() {
    state_->writeCheckpoint();
}

}  // namespace siann::session
