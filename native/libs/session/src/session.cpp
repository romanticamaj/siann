#include "siann/session/session.hpp"

#include <algorithm>
#include <utility>

#include "siann/hash/jcs.hpp"
#include "siann/io/durable_file.hpp"
#include "siann/model/field_reader.hpp"
#include "session_lock.hpp"

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
    // First, so it is released last.
    detail::BundleLock lock;
    fs::path bundle;
    History history;
    std::int64_t lastSeq = 0;
    command::PlanStore plans;  // in memory only (M3)
    bool cycle = false;        // written with every checkpoint

    State(detail::BundleLock held, fs::path path, History h, std::int64_t seq)
        : lock(std::move(held)), bundle(std::move(path)), history(std::move(h)), lastSeq(seq) {}

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
            {"transport", Value(Object{{"cycle", Value(cycle)}})},
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
    detail::BundleLock held(bundle);

    History history(std::move(initial), std::move(actor), std::move(time));
    io::appendDurable(bundle / kJournalFile, encodeRecord(recordFromRevision(1, history.head())) + "\n");
    auto state = std::make_unique<State>(std::move(held), bundle, std::move(history), 1);
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
    // Before anything below changes the bundle.
    detail::BundleLock held(bundle);

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
    bool checkpointCycle = false;
    if (checkpoint) {
        try {
            model::detail::FieldReader r(*checkpoint, "checkpoint");
            if (r.string("schemaVersion") != kCheckpointSchema) {
                throw SessionError("unsupported_version", "checkpoint schema is not supported");
            }
            coversSeq = r.int64String("coversSeq");
            if (const Value* transport = r.optional("transport")) {
                model::detail::FieldReader t(*transport, "checkpoint.transport");
                checkpointCycle = t.boolean("cycle");
            }
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
                    // A branch commit names its branch: its parent alone may
                    // equal main's head (a branch that starts there).
                    if (record.branch) {
                        if (record.envelope.parents.size() != 1) {
                            throw SessionError("replay_mismatch",
                                               "branch commit " + record.envelope.id + " must have one parent");
                        }
                        history.commitOnParent(*record.branch, record.envelope.parents.front(), record.commands,
                                               record.envelope.actor, record.envelope.time, record.envelope.cause);
                    } else {
                        history.commit(record.commands, record.envelope.actor, record.envelope.time,
                                       record.envelope.cause);
                    }
                    break;
                case Cause::branchMerge:
                    history.mergeReplay(record.envelope.parents, record.commands, record.envelope.actor,
                                        record.envelope.time, record.branch);
                    break;
                case Cause::undo:
                    history.undo(record.envelope.actor, record.envelope.time);
                    break;
                case Cause::redo:
                    history.redo(record.envelope.actor, record.envelope.time);
                    break;
                case Cause::rollback:
                    // decodeRecord guarantees the target.
                    history.rollback(*record.target, record.envelope.actor, record.envelope.time);
                    break;
                case Cause::create:
                    throw SessionError("replay_mismatch", "a create record can only be first");
            }
        } catch (const command::CommandError& error) {
            throw SessionError("replay_mismatch", "replaying " + record.envelope.id + " failed: " + error.what());
        }
        // The revision just replayed, on main or on a branch.
        requireSameEnvelope(record.envelope, history.revisions().back(), record.target);
    }
    out.recordsReplayed = recordCount;

    if (checkpoint && coversSeq > 0) {
        try {
            const Value* document = checkpoint->find("document");
            const Value* head = checkpoint->find("head");
            if (document == nullptr || head == nullptr) {
                throw SessionError("checkpoint_mismatch", "the checkpoint has no head or no document");
            }
            // The revision the checkpoint's head names: with branches, the
            // record at coversSeq need not be main's head. Revision rN is
            // journal record N.
            const command::RevisionEnvelope named = envelopeFromJson(*head);
            const Revision* covered = history.find(named.id);
            if (covered == nullptr ||
                static_cast<std::int64_t>(covered - history.revisions().data()) + 1 > coversSeq) {
                throw SessionError("checkpoint_mismatch", "the checkpoint names revision " + named.id +
                                                              ", which the journal up to its coversSeq lacks");
            }
            if (named.documentHash != covered->envelope.documentHash ||
                model::Document::fromJson(*document).documentHash() != covered->envelope.documentHash) {
                throw SessionError("checkpoint_mismatch",
                                   "the checkpoint document differs from revision " + covered->envelope.id);
            }
        } catch (const model::ModelError& error) {
            throw SessionError("checkpoint_mismatch", error.what());
        }
        out.checkpointVerified = true;
    }

    const fs::path recording = bundle / "media" / "recording";
    if (fs::exists(recording)) {
        for (const auto& entry : fs::directory_iterator(recording)) {
            if (entry.path().extension() == ".json") {
                out.pendingTakes.push_back(entry.path().stem().string());
            }
        }
        std::sort(out.pendingTakes.begin(), out.pendingTakes.end());
    }

    auto state = std::make_unique<State>(std::move(held), bundle, std::move(history), recordCount);
    state->cycle = checkpointCycle;
    state->installJournalHook();
    return Session(std::move(state));
}

bool Session::cycle() const noexcept {
    return state_->cycle;
}

void Session::setCycle(bool enabled) noexcept {
    state_->cycle = enabled;
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

const Revision& Session::rollback(std::string_view planRevisionId, std::string actor, std::string time) {
    const Revision& revision = state_->history.rollback(planRevisionId, std::move(actor), std::move(time));
    state_->afterRevision();
    return revision;
}

const Revision& Session::rollbackPlan(std::string_view planHashText, std::string actor, std::string time) {
    return state_->plans.rollback(planHashText, std::move(actor), std::move(time),
                                  [this](const std::string& planRevisionId, std::string a, std::string t)
                                      -> const Revision& { return rollback(planRevisionId, std::move(a), std::move(t)); });
}

void Session::checkpoint() {
    state_->writeCheckpoint();
}

command::BranchId Session::branch(std::string_view baseId) {
    return state_->history.branch(baseId);
}

const Revision& Session::commitOn(const command::BranchId& branchId, std::vector<command::Command> commands,
                                  std::string actor, std::string time, Cause cause) {
    const Revision& revision =
        state_->history.commitOn(branchId, std::move(commands), std::move(actor), std::move(time), cause);
    state_->afterRevision();
    return revision;
}

const Revision& Session::merge(const command::BranchId& branchId, std::string actor, std::string time) {
    // A proposed plan's read and write sets guard the merge as they would guard its apply.
    const Revision& revision = state_->history.merge(branchId, std::move(actor), std::move(time),
                                                     state_->plans.guardedEntities(branchId));
    state_->afterRevision();
    state_->plans.landProposal(branchId, revision.envelope.id);
    return revision;
}

void Session::discard(const command::BranchId& branchId) {
    state_->history.discard(branchId);
    state_->plans.withdrawProposal(branchId);
}

const command::PlanStore& Session::plans() const noexcept {
    return state_->plans;
}

const command::Plan& Session::submitPlan(std::vector<command::Command> steps, std::vector<model::EntityRef> readSet,
                                         const std::string& baseRevision) {
    return state_->plans.submit(state_->history, std::move(steps), std::move(readSet), baseRevision);
}

const command::Plan& Session::approvePlan(std::string_view planHashText, std::string approvedBy, std::string time) {
    return state_->plans.approve(state_->history, planHashText, std::move(approvedBy), std::move(time));
}

const command::Plan& Session::approvePlanPartial(std::string_view planHashText,
                                                 const std::vector<std::size_t>& stepIndexes, std::string approvedBy,
                                                 std::string time) {
    return state_->plans.approvePartial(state_->history, planHashText, stepIndexes, std::move(approvedBy),
                                        std::move(time));
}

const command::Plan& Session::rejectPlan(std::string_view planHashText, std::string rejectedBy, std::string time,
                                         std::string note) {
    return state_->plans.reject(planHashText, std::move(rejectedBy), std::move(time), std::move(note));
}

const Revision& Session::applyPlan(std::string_view planHashText, std::string actor, std::string time) {
    return state_->plans.apply(state_->history, planHashText, std::move(actor), std::move(time),
                               [this](std::vector<command::Command> steps, std::string a, std::string t)
                                   -> const Revision& { return commit(std::move(steps), std::move(a), std::move(t),
                                                                      Cause::plan); });
}

command::BranchId Session::proposePlan(std::string_view planHashText, std::string actor, std::string time) {
    return state_->plans.propose(planHashText, [&](const command::Plan& plan) {
        const command::BranchId branchId = state_->history.branch(plan.baseRevision);
        try {
            commitOn(branchId, plan.steps, std::move(actor), std::move(time), Cause::plan);
        } catch (...) {
            state_->history.discard(branchId);
            throw;
        }
        return branchId;
    });
}

}  // namespace siann::session
