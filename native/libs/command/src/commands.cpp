#include "siann/command/command.hpp"

#include <algorithm>
#include <functional>
#include <map>
#include <utility>

#include "siann/model/field_reader.hpp"

namespace siann::command {

using model::Clip;
using model::Document;
using model::EntityRef;
using model::EntityType;
using model::Gain;
using model::Media;
using model::Track;
using model::detail::FieldReader;

CommandError::CommandError(std::string code, const std::string& message, std::size_t step)
    : std::runtime_error(message), code_(std::move(code)), step_(step) {}

Command Command::fromJson(json::Value value) {
    if (value.kind() != json::Value::Kind::object) {
        throw CommandError("invalid_params", "a command must be a JSON object");
    }
    const json::Value* op = value.find("op");
    if (op == nullptr || op->kind() != json::Value::Kind::string) {
        throw CommandError("invalid_params", "a command needs a string \"op\"");
    }
    return Command{std::move(value)};
}

std::string_view Command::op() const {
    return json.find("op")->asString();
}

namespace {

const EntityRef kRoot{EntityType::root, "root"};

EntityRef trackRef(std::string id) {
    return {EntityType::track, std::move(id)};
}
EntityRef clipRef(std::string id) {
    return {EntityType::clip, std::move(id)};
}
EntityRef mediaRef(std::string id) {
    return {EntityType::media, std::move(id)};
}

// Reads a command's parameters; "op" is consumed up front.
class Params {
public:
    explicit Params(const Command& command) : reader_(command.json, std::string(command.op())) {
        reader_.string("op");
    }
    FieldReader& operator*() { return reader_; }
    FieldReader* operator->() { return &reader_; }
    void finish() const { reader_.finish(); }

private:
    FieldReader reader_;
};

Gain gainParam(FieldReader& r, std::string_view key) {
    return Gain{static_cast<std::int32_t>(r.integer(key, INT32_MIN, INT32_MAX))};
}

time::Position positionParam(FieldReader& r, std::string_view key) {
    FieldReader p(r.require(key), std::string(key));
    const std::string domain = p.string("domain");
    const std::int64_t value = p.int64String("value");
    p.finish();
    if (domain == "audio") {
        return time::Position::audio(value);
    }
    if (domain == "music") {
        return time::Position::music(value);
    }
    r.fail(key, "domain must be audio or music");
}

const Track& requireTrack(const Document& doc, const std::string& id) {
    const Track* t = doc.track(id);
    if (t == nullptr) {
        throw CommandError("not_found", "no track with id " + id);
    }
    return *t;
}

const Clip& requireClip(const Document& doc, const std::string& id) {
    const Clip* c = doc.clip(id);
    if (c == nullptr) {
        throw CommandError("not_found", "no clip with id " + id);
    }
    return *c;
}

// Applies a change to one track field.
Prepared editTrack(const Document& doc, const Command& command, const std::function<void(Track&, FieldReader&)>& edit) {
    Params p(command);
    Track t = requireTrack(doc, p->string("trackId"));
    edit(t, *p);
    p.finish();
    const std::string id = t.id;
    return {{trackRef(id)}, doc.withTrack(std::move(t))};
}

Prepared editClip(const Document& doc, const Command& command, const std::function<void(Clip&, FieldReader&)>& edit) {
    Params p(command);
    Clip c = requireClip(doc, p->string("clipId"));
    edit(c, *p);
    p.finish();
    const std::string id = c.id;
    return {{clipRef(id)}, doc.withClip(std::move(c))};
}

Prepared trackAdd(const Document& doc, const Command& command) {
    Params p(command);
    Track t;
    t.id = p->string("trackId");
    t.name = p->string("name");
    t.channels = static_cast<std::int32_t>(p->integer("channels", INT32_MIN, INT32_MAX));
    auto root = doc.root();
    std::size_t index = root.trackOrder.size();
    if (p->optional("index") != nullptr) {
        index = static_cast<std::size_t>(p->integer("index", 0, static_cast<std::int64_t>(root.trackOrder.size())));
    }
    p.finish();
    if (doc.track(t.id) != nullptr) {
        throw CommandError("already_exists", "a track with id " + t.id + " already exists");
    }
    root.trackOrder.insert(root.trackOrder.begin() + static_cast<std::ptrdiff_t>(index), t.id);
    const std::string id = t.id;
    return {{kRoot, trackRef(id)}, doc.withTrack(std::move(t)).withRoot(std::move(root))};
}

Prepared trackRemove(const Document& doc, const Command& command) {
    Params p(command);
    const std::string id = p->string("trackId");
    p.finish();
    requireTrack(doc, id);
    DeclaredEffects effects{kRoot, trackRef(id)};
    Document result = doc;
    for (const Clip* c : doc.clipsOnTrack(id)) {
        effects.insert(clipRef(c->id));
        result = result.withoutClip(c->id);
    }
    auto root = doc.root();
    root.trackOrder.erase(std::remove(root.trackOrder.begin(), root.trackOrder.end(), id), root.trackOrder.end());
    return {std::move(effects), result.withoutTrack(id).withRoot(std::move(root))};
}

Prepared mediaAdd(const Document& doc, const Command& command) {
    Params p(command);
    Media m;
    m.id = p->string("mediaId");
    m.contentHash = p->digest("contentHash");
    if (p->optional("originalHash") != nullptr) {
        m.originalHash = p->digest("originalHash");
    }
    const std::string format = p->string("format");
    if (format == "wav") {
        m.format = model::MediaFormat::wav;
    } else if (format == "flac") {
        m.format = model::MediaFormat::flac;
    } else {
        p->fail("format", "must be wav or flac");
    }
    m.channels = static_cast<std::int32_t>(p->integer("channels", INT32_MIN, INT32_MAX));
    m.sampleRate = p->integer("sampleRate", 0, INT32_MAX);
    m.frames = p->int64String("frames");
    p.finish();
    if (doc.media(m.id) != nullptr) {
        throw CommandError("already_exists", "media with id " + m.id + " already exists");
    }
    const std::string id = m.id;
    return {{mediaRef(id)}, doc.withMedia(std::move(m))};
}

Prepared mediaRemove(const Document& doc, const Command& command) {
    Params p(command);
    const std::string id = p->string("mediaId");
    p.finish();
    if (doc.media(id) == nullptr) {
        throw CommandError("not_found", "no media with id " + id);
    }
    for (const Track* t : doc.tracksInOrder()) {
        for (const Clip* c : doc.clipsOnTrack(t->id)) {
            if (c->mediaId == id) {
                throw CommandError("media_in_use", "media " + id + " is used by clip " + c->id);
            }
        }
    }
    return {{mediaRef(id)}, doc.withoutMedia(id)};
}

Prepared clipPlace(const Document& doc, const Command& command) {
    Params p(command);
    Clip c;
    c.id = p->string("clipId");
    c.trackId = p->string("trackId");
    c.mediaId = p->string("mediaId");
    c.position = positionParam(*p, "position");
    c.sourceStart = p->int64String("sourceStart");
    c.length = p->int64String("length");
    if (p->optional("gainMilliDb") != nullptr) {
        c.gain = gainParam(*p, "gainMilliDb");
    }
    p.finish();
    if (doc.clip(c.id) != nullptr) {
        throw CommandError("already_exists", "a clip with id " + c.id + " already exists");
    }
    requireTrack(doc, c.trackId);
    if (doc.media(c.mediaId) == nullptr) {
        throw CommandError("not_found", "no media with id " + c.mediaId);
    }
    const std::string id = c.id;
    return {{clipRef(id)}, doc.withClip(std::move(c))};
}

Prepared clipMove(const Document& doc, const Command& command) {
    return editClip(doc, command, [&](Clip& c, FieldReader& r) {
        c.position = positionParam(r, "position");
        if (r.optional("trackId") != nullptr) {
            c.trackId = r.string("trackId");
            requireTrack(doc, c.trackId);
        }
    });
}

Prepared clipRemove(const Document& doc, const Command& command) {
    Params p(command);
    const std::string id = p->string("clipId");
    p.finish();
    requireClip(doc, id);
    return {{clipRef(id)}, doc.withoutClip(id)};
}

Prepared sessionRename(const Document& doc, const Command& command) {
    Params p(command);
    auto root = doc.root();
    root.name = p->string("name");
    p.finish();
    return {{kRoot}, doc.withRoot(std::move(root))};
}

Prepared sessionSetTempo(const Document& doc, const Command& command) {
    Params p(command);
    const json::Value& tempo = p->require("tempo");
    if (tempo.kind() != json::Value::Kind::array) {
        p->fail("tempo", "must be an array");
    }
    auto root = doc.root();
    root.tempo.clear();
    for (const json::Value& point : tempo.asArray()) {
        FieldReader t(point, "tempo[]");
        time::TempoPoint tp;
        tp.position = time::MusicTime{t.int64String("ticks")};
        tp.milliBpm = static_cast<std::int32_t>(t.integer("milliBpm", INT32_MIN, INT32_MAX));
        t.finish();
        root.tempo.push_back(tp);
    }
    p.finish();
    return {{kRoot}, doc.withRoot(std::move(root))};
}

using Handler = Prepared (*)(const Document&, const Command&);

const std::map<std::string, Handler, std::less<>>& registry() {
    static const std::map<std::string, Handler, std::less<>> handlers = {
        {"clip.move", &clipMove},
        {"clip.place", &clipPlace},
        {"clip.remove", &clipRemove},
        {"clip.set_gain",
         [](const Document& d, const Command& c) {
             return editClip(d, c, [](Clip& clip, FieldReader& r) { clip.gain = gainParam(r, "gainMilliDb"); });
         }},
        {"clip.trim",
         [](const Document& d, const Command& c) {
             return editClip(d, c, [](Clip& clip, FieldReader& r) {
                 clip.sourceStart = r.int64String("sourceStart");
                 clip.length = r.int64String("length");
             });
         }},
        {"media.add", &mediaAdd},
        {"media.remove", &mediaRemove},
        {"session.rename", &sessionRename},
        {"session.set_tempo", &sessionSetTempo},
        {"track.add", &trackAdd},
        {"track.remove", &trackRemove},
        {"track.rename",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) { t.name = r.string("name"); });
         }},
        {"track.set_gain",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) { t.gain = gainParam(r, "gainMilliDb"); });
         }},
        {"track.set_mute",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) { t.mute = r.boolean("mute"); });
         }},
        {"track.set_pan",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) {
                 t.pan = static_cast<std::int32_t>(r.integer("pan", INT32_MIN, INT32_MAX));
             });
         }},
        {"track.set_solo",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) { t.solo = r.boolean("solo"); });
         }},
    };
    return handlers;
}

void requireValid(const Document& doc) {
    const auto issues = doc.validate();
    if (!issues.empty()) {
        throw CommandError(issues.front().code, issues.front().message);
    }
}

}  // namespace

void checkDeclaredEffects(const Document& before, const Document& after, const DeclaredEffects& declared) {
    for (const auto& change : diff(before, after)) {
        if (declared.count(change.entity) == 0) {
            throw CommandError("undeclared_effect", "command changed " +
                                                        std::string(model::entityTypeName(change.entity.type)) + ":" +
                                                        change.entity.id + " without declaring it");
        }
    }
}

Prepared prepare(const Document& document, const Command& command) {
    const auto& handlers = registry();
    const auto it = handlers.find(command.op());
    if (it == handlers.end()) {
        throw CommandError("unknown_command", "unknown command " + std::string(command.op()));
    }
    Prepared prepared = [&] {
        try {
            return it->second(document, command);
        } catch (const model::ModelError& error) {
            throw CommandError("invalid_params", error.what());
        }
    }();
    requireValid(prepared.result);
    checkDeclaredEffects(document, prepared.result, prepared.effects);
    return prepared;
}

Prepared prepareTransaction(const Document& document, const std::vector<Command>& commands) {
    if (commands.empty()) {
        throw CommandError("empty_transaction", "a transaction needs at least one command");
    }
    DeclaredEffects effects;
    Document current = document;
    for (std::size_t i = 0; i < commands.size(); ++i) {
        try {
            Prepared step = prepare(current, commands[i]);
            effects.insert(step.effects.begin(), step.effects.end());
            current = std::move(step.result);
        } catch (const CommandError& error) {
            throw CommandError(error.code(), error.what(), i);
        }
    }
    checkDeclaredEffects(document, current, effects);
    return {std::move(effects), std::move(current)};
}

std::vector<std::string> commandNames() {
    std::vector<std::string> names;
    for (const auto& entry : registry()) {
        names.push_back(entry.first);
    }
    return names;
}

}  // namespace siann::command
