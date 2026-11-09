#pragma once

// The plugin installs this engine may load (m5-plugin-registry; architecture
// spec, "siann-host-api", "siann-host" and Protocol v0 item 21). A session never
// chooses what code loads: every load resolves a slot's {format, uid} here and
// opens the approved install's path, never a path the document names.
//
// Installs are keyed by {format, path}, each {uid, name, approved}. A scanned
// install has no uid (PluginHost::scan runs no plugin code); the uid is known
// once the install has been probed (scanPath), which plugin.approve does on the
// user's say-so. Only a probed install can be approved. resolve() picks among
// the approved installs of a uid: one is it; several, and the slot's path (the
// hint) chooses; none is plugin_not_approved when an unapproved install of the
// uid (or at the hint) is registered, plugin_not_registered otherwise. A hint
// the caller refused (unc_path, inside_bundle) never chooses; an unknown one is
// unregistered_path. The reason goes into the message.
//
// A header-only value type: siann-host-api holds no implementation, and reading
// and writing the --plugin-registry file lives in the engine app. Main thread,
// like everything that loads plugins.

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace siann::host {

struct PluginInstall {
    std::string format;  // "clap", "vst3", "au", "lv2"
    std::string path;    // UTF-8; the bundle, or the system's identifier for an AU
    std::optional<std::string> uid;  // known once probed
    std::string name;
    bool approved = false;
};

enum class ApproveOutcome {
    done,
    not_registered,  // no install at {format, path}
    not_probed,      // approving needs the install's uid first (setProbed)
};

struct PluginResolution {
    std::optional<PluginInstall> install;  // the install to load
    std::string code;                      // otherwise plugin_not_registered or plugin_not_approved
    std::string message;
};

class PluginRegistry {
public:
    // Two spellings of one path: separators, dot segments and, on Windows, ASCII case.
    static bool samePath(std::string_view a, std::string_view b) { return pathKey(a) == pathKey(b); }

    // A scanned install; one already there under {format, path} keeps its uid,
    // name and approval.
    const PluginInstall& addScanned(std::string format, std::string path, std::string name) {
        if (PluginInstall* known = findMutable(format, path)) {
            return *known;
        }
        PluginInstall install;
        install.format = std::move(format);
        install.path = std::move(path);
        install.name = std::move(name);
        installs_.push_back(std::move(install));
        return installs_.back();
    }

    // What a kept file says of an install: its uid, name and approval, onto the
    // scanned install at that path. False, and nothing added, for a path nothing scanned.
    bool restore(const PluginInstall& kept) {
        PluginInstall* known = findMutable(kept.format, kept.path);
        if (known == nullptr) {
            return false;
        }
        known->uid = kept.uid;
        if (!kept.name.empty()) {
            known->name = kept.name;
        }
        known->approved = kept.approved && kept.uid.has_value();
        return true;
    }

    // A probe's result. A probe that finds another uid than the one recorded
    // withdraws the approval: it was given to other code.
    bool setProbed(std::string_view format, std::string_view path, std::string uid, std::string name) {
        PluginInstall* known = findMutable(format, path);
        if (known == nullptr) {
            return false;
        }
        if (known->uid && *known->uid != uid) {
            known->approved = false;
        }
        known->uid = std::move(uid);
        known->name = std::move(name);
        return true;
    }

    ApproveOutcome approve(std::string_view format, std::string_view path, bool approved) {
        PluginInstall* known = findMutable(format, path);
        if (known == nullptr) {
            return ApproveOutcome::not_registered;
        }
        if (approved && !known->uid) {
            return ApproveOutcome::not_probed;
        }
        known->approved = approved;
        return ApproveOutcome::done;
    }

    const PluginInstall* find(std::string_view format, std::string_view path) const {
        const std::string key = pathKey(path);
        const auto found = std::find_if(installs_.begin(), installs_.end(), [&](const PluginInstall& one) {
            return one.format == format && pathKey(one.path) == key;
        });
        return found == installs_.end() ? nullptr : &*found;
    }

    // In the order they were added.
    const std::vector<PluginInstall>& installs() const noexcept { return installs_; }

    // The install a slot naming {format, uid} loads. `hint` is the slot's path;
    // `hintRefusal` is why the caller will not let it choose ("unc_path",
    // "inside_bundle"), empty when it may.
    PluginResolution resolve(std::string_view format, std::string_view uid, std::string_view hint,
                             std::string_view hintRefusal = {}) const {
        std::vector<const PluginInstall*> approved;
        bool unapproved = false;
        for (const PluginInstall& one : installs_) {
            if (one.format == format && one.uid && *one.uid == uid) {
                if (one.approved) {
                    approved.push_back(&one);
                } else {
                    unapproved = true;
                }
            }
        }
        std::string reason(hintRefusal);
        const PluginInstall* atHint = nullptr;
        if (reason.empty() && !hint.empty()) {
            atHint = find(format, hint);
            if (atHint == nullptr) {
                reason = "unregistered_path";
            }
        }
        const std::string what = std::string(format) + " plugin " + std::string(uid);
        const std::string note = reason.empty() ? std::string()
                                                : " (the slot's path was ignored: " + reason + ")";
        PluginResolution out;
        if (approved.size() == 1) {
            out.install = *approved.front();
            return out;
        }
        if (approved.size() > 1) {
            if (atHint != nullptr) {
                for (const PluginInstall* one : approved) {
                    if (one == atHint) {
                        out.install = *one;
                        return out;
                    }
                }
            }
            out.code = "plugin_not_registered";
            out.message = std::to_string(approved.size()) + " approved installs of " + what +
                          " and the slot's path names none of them (ambiguous)" + note;
            return out;
        }
        if (unapproved || (atHint != nullptr && !atHint->uid)) {
            out.code = "plugin_not_approved";
            out.message = what + " is registered but not approved; plugin.approve approves it" + note;
            return out;
        }
        out.code = "plugin_not_registered";
        out.message = "no approved install of " + what + note;
        return out;
    }

private:
    static std::string pathKey(std::string_view path) {
        const std::filesystem::path made(std::u8string(reinterpret_cast<const char8_t*>(path.data()), path.size()));
        const std::u8string normal = made.lexically_normal().generic_u8string();
        std::string key(reinterpret_cast<const char*>(normal.data()), normal.size());
#if defined(_WIN32)
        for (char& c : key) {
            if (c >= 'A' && c <= 'Z') {
                c = static_cast<char>(c - 'A' + 'a');
            }
        }
#endif
        return key;
    }

    PluginInstall* findMutable(std::string_view format, std::string_view path) {
        return const_cast<PluginInstall*>(std::as_const(*this).find(format, path));
    }

    std::vector<PluginInstall> installs_;
};

}  // namespace siann::host
