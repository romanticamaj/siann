// The realtime path and the control surface are separate interfaces (spec,
// "siann-host-api"): code holding a PluginInstance, as the audio thread does, has
// no editor, parameter, state or sink call to make by mistake.

#include <catch2/catch_test_macros.hpp>

#include <concepts>
#include <cstdint>
#include <utility>
#include <vector>

#include "siann/host/interfaces.hpp"

using namespace siann::host;

namespace {

template <typename T>
concept HasControlCalls = requires(T& plugin, const std::vector<std::uint8_t>& blob) {
    plugin.openEditor(EditorOwner{});
    plugin.closeEditor();
    plugin.editorOpen();
    plugin.editorNativeHandle();
    plugin.parameters();
    plugin.getParameter(0);
    plugin.setParameter(0, 0.0);
    plugin.setEventSink(nullptr);
    plugin.getState();
    plugin.setState(blob);
};

template <typename T>
concept HasAnyControlCall = requires(T& plugin) { plugin.openEditor(EditorOwner{}); } ||
                            requires(T& plugin) { plugin.closeEditor(); } ||
                            requires(T& plugin) { plugin.editorOpen(); } ||
                            requires(T& plugin) { plugin.editorNativeHandle(); } ||
                            requires(T& plugin) { plugin.parameters(); } ||
                            requires(T& plugin) { plugin.getParameter(0); } ||
                            requires(T& plugin) { plugin.setParameter(0, 0.0); } ||
                            requires(T& plugin) { plugin.setEventSink(nullptr); } ||
                            requires(T& plugin) { plugin.getState(); };

template <typename T>
concept HasProcess = requires(T& plugin, const AudioBufferView& view) { plugin.process(view, view, EventList{}); };

}  // namespace

TEST_CASE("control-only plugin calls live apart from process", "[host]") {
    STATIC_REQUIRE(HasProcess<PluginInstance>);
    STATIC_REQUIRE_FALSE(HasAnyControlCall<PluginInstance>);
    STATIC_REQUIRE(HasControlCalls<PluginControl>);
    STATIC_REQUIRE_FALSE(HasProcess<PluginControl>);
    STATIC_REQUIRE(std::same_as<decltype(std::declval<PluginInstance&>().control()), PluginControl&>);
}
