#pragma once

// SessionDocument: an immutable value with structural sharing. Each edit
// returns a new document that shares every unchanged entity with the old one.
// Entity hashes are computed once, when an entity enters a document.

#include <filesystem>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/entities.hpp"

namespace siann::model {

enum class EntityType { root, media, track, clip, plugin_slot, locators, master, bus, send, marker };

std::string_view entityTypeName(EntityType type) noexcept;

struct EntityRef {
    EntityType type = EntityType::root;
    std::string id;

    friend auto operator<=>(const EntityRef&, const EntityRef&) = default;
};

struct ValidationIssue {
    std::string code;
    EntityRef entity;
    std::string message;
};

class ModelError : public std::runtime_error {
public:
    ModelError(std::string code, const std::string& message);
    const std::string& code() const noexcept { return code_; }

private:
    std::string code_;
};

template <typename T>
struct Stored {
    T value;
    hash::Digest hash{};
};

template <typename T>
using StoredPtr = std::shared_ptr<const Stored<T>>;

struct DiffEntry {
    enum class Change { added, removed, modified };
    Change change = Change::modified;
    EntityRef entity;
};

class Document {
public:
    // An empty session with one constant tempo.
    static Document create(std::string name, std::int64_t sampleRate, std::int32_t milliBpm = 120'000);

    // Parses and validates a siann.session_document.v4 JSON value, or a v1, v2
    // or v3 one through a migration that adds nothing (v1 has no locators and
    // no master; v1 and v2 have no buses, sends, busOrder, Track.sends,
    // Track.output or slot busId; v1 to v3 have no markers; an earlier
    // document that carries a later version's entity or field is rejected as
    // unknown_field). Unknown fields and versions are rejected.
    // toJson always writes v4.
    static Document fromJson(const json::Value& value);
    json::Value toJson() const;

    const Root& root() const noexcept { return root_->value; }
    const Media* media(std::string_view id) const noexcept;
    const Track* track(std::string_view id) const noexcept;
    const Clip* clip(std::string_view id) const noexcept;
    const PluginSlot* pluginSlot(std::string_view id) const noexcept;
    // The singleton locators entity, or null while none is set.
    const Locators* locators() const noexcept;
    // The singleton master entity, or null while the master gain is 0 dB.
    const Master* master() const noexcept;
    const Bus* bus(std::string_view id) const noexcept;
    const Send* send(std::string_view id) const noexcept;
    const Marker* marker(std::string_view id) const noexcept;

    std::vector<const Media*> allMedia() const;
    std::vector<const Track*> tracksInOrder() const;
    std::vector<const Clip*> clipsOnTrack(std::string_view trackId) const;
    // In the track's inserts order; ids that name no slot are skipped.
    std::vector<const PluginSlot*> slotsOnTrack(std::string_view trackId) const;
    std::vector<const PluginSlot*> allPluginSlots() const;
    // In the bus's inserts order; ids that name no slot are skipped.
    std::vector<const PluginSlot*> slotsOnBus(std::string_view busId) const;
    // In root.busOrder; ids that name no bus are skipped.
    std::vector<const Bus*> busesInOrder() const;
    std::vector<const Bus*> allBuses() const;
    // In the track's sends order; ids that name no send are skipped.
    std::vector<const Send*> sendsOnTrack(std::string_view trackId) const;
    std::vector<const Send*> allSends() const;
    // In id order.
    std::vector<const Marker*> allMarkers() const;
    std::size_t clipCount() const noexcept { return clips_->size(); }

    // Each returns a new document. with* inserts or replaces by id.
    Document withRoot(Root root) const;
    Document withMedia(Media media) const;
    Document withTrack(Track track) const;
    Document withClip(Clip clip) const;
    Document withPluginSlot(PluginSlot slot) const;
    Document withoutMedia(std::string_view id) const;
    Document withoutTrack(std::string_view id) const;
    Document withoutClip(std::string_view id) const;
    Document withoutPluginSlot(std::string_view id) const;
    Document withBus(Bus bus) const;
    Document withoutBus(std::string_view id) const;
    Document withSend(Send send) const;
    Document withoutSend(std::string_view id) const;
    Document withMarker(Marker value) const;
    Document withoutMarker(std::string_view id) const;
    Document withLocators(Locators value) const;
    // Throws ModelError unknown_entity when no locators are set.
    Document withoutLocators() const;
    // Stores the master as given; a master at 0 dB is not a valid document
    // (validate), so master.set_gain 0 removes it instead.
    Document withMaster(Master value) const;
    // Throws ModelError unknown_entity when no master is set.
    Document withoutMaster() const;

    // Structural and referential checks; empty means valid.
    std::vector<ValidationIssue> validate() const;

    // Throws ModelError unknown_entity when the entity is absent.
    hash::Digest entityHash(const EntityRef& ref) const;
    // The entity hash, or nothing when the entity is absent.
    std::optional<hash::Digest> findEntityHash(const EntityRef& ref) const noexcept;
    hash::Digest documentHash() const;

    // True when both documents hold the same stored entity object (shared).
    bool sharesEntity(const Document& other, const EntityRef& ref) const noexcept;

    // Entities that differ between two documents, sorted by (type, id).
    friend std::vector<DiffEntry> diff(const Document& before, const Document& after);

private:
    template <typename T>
    using Table = std::shared_ptr<const std::vector<StoredPtr<T>>>;

    Document() = default;
    void validateRouting(std::vector<ValidationIssue>& out) const;
    void validateMarkers(std::vector<ValidationIssue>& out) const;

    StoredPtr<Root> root_;
    Table<Media> media_;
    Table<Track> tracks_;
    Table<Clip> clips_;
    Table<PluginSlot> slots_;
    StoredPtr<Locators> locators_;  // null while absent
    StoredPtr<Master> master_;      // null while absent (0 dB)
    Table<Bus> buses_;
    Table<Send> sends_;
    Table<Marker> markers_;
};

std::vector<DiffEntry> diff(const Document& before, const Document& after);

// JSON forms of single entities, as hashed.
json::Value toJson(const Root& root);
json::Value toJson(const Media& media);
json::Value toJson(const Track& track);
json::Value toJson(const Clip& clip);
json::Value toJson(const PluginSlot& slot);
json::Value toJson(const Locators& value);
json::Value toJson(const Master& value);
json::Value toJson(const Bus& bus);
json::Value toJson(const Send& send);
json::Value toJson(const Marker& value);

// The locators entity's id, the only one it has.
inline constexpr std::string_view kLocatorsId = "locators";
// The master entity's id, the only one it has (ref master:master).
inline constexpr std::string_view kMasterId = "master";

// True for "sha256:" followed by 64 lowercase hex digits.
bool isStateBlobHash(std::string_view text) noexcept;

// Why a plugin path (UTF-8) must not be opened, or nothing (m5-plugin-registry,
// Protocol v0 item 21): "unc_path" for a share or a device path, whichever
// separators it mixes: one that starts with two separators (\\server\share,
// //server/share, \\?\UNC\..., \\?\C:\..., \\.\pipe\...), one in the NT object
// namespace (\??\...), and on Windows one whose root name is not a drive letter
// or that has one leading separator and then a segment of dots or question marks
// (\.\pipe\..., \?\C:\..., \..\...: drive-relative, a device prefix misspelt);
// "inside_bundle" for one at or under `bundle` (both made
// weakly_canonical; case-insensitive on Windows). An empty path is no hint and
// is never refused.
std::optional<std::string> pluginPathRefusal(std::string_view path,
                                             const std::optional<std::filesystem::path>& bundle = std::nullopt);

}  // namespace siann::model
