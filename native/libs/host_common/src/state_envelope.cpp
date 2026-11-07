#include "siann/host/state_envelope.hpp"

#include <cstddef>
#include <cstring>
#include <iterator>
#include <limits>

#include "siann/host/plugin_error.hpp"

namespace siann::host {

namespace {

constexpr char stateMagic[8] = {'S', 'I', 'A', 'N', 'N', 'P', 'S', '1'};
constexpr std::uint32_t stateVersion = 1;

template <typename T>
void appendLittleEndian(std::vector<std::uint8_t>& out, T value) {
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        out.push_back(static_cast<std::uint8_t>((value >> (8 * i)) & 0xff));
    }
}

template <typename T>
bool readLittleEndian(std::span<const std::uint8_t> in, std::size_t& position, T& value) {
    if (in.size() - position < sizeof(T)) {
        return false;
    }
    value = 0;
    for (std::size_t i = 0; i < sizeof(T); ++i) {
        value = static_cast<T>(value | (static_cast<T>(in[position + i]) << (8 * i)));
    }
    position += sizeof(T);
    return true;
}

}  // namespace

std::vector<std::uint8_t> wrapPluginState(const std::string& uid, std::span<const std::uint8_t> payload) {
    std::vector<std::uint8_t> state(std::begin(stateMagic), std::end(stateMagic));
    state.reserve(state.size() + uid.size() + payload.size() + 16);
    appendLittleEndian<std::uint32_t>(state, stateVersion);
    appendLittleEndian<std::uint32_t>(state, static_cast<std::uint32_t>(uid.size()));
    state.insert(state.end(), uid.begin(), uid.end());
    appendLittleEndian<std::uint64_t>(state, payload.size());
    state.insert(state.end(), payload.begin(), payload.end());
    return state;
}

std::span<const std::uint8_t> unwrapPluginState(std::span<const std::uint8_t> state, const std::string& uid) {
    std::size_t position = sizeof(stateMagic);
    if (state.size() < position || std::memcmp(state.data(), stateMagic, sizeof(stateMagic)) != 0) {
        throw PluginError("bad_state", "not a SIANN plugin state blob");
    }
    std::uint32_t version = 0;
    if (!readLittleEndian(state, position, version) || version != stateVersion) {
        throw PluginError("bad_state", "unknown plugin state version");
    }
    std::uint32_t uidSize = 0;
    if (!readLittleEndian(state, position, uidSize) || state.size() - position < uidSize) {
        throw PluginError("bad_state", "truncated plugin state");
    }
    const std::string found(state.begin() + static_cast<std::ptrdiff_t>(position),
                            state.begin() + static_cast<std::ptrdiff_t>(position + uidSize));
    if (found != uid) {
        throw PluginError("bad_state", "the state belongs to another plugin: " + found);
    }
    position += uidSize;
    std::uint64_t payloadSize = 0;
    if (!readLittleEndian(state, position, payloadSize) || state.size() - position != payloadSize ||
        payloadSize > static_cast<std::uint64_t>(std::numeric_limits<int>::max())) {
        throw PluginError("bad_state", "truncated plugin state");
    }
    return state.subspan(position);
}

}  // namespace siann::host
