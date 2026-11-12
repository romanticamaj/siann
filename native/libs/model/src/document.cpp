#include "siann/model/document.hpp"

#include <algorithm>
#include <set>
#include <utility>

#include "siann/model/field_reader.hpp"
#include "siann/hash/jcs.hpp"
#include "siann/hash/merkle.hpp"
#include "siann/time/tempo_map.hpp"

namespace siann::model {

using json::Array;
using json::Object;
using json::Value;

ModelError::ModelError(std::string code, const std::string& message)
    : std::runtime_error(message), code_(std::move(code)) {}

std::string_view entityTypeName(EntityType type) noexcept {
    switch (type) {
        case EntityType::root: return "root";
        case EntityType::media: return "media";
        case EntityType::track: return "track";
        case EntityType::clip: return "clip";
        case EntityType::plugin_slot: return "plugin_slot";
    }
    return "unknown";
}

namespace {

constexpr std::string_view kDocumentSchema = "siann.session_document.v1";
constexpr std::string_view kRootSchema = "siann.entity.root.v1";
constexpr std::string_view kMediaSchema = "siann.entity.media.v1";
constexpr std::string_view kTrackSchema = "siann.entity.track.v1";
constexpr std::string_view kClipSchema = "siann.entity.clip.v1";
constexpr std::string_view kPluginSlotSchema = "siann.entity.plugin_slot.v1";
constexpr std::string_view kRootId = "root";

Value str(std::string_view s) {
    return Value(std::string(s));
}

Value int64String(std::int64_t v) {
    return Value(std::to_string(v));
}

Value number(std::int64_t v) {
    return Value(static_cast<double>(v));
}

// ---- entity JSON ----------------------------------------------------------

Root rootFromJson(const Value& value) {
    detail::FieldReader r(value, "root");
    r.expectSchema(kRootSchema);
    if (r.string("id") != kRootId) {
        r.fail("id", "must be \"root\"");
    }
    Root root;
    root.name = r.string("name");
    root.sampleRate = r.integer("sampleRate", 0, INT32_MAX);
    const Value& tempo = r.require("tempo");
    if (tempo.kind() != Value::Kind::array) {
        r.fail("tempo", "must be an array");
    }
    root.tempo.clear();
    for (const Value& point : tempo.asArray()) {
        detail::FieldReader p(point, "root.tempo[]");
        time::TempoPoint tp;
        tp.position = time::MusicTime{p.int64String("ticks")};
        tp.milliBpm = static_cast<std::int32_t>(p.integer("milliBpm", INT32_MIN, INT32_MAX));
        p.finish();
        root.tempo.push_back(tp);
    }
    const Value& order = r.require("trackOrder");
    if (order.kind() != Value::Kind::array) {
        r.fail("trackOrder", "must be an array");
    }
    for (const Value& id : order.asArray()) {
        if (id.kind() != Value::Kind::string) {
            r.fail("trackOrder", "must contain strings");
        }
        root.trackOrder.push_back(id.asString());
    }
    r.finish();
    return root;
}

Media mediaFromJson(const Value& value) {
    detail::FieldReader r(value, "media");
    r.expectSchema(kMediaSchema);
    Media m;
    m.id = r.string("id");
    m.contentHash = r.digest("contentHash");
    if (r.optional("originalHash") != nullptr) {
        m.originalHash = r.digest("originalHash");
    }
    const std::string format = r.string("format");
    if (format == "wav") {
        m.format = MediaFormat::wav;
    } else if (format == "flac") {
        m.format = MediaFormat::flac;
    } else {
        r.fail("format", "must be wav or flac");
    }
    m.channels = static_cast<std::int32_t>(r.integer("channels", INT32_MIN, INT32_MAX));
    m.sampleRate = r.integer("sampleRate", 0, INT32_MAX);
    m.frames = r.int64String("frames");
    r.finish();
    return m;
}

Track trackFromJson(const Value& value) {
    detail::FieldReader r(value, "track");
    r.expectSchema(kTrackSchema);
    Track t;
    t.id = r.string("id");
    t.name = r.string("name");
    if (r.string("kind") != "audio") {
        r.fail("kind", "must be audio");
    }
    t.channels = static_cast<std::int32_t>(r.integer("channels", INT32_MIN, INT32_MAX));
    t.gain = Gain{static_cast<std::int32_t>(r.integer("gainMilliDb", INT32_MIN, INT32_MAX))};
    t.pan = static_cast<std::int32_t>(r.integer("pan", INT32_MIN, INT32_MAX));
    t.mute = r.boolean("mute");
    t.solo = r.boolean("solo");
    if (const Value* inserts = r.optional("inserts")) {
        if (inserts->kind() != Value::Kind::array) {
            r.fail("inserts", "must be an array");
        }
        for (const Value& id : inserts->asArray()) {
            if (id.kind() != Value::Kind::string) {
                r.fail("inserts", "must contain strings");
            }
            t.inserts.push_back(id.asString());
        }
    }
    r.finish();
    return t;
}

PluginSlot pluginSlotFromJson(const Value& value) {
    detail::FieldReader r(value, "plugin_slot");
    r.expectSchema(kPluginSlotSchema);
    PluginSlot p;
    p.id = r.string("id");
    p.trackId = r.string("trackId");
    p.format = r.string("format");
    p.uid = r.string("uid");
    p.name = r.string("name");
    p.path = r.string("path");
    const Value& blob = r.require("stateBlob");
    if (blob.kind() == Value::Kind::string) {
        p.stateBlob = blob.asString();
    } else if (blob.kind() != Value::Kind::null) {
        r.fail("stateBlob", "must be a string or null");
    }
    p.bypass = r.boolean("bypass");
    r.finish();
    return p;
}

Clip clipFromJson(const Value& value) {
    detail::FieldReader r(value, "clip");
    r.expectSchema(kClipSchema);
    Clip c;
    c.id = r.string("id");
    c.trackId = r.string("trackId");
    c.mediaId = r.string("mediaId");
    {
        detail::FieldReader p(r.require("position"), "clip.position");
        const std::string domain = p.string("domain");
        const std::int64_t at = p.int64String("value");
        if (domain == "audio") {
            c.position = time::Position::audio(at);
        } else if (domain == "music") {
            c.position = time::Position::music(at);
        } else {
            p.fail("domain", "must be audio or music");
        }
        p.finish();
    }
    c.sourceStart = r.int64String("sourceStart");
    c.length = r.int64String("length");
    c.gain = Gain{static_cast<std::int32_t>(r.integer("gainMilliDb", INT32_MIN, INT32_MAX))};
    r.finish();
    return c;
}

// ---- tables ---------------------------------------------------------------

template <typename T>
StoredPtr<T> makeStored(T value) {
    const hash::Digest digest = hash::sha256(jcs::canonicalize(toJson(value)));
    return std::make_shared<const Stored<T>>(Stored<T>{std::move(value), digest});
}

template <typename T>
using TableVec = std::vector<StoredPtr<T>>;

template <typename T>
auto lowerBound(const TableVec<T>& table, std::string_view id) {
    return std::lower_bound(table.begin(), table.end(), id,
                            [](const StoredPtr<T>& item, std::string_view key) { return item->value.id < key; });
}

template <typename T>
const Stored<T>* findStored(const TableVec<T>& table, std::string_view id) noexcept {
    const auto it = lowerBound<T>(table, id);
    return it != table.end() && (*it)->value.id == id ? it->get() : nullptr;
}

template <typename T>
std::shared_ptr<const TableVec<T>> upsert(const TableVec<T>& table, T value) {
    auto copy = std::make_shared<TableVec<T>>(table);
    const std::string id = value.id;
    auto it = std::lower_bound(copy->begin(), copy->end(), id,
                               [](const StoredPtr<T>& item, const std::string& key) { return item->value.id < key; });
    StoredPtr<T> stored = makeStored(std::move(value));
    if (it != copy->end() && (*it)->value.id == id) {
        *it = std::move(stored);
    } else {
        copy->insert(it, std::move(stored));
    }
    return copy;
}

template <typename T>
std::shared_ptr<const TableVec<T>> remove(const TableVec<T>& table, std::string_view id) {
    auto copy = std::make_shared<TableVec<T>>(table);
    const auto it = lowerBound<T>(*copy, id);
    if (it == copy->end() || (*it)->value.id != id) {
        throw ModelError("unknown_entity", "no entity with id " + std::string(id));
    }
    copy->erase(it);
    return copy;
}

template <typename T>
void diffTables(EntityType type, const TableVec<T>& before, const TableVec<T>& after, std::vector<DiffEntry>& out) {
    std::size_t i = 0;
    std::size_t j = 0;
    while (i < before.size() || j < after.size()) {
        if (j == after.size() || (i < before.size() && before[i]->value.id < after[j]->value.id)) {
            out.push_back({DiffEntry::Change::removed, {type, before[i]->value.id}});
            ++i;
        } else if (i == before.size() || after[j]->value.id < before[i]->value.id) {
            out.push_back({DiffEntry::Change::added, {type, after[j]->value.id}});
            ++j;
        } else {
            if (before[i] != after[j] && before[i]->hash != after[j]->hash) {
                out.push_back({DiffEntry::Change::modified, {type, after[j]->value.id}});
            }
            ++i;
            ++j;
        }
    }
}

template <typename T>
void collectLeaves(EntityType type, const TableVec<T>& table, std::vector<hash::EntityLeaf>& leaves) {
    for (const auto& item : table) {
        leaves.push_back({std::string(entityTypeName(type)), item->value.id, item->hash});
    }
}

template <typename T>
std::shared_ptr<const TableVec<T>> tableFromJson(const Value& doc, std::string_view key, T (*parse)(const Value&),
                                                 bool optional = false) {
    const Value* array = doc.find(key);
    if (array == nullptr && optional) {
        return std::make_shared<const TableVec<T>>();
    }
    if (array == nullptr || array->kind() != Value::Kind::array) {
        throw ModelError("missing_field", "document." + std::string(key) + " must be an array");
    }
    auto table = std::make_shared<TableVec<T>>();
    for (const Value& item : array->asArray()) {
        table->push_back(makeStored(parse(item)));
    }
    std::sort(table->begin(), table->end(),
              [](const StoredPtr<T>& a, const StoredPtr<T>& b) { return a->value.id < b->value.id; });
    for (std::size_t i = 1; i < table->size(); ++i) {
        if ((*table)[i - 1]->value.id == (*table)[i]->value.id) {
            throw ModelError("duplicate_entity", "duplicate " + std::string(key) + " id " + (*table)[i]->value.id);
        }
    }
    return table;
}

template <typename T>
Value tableToJson(const TableVec<T>& table) {
    Array items;
    items.reserve(table.size());
    for (const auto& item : table) {
        items.push_back(toJson(item->value));
    }
    return Value(std::move(items));
}

void issue(std::vector<ValidationIssue>& out, std::string code, EntityType type, std::string id, std::string message) {
    out.push_back({std::move(code), {type, std::move(id)}, std::move(message)});
}

bool validRate(std::int64_t rate) {
    return rate >= time::kMinSampleRate && rate <= time::kMaxSampleRate;
}

bool validPosition(std::int64_t value) {
    return value >= -time::kMaxPositionMagnitude && value <= time::kMaxPositionMagnitude;
}

}  // namespace

// ---- entity JSON (public) -------------------------------------------------

Value toJson(const Root& root) {
    Array tempo;
    for (const auto& point : root.tempo) {
        tempo.push_back(Value(Object{{"ticks", int64String(point.position.ticks)}, {"milliBpm", number(point.milliBpm)}}));
    }
    Array order;
    for (const auto& id : root.trackOrder) {
        order.push_back(Value(id));
    }
    return Value(Object{
        {"schema", str(kRootSchema)},
        {"id", str(kRootId)},
        {"name", Value(root.name)},
        {"sampleRate", number(root.sampleRate)},
        {"tempo", Value(std::move(tempo))},
        {"trackOrder", Value(std::move(order))},
    });
}

Value toJson(const Media& media) {
    Object out{
        {"schema", str(kMediaSchema)},
        {"id", Value(media.id)},
        {"contentHash", Value(hash::formatHash(media.contentHash))},
        {"format", str(media.format == MediaFormat::wav ? "wav" : "flac")},
        {"channels", number(media.channels)},
        {"sampleRate", number(media.sampleRate)},
        {"frames", int64String(media.frames)},
    };
    if (media.originalHash) {
        out.emplace_back("originalHash", Value(hash::formatHash(*media.originalHash)));
    }
    return Value(std::move(out));
}

Value toJson(const Track& track) {
    Object out{
        {"schema", str(kTrackSchema)},
        {"id", Value(track.id)},
        {"name", Value(track.name)},
        {"kind", str("audio")},
        {"channels", number(track.channels)},
        {"gainMilliDb", number(track.gain.milliDb)},
        {"pan", number(track.pan)},
        {"mute", Value(track.mute)},
        {"solo", Value(track.solo)},
    };
    // Omitted when empty: a track without inserts keeps its M1 hash.
    if (!track.inserts.empty()) {
        Array inserts;
        for (const auto& id : track.inserts) {
            inserts.push_back(Value(id));
        }
        out.emplace_back("inserts", Value(std::move(inserts)));
    }
    return Value(std::move(out));
}

Value toJson(const PluginSlot& slot) {
    return Value(Object{
        {"schema", str(kPluginSlotSchema)},
        {"id", Value(slot.id)},
        {"trackId", Value(slot.trackId)},
        {"format", Value(slot.format)},
        {"uid", Value(slot.uid)},
        {"name", Value(slot.name)},
        {"path", Value(slot.path)},
        {"stateBlob", slot.stateBlob ? Value(*slot.stateBlob) : Value()},
        {"bypass", Value(slot.bypass)},
    });
}

bool isStateBlobHash(std::string_view text) noexcept {
    constexpr std::string_view prefix = "sha256:";
    if (text.size() != prefix.size() + 64 || text.substr(0, prefix.size()) != prefix) {
        return false;
    }
    return std::all_of(text.begin() + static_cast<std::ptrdiff_t>(prefix.size()), text.end(),
                       [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

namespace {

bool isSeparator(char c) noexcept {
    return c == '/' || c == '\\';
}

std::filesystem::path pathFromUtf8(std::string_view text) {
    return std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(text.data()), text.size()));
}

// The path's components, made absolute and weakly canonical, compared as Windows
// compares names (ASCII case-insensitively) there.
std::vector<std::filesystem::path::string_type> components(const std::filesystem::path& path) {
    std::error_code ignored;
    std::filesystem::path made = std::filesystem::weakly_canonical(path, ignored);
    if (made.empty()) {
        made = std::filesystem::absolute(path, ignored).lexically_normal();
    }
    std::vector<std::filesystem::path::string_type> out;
    for (const auto& part : made.lexically_normal()) {
        auto name = part.native();
        if (name.empty()) {
            continue;  // the trailing separator's empty name
        }
#if defined(_WIN32)
        for (auto& c : name) {
            if (c >= L'A' && c <= L'Z') {
                c = static_cast<wchar_t>(c - L'A' + L'a');
            }
            if (c == L'/') {
                c = L'\\';
            }
        }
#endif
        out.push_back(std::move(name));
    }
    return out;
}

// A share or a Windows device namespace, whichever separators it mixes: two
// leading separators (\\server\share, \\?\UNC\..., \\?\C:\..., \\.\pipe\...),
// the NT object namespace (\??\...), and on Windows any root name that is not
// a drive letter and a drive-relative device prefix (\.\..., \?\...).
bool isShareOrDevicePath(std::string_view path) {
    if (path.size() >= 2 && isSeparator(path[0]) && isSeparator(path[1])) {
        return true;
    }
    if (path.size() >= 4 && isSeparator(path[0]) && path[1] == '?' && path[2] == '?' && isSeparator(path[3])) {
        return true;
    }
#if defined(_WIN32)
    const std::wstring root = pathFromUtf8(path).root_name().native();
    const bool drive = root.size() == 2 && root[1] == L':' &&
                       ((root[0] >= L'A' && root[0] <= L'Z') || (root[0] >= L'a' && root[0] <= L'z'));
    if (!root.empty() && !drive) {
        return true;
    }
    // One leading separator, then a segment of dots or question marks (\.\pipe,
    // \?\C:, \..\x): a device prefix with a separator missing, which resolves on
    // the current drive. A rooted path of another platform (/Library/...) stays.
    if (!path.empty() && isSeparator(path[0])) {
        const std::size_t end = path.find_first_of("\\/", 1);
        const std::string_view first = path.substr(1, end == std::string_view::npos ? std::string_view::npos : end - 1);
        if (!first.empty() && first.find_first_not_of(".?") == std::string_view::npos) {
            return true;
        }
    }
#endif
    return false;
}

}  // namespace

std::optional<std::string> pluginPathRefusal(std::string_view path,
                                             const std::optional<std::filesystem::path>& bundle) {
    if (path.empty()) {
        return std::nullopt;
    }
    if (isShareOrDevicePath(path)) {
        return std::string("unc_path");
    }
    if (bundle && !bundle->empty()) {
        const auto inside = components(*bundle);
        const auto candidate = components(pathFromUtf8(path));
        if (!inside.empty() && candidate.size() >= inside.size() &&
            std::equal(inside.begin(), inside.end(), candidate.begin())) {
            return std::string("inside_bundle");
        }
    }
    return std::nullopt;
}

Value toJson(const Clip& clip) {
    return Value(Object{
        {"schema", str(kClipSchema)},
        {"id", Value(clip.id)},
        {"trackId", Value(clip.trackId)},
        {"mediaId", Value(clip.mediaId)},
        {"position", Value(Object{{"domain", str(clip.position.domain == time::Domain::audio ? "audio" : "music")},
                                  {"value", int64String(clip.position.value)}})},
        {"sourceStart", int64String(clip.sourceStart)},
        {"length", int64String(clip.length)},
        {"gainMilliDb", number(clip.gain.milliDb)},
    });
}

// ---- Document -------------------------------------------------------------

Document Document::create(std::string name, std::int64_t sampleRate, std::int32_t milliBpm) {
    Root root;
    root.name = std::move(name);
    root.sampleRate = sampleRate;
    root.tempo = {time::TempoPoint{time::MusicTime{0}, milliBpm}};
    Document doc;
    doc.root_ = makeStored(std::move(root));
    doc.media_ = std::make_shared<const TableVec<Media>>();
    doc.tracks_ = std::make_shared<const TableVec<Track>>();
    doc.clips_ = std::make_shared<const TableVec<Clip>>();
    doc.slots_ = std::make_shared<const TableVec<PluginSlot>>();
    const auto issues = doc.validate();
    if (!issues.empty()) {
        throw ModelError("invalid_document", issues.front().message);
    }
    return doc;
}

Document Document::fromJson(const Value& value) {
    detail::FieldReader r(value, "document");
    const std::string version = r.string("schemaVersion");
    if (version != kDocumentSchema) {
        throw ModelError("unsupported_version", "document schemaVersion " + version + " is not supported");
    }
    r.require("root");
    r.require("media");
    r.require("tracks");
    r.require("clips");
    (void)r.optional("pluginSlots");
    r.finish();

    Document doc;
    doc.root_ = makeStored(rootFromJson(*value.find("root")));
    doc.media_ = tableFromJson<Media>(value, "media", &mediaFromJson);
    doc.tracks_ = tableFromJson<Track>(value, "tracks", &trackFromJson);
    doc.clips_ = tableFromJson<Clip>(value, "clips", &clipFromJson);
    doc.slots_ = tableFromJson<PluginSlot>(value, "pluginSlots", &pluginSlotFromJson, true);
    const auto issues = doc.validate();
    if (!issues.empty()) {
        throw ModelError("invalid_document", issues.front().code + ": " + issues.front().message);
    }
    return doc;
}

Value Document::toJson() const {
    Object out{
        {"schemaVersion", str(kDocumentSchema)},
        {"root", model::toJson(root_->value)},
        {"media", tableToJson(*media_)},
        {"tracks", tableToJson(*tracks_)},
        {"clips", tableToJson(*clips_)},
    };
    // Omitted when empty, like Track.inserts, so M1 to M3 documents read the same.
    if (!slots_->empty()) {
        out.emplace_back("pluginSlots", tableToJson(*slots_));
    }
    return Value(std::move(out));
}

const PluginSlot* Document::pluginSlot(std::string_view id) const noexcept {
    const auto* s = findStored(*slots_, id);
    return s ? &s->value : nullptr;
}

std::vector<const PluginSlot*> Document::slotsOnTrack(std::string_view trackId) const {
    std::vector<const PluginSlot*> out;
    if (const Track* t = track(trackId)) {
        for (const auto& id : t->inserts) {
            if (const PluginSlot* p = pluginSlot(id)) {
                out.push_back(p);
            }
        }
    }
    return out;
}

std::vector<const PluginSlot*> Document::allPluginSlots() const {
    std::vector<const PluginSlot*> out;
    for (const auto& item : *slots_) {
        out.push_back(&item->value);
    }
    return out;
}

Document Document::withPluginSlot(PluginSlot slot) const {
    Document doc = *this;
    doc.slots_ = upsert(*slots_, std::move(slot));
    return doc;
}

Document Document::withoutPluginSlot(std::string_view id) const {
    Document doc = *this;
    doc.slots_ = remove(*slots_, id);
    return doc;
}

const Media* Document::media(std::string_view id) const noexcept {
    const auto* s = findStored(*media_, id);
    return s ? &s->value : nullptr;
}

const Track* Document::track(std::string_view id) const noexcept {
    const auto* s = findStored(*tracks_, id);
    return s ? &s->value : nullptr;
}

const Clip* Document::clip(std::string_view id) const noexcept {
    const auto* s = findStored(*clips_, id);
    return s ? &s->value : nullptr;
}

std::vector<const Media*> Document::allMedia() const {
    std::vector<const Media*> out;
    for (const auto& item : *media_) {
        out.push_back(&item->value);
    }
    return out;
}

std::vector<const Track*> Document::tracksInOrder() const {
    std::vector<const Track*> out;
    for (const auto& id : root().trackOrder) {
        if (const Track* t = track(id)) {
            out.push_back(t);
        }
    }
    return out;
}

std::vector<const Clip*> Document::clipsOnTrack(std::string_view trackId) const {
    std::vector<const Clip*> out;
    for (const auto& item : *clips_) {
        if (item->value.trackId == trackId) {
            out.push_back(&item->value);
        }
    }
    return out;
}

Document Document::withRoot(Root root) const {
    Document doc = *this;
    doc.root_ = makeStored(std::move(root));
    return doc;
}

Document Document::withMedia(Media media) const {
    Document doc = *this;
    doc.media_ = upsert(*media_, std::move(media));
    return doc;
}

Document Document::withTrack(Track track) const {
    Document doc = *this;
    doc.tracks_ = upsert(*tracks_, std::move(track));
    return doc;
}

Document Document::withClip(Clip clip) const {
    Document doc = *this;
    doc.clips_ = upsert(*clips_, std::move(clip));
    return doc;
}

Document Document::withoutMedia(std::string_view id) const {
    Document doc = *this;
    doc.media_ = remove(*media_, id);
    return doc;
}

Document Document::withoutTrack(std::string_view id) const {
    Document doc = *this;
    doc.tracks_ = remove(*tracks_, id);
    return doc;
}

Document Document::withoutClip(std::string_view id) const {
    Document doc = *this;
    doc.clips_ = remove(*clips_, id);
    return doc;
}

std::vector<ValidationIssue> Document::validate() const {
    std::vector<ValidationIssue> out;
    const Root& r = root();
    const std::string rootId(kRootId);

    if (!validRate(r.sampleRate)) {
        issue(out, "invalid_sample_rate", EntityType::root, rootId, "session sample rate is out of range");
    }
    try {
        time::TempoMap map(r.tempo);
    } catch (const time::TimeError& error) {
        issue(out, "invalid_tempo", EntityType::root, rootId, error.what());
    }
    {
        std::set<std::string, std::less<>> listed;
        bool mismatch = false;
        for (const auto& id : r.trackOrder) {
            if (!listed.insert(id).second || track(id) == nullptr) {
                mismatch = true;
            }
        }
        if (listed.size() != tracks_->size()) {
            mismatch = true;
        }
        if (mismatch) {
            issue(out, "track_order_mismatch", EntityType::root, rootId,
                  "trackOrder must list every track exactly once");
        }
    }

    for (const auto& item : *media_) {
        const Media& m = item->value;
        if (!hash::isValidEntityId(m.id)) {
            issue(out, "invalid_id", EntityType::media, m.id, "invalid media id");
        }
        if (m.channels < 1 || m.channels > 32) {
            issue(out, "invalid_channels", EntityType::media, m.id, "media channels must be 1 to 32");
        }
        if (m.sampleRate != r.sampleRate) {
            issue(out, "media_rate_mismatch", EntityType::media, m.id, "media must be at the session sample rate");
        }
        if (m.frames < 0) {
            issue(out, "invalid_frames", EntityType::media, m.id, "media frames must not be negative");
        }
    }

    for (const auto& item : *tracks_) {
        const Track& t = item->value;
        if (!hash::isValidEntityId(t.id)) {
            issue(out, "invalid_id", EntityType::track, t.id, "invalid track id");
        }
        if (t.channels < 1 || t.channels > 2) {
            issue(out, "invalid_channels", EntityType::track, t.id, "track channels must be 1 or 2");
        }
        if (!t.gain.isValid()) {
            issue(out, "invalid_gain", EntityType::track, t.id, "track gain is out of range");
        }
        if (t.pan < kPanMin || t.pan > kPanMax) {
            issue(out, "invalid_pan", EntityType::track, t.id, "track pan is out of range");
        }
    }

    for (const auto& item : *clips_) {
        const Clip& c = item->value;
        if (!hash::isValidEntityId(c.id)) {
            issue(out, "invalid_id", EntityType::clip, c.id, "invalid clip id");
        }
        if (track(c.trackId) == nullptr) {
            issue(out, "unknown_track", EntityType::clip, c.id, "clip references a missing track");
        }
        const Media* m = media(c.mediaId);
        if (m == nullptr) {
            issue(out, "unknown_media", EntityType::clip, c.id, "clip references missing media");
        }
        if (!validPosition(c.position.value)) {
            issue(out, "position_out_of_range", EntityType::clip, c.id, "clip position is out of range");
        }
        if (c.sourceStart < 0) {
            issue(out, "invalid_source_start", EntityType::clip, c.id, "clip sourceStart must not be negative");
        }
        if (c.length <= 0) {
            issue(out, "invalid_clip_length", EntityType::clip, c.id, "clip length must be positive");
        } else if (m != nullptr && c.sourceStart >= 0 && c.sourceStart > m->frames - c.length) {
            issue(out, "clip_exceeds_media", EntityType::clip, c.id, "clip extends past the end of its media");
        }
        if (!c.gain.isValid()) {
            issue(out, "invalid_gain", EntityType::clip, c.id, "clip gain is out of range");
        }
    }

    // Every id in a track's inserts names a slot of that track, once.
    for (const auto& item : *tracks_) {
        const Track& t = item->value;
        std::set<std::string_view> seen;
        for (const auto& id : t.inserts) {
            const PluginSlot* p = pluginSlot(id);
            if (p == nullptr || p->trackId != t.id || !seen.insert(id).second) {
                issue(out, "insert_mismatch", EntityType::track, t.id,
                      "track inserts must list each of its plugin slots exactly once");
                break;
            }
        }
    }
    for (const auto& item : *slots_) {
        const PluginSlot& p = item->value;
        if (!hash::isValidEntityId(p.id)) {
            issue(out, "invalid_id", EntityType::plugin_slot, p.id, "invalid plugin slot id");
        }
        const Track* owner = track(p.trackId);
        if (owner == nullptr) {
            issue(out, "unknown_track", EntityType::plugin_slot, p.id, "plugin slot references a missing track");
        } else if (std::find(owner->inserts.begin(), owner->inserts.end(), p.id) == owner->inserts.end()) {
            issue(out, "insert_mismatch", EntityType::plugin_slot, p.id, "the slot's track does not list it in inserts");
        }
        if (p.format != "clap" && p.format != "vst3" && p.format != "au" && p.format != "lv2") {
            issue(out, "invalid_format", EntityType::plugin_slot, p.id, "plugin format must be clap, vst3, au or lv2");
        }
        if (p.stateBlob && !isStateBlobHash(*p.stateBlob)) {
            issue(out, "invalid_state_blob", EntityType::plugin_slot, p.id,
                  "stateBlob must be null or sha256:<64 lowercase hex>");
        }
    }
    return out;
}

hash::Digest Document::entityHash(const EntityRef& ref) const {
    const std::optional<hash::Digest> found = findEntityHash(ref);
    if (!found) {
        throw ModelError("unknown_entity",
                         "no " + std::string(entityTypeName(ref.type)) + " with id " + ref.id);
    }
    return *found;
}

std::optional<hash::Digest> Document::findEntityHash(const EntityRef& ref) const noexcept {
    const hash::Digest* found = nullptr;
    switch (ref.type) {
        case EntityType::root:
            if (ref.id == kRootId) {
                found = &root_->hash;
            }
            break;
        case EntityType::media:
            if (const auto* s = findStored(*media_, ref.id)) found = &s->hash;
            break;
        case EntityType::track:
            if (const auto* s = findStored(*tracks_, ref.id)) found = &s->hash;
            break;
        case EntityType::clip:
            if (const auto* s = findStored(*clips_, ref.id)) found = &s->hash;
            break;
        case EntityType::plugin_slot:
            if (const auto* s = findStored(*slots_, ref.id)) found = &s->hash;
            break;
    }
    if (found == nullptr) {
        return std::nullopt;
    }
    return *found;
}

hash::Digest Document::documentHash() const {
    std::vector<hash::EntityLeaf> leaves;
    leaves.reserve(1 + media_->size() + tracks_->size() + clips_->size() + slots_->size());
    leaves.push_back({"root", std::string(kRootId), root_->hash});
    collectLeaves(EntityType::media, *media_, leaves);
    collectLeaves(EntityType::track, *tracks_, leaves);
    collectLeaves(EntityType::clip, *clips_, leaves);
    collectLeaves(EntityType::plugin_slot, *slots_, leaves);
    try {
        return hash::documentHash(std::move(leaves));
    } catch (const hash::DocumentHashError& error) {
        throw ModelError(error.code(), error.what());
    }
}

bool Document::sharesEntity(const Document& other, const EntityRef& ref) const noexcept {
    switch (ref.type) {
        case EntityType::root:
            return root_ == other.root_;
        case EntityType::media: {
            const auto* a = findStored(*media_, ref.id);
            return a != nullptr && a == findStored(*other.media_, ref.id);
        }
        case EntityType::track: {
            const auto* a = findStored(*tracks_, ref.id);
            return a != nullptr && a == findStored(*other.tracks_, ref.id);
        }
        case EntityType::clip: {
            const auto* a = findStored(*clips_, ref.id);
            return a != nullptr && a == findStored(*other.clips_, ref.id);
        }
        case EntityType::plugin_slot: {
            const auto* a = findStored(*slots_, ref.id);
            return a != nullptr && a == findStored(*other.slots_, ref.id);
        }
    }
    return false;
}

std::vector<DiffEntry> diff(const Document& before, const Document& after) {
    std::vector<DiffEntry> out;
    if (before.root_ != after.root_ && before.root_->hash != after.root_->hash) {
        out.push_back({DiffEntry::Change::modified, {EntityType::root, std::string(kRootId)}});
    }
    diffTables(EntityType::media, *before.media_, *after.media_, out);
    diffTables(EntityType::track, *before.tracks_, *after.tracks_, out);
    diffTables(EntityType::clip, *before.clips_, *after.clips_, out);
    diffTables(EntityType::plugin_slot, *before.slots_, *after.slots_, out);
    return out;
}

}  // namespace siann::model
