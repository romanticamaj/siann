#pragma once

// SessionDocument: an immutable value with structural sharing. Each edit
// returns a new document that shares every unchanged entity with the old one.
// Entity hashes are computed once, when an entity enters a document.

#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/json.hpp"
#include "siann/hash/sha256.hpp"
#include "siann/model/entities.hpp"

namespace siann::model {

enum class EntityType { root, media, track, clip };

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

    // Parses and validates a siann.session_document.v1 JSON value. Unknown
    // fields and versions are rejected.
    static Document fromJson(const json::Value& value);
    json::Value toJson() const;

    const Root& root() const noexcept { return root_->value; }
    const Media* media(std::string_view id) const noexcept;
    const Track* track(std::string_view id) const noexcept;
    const Clip* clip(std::string_view id) const noexcept;

    std::vector<const Media*> allMedia() const;
    std::vector<const Track*> tracksInOrder() const;
    std::vector<const Clip*> clipsOnTrack(std::string_view trackId) const;
    std::size_t clipCount() const noexcept { return clips_->size(); }

    // Each returns a new document. with* inserts or replaces by id.
    Document withRoot(Root root) const;
    Document withMedia(Media media) const;
    Document withTrack(Track track) const;
    Document withClip(Clip clip) const;
    Document withoutMedia(std::string_view id) const;
    Document withoutTrack(std::string_view id) const;
    Document withoutClip(std::string_view id) const;

    // Structural and referential checks; empty means valid.
    std::vector<ValidationIssue> validate() const;

    hash::Digest entityHash(const EntityRef& ref) const;
    hash::Digest documentHash() const;

    // True when both documents hold the same stored entity object (shared).
    bool sharesEntity(const Document& other, const EntityRef& ref) const noexcept;

    // Entities that differ between two documents, sorted by (type, id).
    friend std::vector<DiffEntry> diff(const Document& before, const Document& after);

private:
    template <typename T>
    using Table = std::shared_ptr<const std::vector<StoredPtr<T>>>;

    Document() = default;

    StoredPtr<Root> root_;
    Table<Media> media_;
    Table<Track> tracks_;
    Table<Clip> clips_;
};

std::vector<DiffEntry> diff(const Document& before, const Document& after);

// JSON forms of single entities, as hashed.
json::Value toJson(const Root& root);
json::Value toJson(const Media& media);
json::Value toJson(const Track& track);
json::Value toJson(const Clip& clip);

}  // namespace siann::model
