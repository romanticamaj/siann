#include "siann/session/journal.hpp"

#include <utility>

#include "siann/hash/jcs.hpp"
#include "siann/model/field_reader.hpp"

namespace siann::session {

using command::Cause;
using json::Array;
using json::Object;
using json::Value;
using model::DiffEntry;
using model::EntityType;
using model::detail::FieldReader;

SessionError::SessionError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

namespace {

constexpr std::string_view kRecordSchema = "siann.journal_record.v1";

Cause causeFromName(const std::string& name) {
    if (name == "create") return Cause::create;
    if (name == "command") return Cause::command;
    if (name == "plan") return Cause::plan;
    if (name == "undo") return Cause::undo;
    if (name == "redo") return Cause::redo;
    throw SessionError("corrupt_record", "unknown cause " + name);
}

std::string_view changeName(DiffEntry::Change change) {
    switch (change) {
        case DiffEntry::Change::added: return "added";
        case DiffEntry::Change::removed: return "removed";
        case DiffEntry::Change::modified: return "modified";
    }
    return "modified";
}

DiffEntry::Change changeFromName(const std::string& name) {
    if (name == "added") return DiffEntry::Change::added;
    if (name == "removed") return DiffEntry::Change::removed;
    if (name == "modified") return DiffEntry::Change::modified;
    throw SessionError("corrupt_record", "unknown change " + name);
}

EntityType typeFromName(const std::string& name) {
    if (name == "root") return EntityType::root;
    if (name == "media") return EntityType::media;
    if (name == "track") return EntityType::track;
    if (name == "clip") return EntityType::clip;
    throw SessionError("corrupt_record", "unknown entity type " + name);
}

Value recordBody(const JournalRecord& record) {
    Array commands;
    for (const auto& command : record.commands) {
        commands.push_back(command.json);
    }
    Array diff;
    for (const auto& entry : record.diff) {
        diff.push_back(Value(Object{{"type", Value(std::string(model::entityTypeName(entry.entity.type)))},
                                    {"id", Value(entry.entity.id)},
                                    {"change", Value(std::string(changeName(entry.change)))}}));
    }
    Object body{
        {"schema", Value(std::string(kRecordSchema))},
        {"seq", Value(std::to_string(record.seq))},
        {"revision", envelopeToJson(record.envelope)},
        {"commands", Value(std::move(commands))},
        {"diff", Value(std::move(diff))},
    };
    if (record.target) {
        body.emplace_back("target", Value(*record.target));
    }
    if (record.document) {
        body.emplace_back("document", record.document->toJson());
    }
    return Value(std::move(body));
}

}  // namespace

Value envelopeToJson(const command::RevisionEnvelope& envelope) {
    Array parents;
    for (const auto& parent : envelope.parents) {
        parents.push_back(Value(parent));
    }
    return Value(Object{
        {"id", Value(envelope.id)},
        {"parents", Value(std::move(parents))},
        {"documentHash", Value(hash::formatHash(envelope.documentHash))},
        {"cause", Value(std::string(command::causeName(envelope.cause)))},
        {"actor", Value(envelope.actor)},
        {"time", Value(envelope.time)},
    });
}

command::RevisionEnvelope envelopeFromJson(const Value& value) {
    FieldReader r(value, "revision");
    command::RevisionEnvelope envelope;
    envelope.id = r.string("id");
    const Value& parents = r.require("parents");
    if (parents.kind() != Value::Kind::array) {
        r.fail("parents", "must be an array");
    }
    for (const Value& parent : parents.asArray()) {
        if (parent.kind() != Value::Kind::string) {
            r.fail("parents", "must contain strings");
        }
        envelope.parents.push_back(parent.asString());
    }
    envelope.documentHash = r.digest("documentHash");
    envelope.cause = causeFromName(r.string("cause"));
    envelope.actor = r.string("actor");
    envelope.time = r.string("time");
    r.finish();
    return envelope;
}

JournalRecord recordFromRevision(std::int64_t seq, const command::Revision& revision) {
    JournalRecord record;
    record.seq = seq;
    record.envelope = revision.envelope;
    record.commands = revision.commands;
    record.target = revision.target;
    record.diff = revision.diff;
    if (revision.envelope.cause == Cause::create) {
        record.document = revision.document;
    }
    return record;
}

std::string encodeRecord(const JournalRecord& record) {
    Value body = recordBody(record);
    Object members = body.asObject();
    members.emplace_back("checksum", Value(jcs::sha256Jcs(body)));
    return jcs::canonicalize(Value(std::move(members)));
}

JournalRecord decodeRecord(std::string_view line) {
    Value value;
    try {
        value = json::parse(line);
    } catch (const json::ParseError& error) {
        throw SessionError("corrupt_record", std::string("record is not valid JSON: ") + error.what());
    }
    if (value.kind() != Value::Kind::object) {
        throw SessionError("corrupt_record", "record must be a JSON object");
    }
    const Value* schema = value.find("schema");
    if (schema == nullptr || schema->kind() != Value::Kind::string) {
        throw SessionError("corrupt_record", "record has no schema");
    }
    if (schema->asString() != kRecordSchema) {
        throw SessionError("unsupported_version", "journal record schema " + schema->asString() + " is not supported");
    }
    const Value* checksum = value.find("checksum");
    if (checksum == nullptr || checksum->kind() != Value::Kind::string) {
        throw SessionError("corrupt_record", "record has no checksum");
    }
    Object withoutChecksum;
    for (const auto& member : value.asObject()) {
        if (member.first != "checksum") {
            withoutChecksum.push_back(member);
        }
    }
    if (jcs::sha256Jcs(Value(std::move(withoutChecksum))) != checksum->asString()) {
        throw SessionError("checksum_mismatch", "record checksum does not match its content");
    }

    try {
        FieldReader r(value, "record");
        r.string("schema");
        r.string("checksum");
        JournalRecord record;
        record.seq = r.int64String("seq");
        record.envelope = envelopeFromJson(r.require("revision"));
        const Value& commands = r.require("commands");
        if (commands.kind() != Value::Kind::array) {
            r.fail("commands", "must be an array");
        }
        for (const Value& command : commands.asArray()) {
            record.commands.push_back(command::Command::fromJson(command));
        }
        const Value& diff = r.require("diff");
        if (diff.kind() != Value::Kind::array) {
            r.fail("diff", "must be an array");
        }
        for (const Value& entry : diff.asArray()) {
            FieldReader d(entry, "diff[]");
            DiffEntry parsed;
            parsed.entity.type = typeFromName(d.string("type"));
            parsed.entity.id = d.string("id");
            parsed.change = changeFromName(d.string("change"));
            d.finish();
            record.diff.push_back(std::move(parsed));
        }
        if (r.optional("target") != nullptr) {
            record.target = r.string("target");
        }
        if (const Value* document = r.optional("document")) {
            record.document = model::Document::fromJson(*document);
        }
        r.finish();
        return record;
    } catch (const model::ModelError& error) {
        throw SessionError("corrupt_record", error.what());
    } catch (const command::CommandError& error) {
        throw SessionError("corrupt_record", error.what());
    }
}

JournalScan scanJournal(std::string_view content) {
    JournalScan scan;
    std::size_t pos = 0;
    while (pos < content.size()) {
        const std::size_t end = content.find('\n', pos);
        if (end == std::string_view::npos) {
            scan.tailError = "incomplete record after seq " + std::to_string(scan.records.size());
            return scan;
        }
        try {
            JournalRecord record = decodeRecord(content.substr(pos, end - pos));
            const auto expected = static_cast<std::int64_t>(scan.records.size()) + 1;
            if (record.seq != expected) {
                scan.tailError = "sequence gap: expected " + std::to_string(expected) + ", found " +
                                 std::to_string(record.seq);
                return scan;
            }
            scan.records.push_back(std::move(record));
        } catch (const SessionError& error) {
            scan.tailError = error.code() + " at seq " + std::to_string(scan.records.size() + 1) + ": " + error.what();
            return scan;
        }
        pos = end + 1;
        scan.validBytes = pos;
    }
    return scan;
}

}  // namespace siann::session
