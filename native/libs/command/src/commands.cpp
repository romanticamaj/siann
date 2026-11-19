#include "siann/command/command.hpp"

#include <algorithm>
#include <functional>
#include <initializer_list>
#include <map>
#include <optional>
#include <utility>

#include "siann/model/display_text.hpp"
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
EntityRef slotRef(std::string id) {
    return {EntityType::plugin_slot, std::move(id)};
}
EntityRef busRef(std::string id) {
    return {EntityType::bus, std::move(id)};
}
EntityRef sendRef(std::string id) {
    return {EntityType::send, std::move(id)};
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

// A name the document stores (spec "siann-model", names; follow-up to #123):
// well-formed UTF-8 without a control character, a bidi formatting character
// or U+2028/U+2029, else invalid_name. Checked here, before the entity is
// hashed (JCS refuses malformed UTF-8 with an error of its own), and again by
// Document::validate for every name of the result.
std::string nameParam(FieldReader& r) {
    std::string name = r.string("name");
    if (!model::isDisplaySafeName(name)) {
        throw CommandError("invalid_name",
                           "name must be well-formed UTF-8 without control characters, bidi formatting "
                           "characters or line separators");
    }
    return name;
}

// The media name (m5b-engine-project-media): 1 to 255 bytes, invalid_params
// otherwise; what it may hold is nameParam's rule.
std::string mediaNameParam(FieldReader& r) {
    std::string name = nameParam(r);
    if (name.empty() || name.size() > model::kMaxMediaNameBytes) {
        r.fail("name", "must be 1 to 255 bytes of UTF-8");
    }
    return name;
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
    t.name = nameParam(*p);
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
    for (const model::PluginSlot* s : doc.slotsOnTrack(id)) {
        effects.insert(slotRef(s->id));
        result = result.withoutPluginSlot(s->id);
    }
    for (const model::Send* s : doc.sendsOnTrack(id)) {
        effects.insert(sendRef(s->id));
        result = result.withoutSend(s->id);
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
    if (p->optional("name") != nullptr) {
        m.name = mediaNameParam(*p);
    }
    p.finish();
    if (doc.media(m.id) != nullptr) {
        throw CommandError("already_exists", "media with id " + m.id + " already exists");
    }
    const std::string id = m.id;
    return {{mediaRef(id)}, doc.withMedia(std::move(m))};
}

// media.rename {mediaId, name}: a string sets the display name, null removes it
// (the entity then hashes as it did before it had one).
Prepared mediaRename(const Document& doc, const Command& command) {
    Params p(command);
    const std::string id = p->string("mediaId");
    const json::Value& given = p->require("name");
    std::optional<std::string> name;
    if (given.kind() != json::Value::Kind::null) {
        name = mediaNameParam(*p);
    }
    p.finish();
    const Media* existing = doc.media(id);
    if (existing == nullptr) {
        throw CommandError("not_found", "no media with id " + id);
    }
    Media m = *existing;
    m.name = std::move(name);
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

const model::Bus& requireBus(const Document& doc, const std::string& id) {
    const model::Bus* b = doc.bus(id);
    if (b == nullptr) {
        throw CommandError("not_found", "no bus with id " + id);
    }
    return *b;
}

const model::Send& requireSend(const Document& doc, const std::string& id) {
    const model::Send* s = doc.send(id);
    if (s == nullptr) {
        throw CommandError("not_found", "no send with id " + id);
    }
    return *s;
}

// An output route, {busId} or null for the master (m5b-engine-buses-sends). An
// unknown bus is not_found; another shape is invalid_params.
std::optional<std::string> outputParam(const Document& doc, FieldReader& r) {
    const json::Value& output = r.require("output");
    if (output.isNull()) {
        return std::nullopt;
    }
    FieldReader o(output, "output");
    std::string busId = o.string("busId");
    o.finish();
    requireBus(doc, busId);
    return busId;
}

const model::PluginSlot& requireSlot(const Document& doc, const std::string& id) {
    const model::PluginSlot* s = doc.pluginSlot(id);
    if (s == nullptr) {
        throw CommandError("not_found", "no plugin slot with id " + id);
    }
    return *s;
}

// plugin.insert {trackId, index, slotId, descriptor{format, uid, name?, path?},
// stateBlob}: the completion command of plugin.instantiate. index clamps to the end.
Prepared pluginInsert(const Document& doc, const Command& command) {
    Params p(command);
    model::PluginSlot s;
    // Exactly one owner (m5b-engine-buses-sends).
    const bool onTrack = p->optional("trackId") != nullptr;
    if (onTrack == (p->optional("busId") != nullptr)) {
        p->fail(onTrack ? "busId" : "trackId", "plugin.insert takes exactly one of trackId or busId");
    }
    if (onTrack) {
        s.trackId = p->string("trackId");
    } else {
        s.busId = p->string("busId");
    }
    const std::int64_t index = p->integer("index", 0, INT32_MAX);
    s.id = p->string("slotId");
    {
        FieldReader d(p->require("descriptor"), "descriptor");
        s.format = d.string("format");
        s.uid = d.string("uid");
        if (d.optional("name") != nullptr) {
            s.name = nameParam(d);
        }
        if (d.optional("path") != nullptr) {
            s.path = d.string("path");
            // No bundle in reach here: the UNC forms only (Protocol v0 item 21).
            if (const auto refused = model::pluginPathRefusal(s.path)) {
                d.fail("path", "is refused (" + *refused + "): plugins load from registered installs only");
            }
        }
        d.finish();
    }
    const json::Value& blob = p->require("stateBlob");
    if (blob.kind() == json::Value::Kind::string) {
        s.stateBlob = blob.asString();
    } else if (blob.kind() != json::Value::Kind::null) {
        p->fail("stateBlob", "must be a string or null");
    }
    p.finish();
    if (doc.pluginSlot(s.id) != nullptr) {
        throw CommandError("already_exists", "a plugin slot with id " + s.id + " already exists");
    }
    const std::string slotId = s.id;
    auto insertAt = [index, &slotId](std::vector<std::string>& inserts) {
        const auto at = std::min<std::size_t>(static_cast<std::size_t>(index), inserts.size());
        inserts.insert(inserts.begin() + static_cast<std::ptrdiff_t>(at), slotId);
    };
    if (!onTrack) {
        model::Bus b = requireBus(doc, s.busId);
        insertAt(b.inserts);
        const std::string busId = b.id;
        return {{busRef(busId), slotRef(slotId)}, doc.withPluginSlot(std::move(s)).withBus(std::move(b))};
    }
    Track t = requireTrack(doc, s.trackId);
    insertAt(t.inserts);
    const std::string trackId = t.id;
    return {{trackRef(trackId), slotRef(slotId)}, doc.withPluginSlot(std::move(s)).withTrack(std::move(t))};
}

Prepared pluginRemove(const Document& doc, const Command& command) {
    Params p(command);
    const std::string id = p->string("slotId");
    p.finish();
    const model::PluginSlot& slot = requireSlot(doc, id);
    if (!slot.busId.empty()) {
        model::Bus b = requireBus(doc, slot.busId);
        b.inserts.erase(std::remove(b.inserts.begin(), b.inserts.end(), id), b.inserts.end());
        const std::string busId = b.id;
        return {{busRef(busId), slotRef(id)}, doc.withoutPluginSlot(id).withBus(std::move(b))};
    }
    Track t = requireTrack(doc, slot.trackId);
    t.inserts.erase(std::remove(t.inserts.begin(), t.inserts.end(), id), t.inserts.end());
    const std::string trackId = t.id;
    return {{trackRef(trackId), slotRef(id)}, doc.withoutPluginSlot(id).withTrack(std::move(t))};
}

Prepared pluginSetBypass(const Document& doc, const Command& command) {
    Params p(command);
    model::PluginSlot s = requireSlot(doc, p->string("slotId"));
    s.bypass = p->boolean("bypass");
    p.finish();
    const std::string id = s.id;
    return {{slotRef(id)}, doc.withPluginSlot(std::move(s))};
}

Prepared sessionRename(const Document& doc, const Command& command) {
    Params p(command);
    auto root = doc.root();
    root.name = nameParam(*p);
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

// The left and right locators (m5-ui-engine-loop-click), audio-domain frames
// as decimal strings. A number or a malformed string is invalid_params (the
// field reader's ModelError); an order or range problem is the document's
// invalid_locators.
Prepared sessionSetLocators(const Document& doc, const Command& command) {
    Params p(command);
    model::Locators value;
    value.left = p->int64String("left");
    value.right = p->int64String("right");
    p.finish();
    return {{EntityRef{EntityType::locators, std::string(model::kLocatorsId)}}, doc.withLocators(value)};
}

// The master gain (m5b-engine-master): {gainMilliDb}, the track gain's range and
// error. The entity exists only while the gain is not 0 dB, so 0 removes it, or
// leaves the document as it is when there is none (a revision with an empty
// diff, as track.set_gain to the value already set). Always declares exactly
// master:master, so a master change never touches root:root.
Prepared masterSetGain(const Document& doc, const Command& command) {
    Params p(command);
    const Gain gain = gainParam(*p, "gainMilliDb");
    p.finish();
    const EntityRef ref{EntityType::master, std::string(model::kMasterId)};
    if (gain.milliDb == 0) {
        return {{ref}, doc.master() != nullptr ? doc.withoutMaster() : doc};
    }
    return {{ref}, doc.withMaster(model::Master{gain})};
}

// A track's input (m5b-engine-record): {port, channels} or null, as one edit of
// the track. A negative port, channels other than 1 or 2, a missing or extra
// field are invalid_params (the field reader's ModelError).
Prepared trackSetInput(const Document& doc, const Command& command) {
    return editTrack(doc, command, [](Track& t, FieldReader& r) {
        const json::Value& input = r.require("input");
        if (input.isNull()) {
            t.input.reset();
            return;
        }
        FieldReader in(input, "input");
        model::TrackInput value;
        value.port = static_cast<std::int32_t>(in.integer("port", 0, INT32_MAX));
        value.channels = static_cast<std::int32_t>(in.integer("channels", 1, 2));
        in.finish();
        t.input = value;
    });
}

// A track's notes (m5b-engine-track-notes): plain text stored byte for byte;
// "" removes the field, so the track hashes as it did before it had notes. Over
// kMaxTrackNotesBytes, malformed UTF-8, a control character other than tab, LF
// and CR or a display-unsafe character is invalid_notes; a non-string (null
// included), a missing or an extra field is invalid_params.
Prepared trackSetNotes(const Document& doc, const Command& command) {
    return editTrack(doc, command, [](Track& t, FieldReader& r) {
        std::string notes = r.string("notes");
        if (notes.empty()) {
            t.notes.reset();
            return;
        }
        if (!model::isValidTrackNotes(notes)) {
            throw CommandError("invalid_notes", "track notes are at most 16384 bytes of well-formed UTF-8 without a control character "
                               "other than tab, LF and CR or a text-direction control");
        }
        t.notes = std::move(notes);
    });
}

// A track's monitoring mode (m5b-engine-monitoring): {trackId, monitor: "off" |
// "auto" | "input"}, one edit of the track. Any other value, a missing or an
// extra field is invalid_params (the field reader's ModelError).
Prepared trackSetMonitor(const Document& doc, const Command& command) {
    return editTrack(doc, command, [](Track& t, FieldReader& r) {
        const std::optional<model::MonitorMode> mode = model::monitorModeFromName(r.string("monitor"));
        if (!mode) {
            r.fail("monitor", "must be off, auto or input");
        }
        t.monitor = *mode;
    });
}

// ---- buses and sends (m5b-engine-buses-sends) -------------------------------

Prepared editBus(const Document& doc, const Command& command,
                 const std::function<void(model::Bus&, FieldReader&)>& edit) {
    Params p(command);
    model::Bus b = requireBus(doc, p->string("busId"));
    edit(b, *p);
    p.finish();
    const std::string id = b.id;
    return {{busRef(id)}, doc.withBus(std::move(b))};
}

Prepared editSend(const Document& doc, const Command& command,
                  const std::function<void(model::Send&, FieldReader&)>& edit) {
    Params p(command);
    model::Send s = requireSend(doc, p->string("sendId"));
    edit(s, *p);
    p.finish();
    const std::string id = s.id;
    return {{sendRef(id)}, doc.withSend(std::move(s))};
}

// bus.add {busId, name, index?}: a stereo bus at 0 dB, centre, feeding the master.
Prepared busAdd(const Document& doc, const Command& command) {
    Params p(command);
    model::Bus b;
    b.id = p->string("busId");
    b.name = nameParam(*p);
    auto root = doc.root();
    std::size_t index = root.busOrder.size();
    if (p->optional("index") != nullptr) {
        index = static_cast<std::size_t>(p->integer("index", 0, static_cast<std::int64_t>(root.busOrder.size())));
    }
    p.finish();
    if (doc.bus(b.id) != nullptr) {
        throw CommandError("already_exists", "a bus with id " + b.id + " already exists");
    }
    root.busOrder.insert(root.busOrder.begin() + static_cast<std::ptrdiff_t>(index), b.id);
    const std::string id = b.id;
    return {{kRoot, busRef(id)}, doc.withBus(std::move(b)).withRoot(std::move(root))};
}

// bus.remove {busId}: the bus, its sends and slots; every track and bus that
// outputs to it feeds the master afterwards. All of it is declared.
Prepared busRemove(const Document& doc, const Command& command) {
    Params p(command);
    const std::string id = p->string("busId");
    p.finish();
    requireBus(doc, id);
    DeclaredEffects effects{kRoot, busRef(id)};
    Document result = doc;
    for (const model::PluginSlot* s : doc.slotsOnBus(id)) {
        effects.insert(slotRef(s->id));
        result = result.withoutPluginSlot(s->id);
    }
    for (const model::Send* s : doc.allSends()) {
        if (s->busId != id) {
            continue;
        }
        effects.insert(sendRef(s->id));
        result = result.withoutSend(s->id);
        Track owner = *result.track(s->trackId);
        owner.sends.erase(std::remove(owner.sends.begin(), owner.sends.end(), s->id), owner.sends.end());
        effects.insert(trackRef(owner.id));
        result = result.withTrack(std::move(owner));
    }
    for (const Track* t : doc.tracksInOrder()) {
        if (t->output == id) {
            Track rerouted = *result.track(t->id);
            rerouted.output.reset();
            effects.insert(trackRef(rerouted.id));
            result = result.withTrack(std::move(rerouted));
        }
    }
    for (const model::Bus* b : doc.allBuses()) {
        if (b->output == id) {
            model::Bus rerouted = *b;
            rerouted.output.reset();
            effects.insert(busRef(rerouted.id));
            result = result.withBus(std::move(rerouted));
        }
    }
    auto root = doc.root();
    root.busOrder.erase(std::remove(root.busOrder.begin(), root.busOrder.end(), id), root.busOrder.end());
    return {std::move(effects), result.withoutBus(id).withRoot(std::move(root))};
}

// bus.set_output {busId, output: {busId} | null}: a route back to the bus itself,
// directly or through a chain of buses, is routing_cycle.
Prepared busSetOutput(const Document& doc, const Command& command) {
    return editBus(doc, command, [&doc](model::Bus& b, FieldReader& r) {
        b.output = outputParam(doc, r);
        const model::Bus* next = b.output ? doc.bus(*b.output) : nullptr;
        for (std::size_t steps = 0; next != nullptr && steps <= doc.allBuses().size(); ++steps) {
            if (next->id == b.id) {
                throw CommandError("routing_cycle", "bus " + b.id + " would reach itself through its output");
            }
            next = next->output ? doc.bus(*next->output) : nullptr;
        }
    });
}

// send.add {sendId, trackId, busId, levelMilliDb?, pre?, enabled?, index?}.
Prepared sendAdd(const Document& doc, const Command& command) {
    Params p(command);
    model::Send s;
    s.id = p->string("sendId");
    s.trackId = p->string("trackId");
    s.busId = p->string("busId");
    if (p->optional("levelMilliDb") != nullptr) {
        s.level = gainParam(*p, "levelMilliDb");
    }
    if (p->optional("pre") != nullptr) {
        s.pre = p->boolean("pre");
    }
    if (p->optional("enabled") != nullptr) {
        s.enabled = p->boolean("enabled");
    }
    const bool hasIndex = p->optional("index") != nullptr;
    const std::int64_t index = hasIndex ? p->integer("index", 0, INT32_MAX) : -1;
    p.finish();
    if (doc.send(s.id) != nullptr) {
        throw CommandError("already_exists", "a send with id " + s.id + " already exists");
    }
    Track t = requireTrack(doc, s.trackId);
    requireBus(doc, s.busId);
    if (index > static_cast<std::int64_t>(t.sends.size())) {
        throw CommandError("invalid_params", "send.add: index is past the end of the track's sends");
    }
    const auto at = hasIndex ? static_cast<std::size_t>(index) : t.sends.size();
    t.sends.insert(t.sends.begin() + static_cast<std::ptrdiff_t>(at), s.id);
    const std::string id = s.id;
    const std::string trackId = t.id;
    return {{trackRef(trackId), sendRef(id)}, doc.withSend(std::move(s)).withTrack(std::move(t))};
}

Prepared sendRemove(const Document& doc, const Command& command) {
    Params p(command);
    const std::string id = p->string("sendId");
    p.finish();
    Track t = requireTrack(doc, requireSend(doc, id).trackId);
    t.sends.erase(std::remove(t.sends.begin(), t.sends.end(), id), t.sends.end());
    const std::string trackId = t.id;
    return {{trackRef(trackId), sendRef(id)}, doc.withoutSend(id).withTrack(std::move(t))};
}

// Clip fades (m5b-engine-clip-fades): {clipId, fadeIn?, fadeOut?}, at least one
// side, each {length, curve} with a decimal length >= 0 ("0" removes the side).
// A malformed side or a missing one is invalid_params; an over-long fade is the
// document's invalid_fade. One edit of the clip, so it declares clip:<id> only.
Prepared clipSetFade(const Document& doc, const Command& command) {
    return editClip(doc, command, [](Clip& c, FieldReader& r) {
        bool any = false;
        const auto side = [&r, &any](std::string_view key, model::Fade& out) {
            const json::Value* found = r.optional(key);
            if (found == nullptr) {
                return;
            }
            any = true;
            FieldReader f(*found, std::string(key));
            const std::int64_t frames = f.int64String("length");
            if (frames < 0) {
                f.fail("length", "must not be negative");
            }
            const auto curve = model::fadeCurveFromName(f.string("curve"));
            if (!curve) {
                f.fail("curve", "must be linear or equal_power");
            }
            f.finish();
            out = frames == 0 ? model::Fade{} : model::Fade{frames, *curve};
        };
        side("fadeIn", c.fadeIn);
        side("fadeOut", c.fadeOut);
        if (!any) {
            throw CommandError("invalid_params", "clip.set_fade needs fadeIn, fadeOut or both");
        }
    });
}

// clip.trim (sourceStart, length). Fades that no longer fit the new length are
// shortened in the same edit: the fade in keeps min(fadeIn, length), the fade
// out takes min(fadeOut, length - fadeIn); a side shortened to 0 is removed.
Prepared clipTrim(const Document& doc, const Command& command) {
    return editClip(doc, command, [](Clip& c, FieldReader& r) {
        c.sourceStart = r.int64String("sourceStart");
        c.length = r.int64String("length");
        if (c.length > 0 && c.fadeIn.length + c.fadeOut.length > c.length) {
            c.fadeIn.length = std::min(c.fadeIn.length, c.length);
            c.fadeOut.length = std::min(c.fadeOut.length, c.length - c.fadeIn.length);
            for (model::Fade* fade : {&c.fadeIn, &c.fadeOut}) {
                if (fade->length == 0) {
                    *fade = model::Fade{};
                }
            }
        }
    });
}

using Handler = Prepared (*)(const Document&, const Command&);

const std::map<std::string, Handler, std::less<>>& registry() {
    static const std::map<std::string, Handler, std::less<>> handlers = {
        {"bus.add", &busAdd},
        {"bus.remove", &busRemove},
        {"bus.rename",
         [](const Document& d, const Command& c) {
             return editBus(d, c, [](model::Bus& b, FieldReader& r) { b.name = nameParam(r); });
         }},
        {"bus.set_gain",
         [](const Document& d, const Command& c) {
             return editBus(d, c, [](model::Bus& b, FieldReader& r) { b.gain = gainParam(r, "gainMilliDb"); });
         }},
        {"bus.set_mute",
         [](const Document& d, const Command& c) {
             return editBus(d, c, [](model::Bus& b, FieldReader& r) { b.mute = r.boolean("mute"); });
         }},
        {"bus.set_output", &busSetOutput},
        {"bus.set_pan",
         [](const Document& d, const Command& c) {
             return editBus(d, c, [](model::Bus& b, FieldReader& r) {
                 b.pan = static_cast<std::int32_t>(r.integer("pan", INT32_MIN, INT32_MAX));
             });
         }},
        {"bus.set_solo",
         [](const Document& d, const Command& c) {
             return editBus(d, c, [](model::Bus& b, FieldReader& r) { b.solo = r.boolean("solo"); });
         }},
        {"clip.move", &clipMove},
        {"clip.place", &clipPlace},
        {"clip.remove", &clipRemove},
        {"clip.set_fade", &clipSetFade},
        {"clip.set_gain",
         [](const Document& d, const Command& c) {
             return editClip(d, c, [](Clip& clip, FieldReader& r) { clip.gain = gainParam(r, "gainMilliDb"); });
         }},
        {"clip.trim", &clipTrim},
        {"master.set_gain", &masterSetGain},
        {"media.add", &mediaAdd},
        {"media.remove", &mediaRemove},
        {"media.rename", &mediaRename},
        {"plugin.insert", &pluginInsert},
        {"plugin.remove", &pluginRemove},
        {"plugin.set_bypass", &pluginSetBypass},
        {"send.add", &sendAdd},
        {"send.remove", &sendRemove},
        {"send.set_enabled",
         [](const Document& d, const Command& c) {
             return editSend(d, c, [](model::Send& s, FieldReader& r) { s.enabled = r.boolean("enabled"); });
         }},
        {"send.set_level",
         [](const Document& d, const Command& c) {
             return editSend(d, c, [](model::Send& s, FieldReader& r) { s.level = gainParam(r, "levelMilliDb"); });
         }},
        {"send.set_pre",
         [](const Document& d, const Command& c) {
             return editSend(d, c, [](model::Send& s, FieldReader& r) { s.pre = r.boolean("pre"); });
         }},
        {"session.rename", &sessionRename},
        {"session.set_locators", &sessionSetLocators},
        {"session.set_tempo", &sessionSetTempo},
        {"track.add", &trackAdd},
        {"track.remove", &trackRemove},
        {"track.rename",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) { t.name = nameParam(r); });
         }},
        {"track.set_gain",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) { t.gain = gainParam(r, "gainMilliDb"); });
         }},
        {"track.set_input", &trackSetInput},
        {"track.set_monitor", &trackSetMonitor},
        {"track.set_output",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [&d](Track& t, FieldReader& r) { t.output = outputParam(d, r); });
         }},
        {"track.set_mute",
         [](const Document& d, const Command& c) {
             return editTrack(d, c, [](Track& t, FieldReader& r) { t.mute = r.boolean("mute"); });
         }},
        {"track.set_notes", &trackSetNotes},
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

std::map<std::string, std::vector<std::string>> commandCascades() {
    // Sorted entity type names a command may remove or change besides its
    // target (spec, Protocol v0 item 14): a bus that output to the removed bus
    // is changed; a track losing a send to it is changed.
    return {
        {"bus.remove", {"bus", "plugin_slot", "root", "send", "track"}},
        {"track.remove", {"clip", "plugin_slot", "root", "send"}},
    };
}

std::vector<std::string> commandNames() {
    std::vector<std::string> names;
    for (const auto& entry : registry()) {
        names.push_back(entry.first);
    }
    return names;
}

}  // namespace siann::command
