#pragma once

// Journal records (architecture spec, "Journal as write-ahead log"). One line
// of journal.ndjson is one complete record, and one record is one revision:
// schema siann.journal_record.v1, a contiguous sequence number, the revision
// envelope, the commands or undo/redo target, the diff, and a SHA-256 over the
// JCS of the record without its checksum field. The first record (cause
// create) also carries the initial document.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "siann/command/history.hpp"
#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"

namespace siann::session {

class SessionError : public std::runtime_error {
public:
    SessionError(std::string code, const std::string& message);

    // Stable codes: corrupt_record, checksum_mismatch, unsupported_version,
    // missing_create_record, replay_mismatch, checkpoint_mismatch,
    // journal_behind_checkpoint, bundle_exists, not_a_bundle.
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

struct JournalRecord {
    std::int64_t seq = 0;
    command::RevisionEnvelope envelope;
    std::vector<command::Command> commands;
    std::optional<std::string> target;
    std::vector<model::DiffEntry> diff;
    std::optional<model::Document> document;  // create records only
};

json::Value envelopeToJson(const command::RevisionEnvelope& envelope);
command::RevisionEnvelope envelopeFromJson(const json::Value& value);

JournalRecord recordFromRevision(std::int64_t seq, const command::Revision& revision);

// One canonical JSON line, without the trailing newline.
std::string encodeRecord(const JournalRecord& record);

// Throws SessionError (corrupt_record, checksum_mismatch, unsupported_version).
JournalRecord decodeRecord(std::string_view line);

struct JournalScan {
    std::vector<JournalRecord> records;
    std::size_t validBytes = 0;  // length of the trusted prefix
    std::optional<std::string> tailError;  // why scanning stopped early
};

// Reads records in order and stops at the first line that is incomplete,
// fails to decode, or breaks sequence continuity. Everything before that point
// is trusted; everything from it on is the damaged tail.
JournalScan scanJournal(std::string_view content);

}  // namespace siann::session
