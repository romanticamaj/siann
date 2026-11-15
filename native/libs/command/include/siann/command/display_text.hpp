#pragma once

// The display-text rules live in the model (siann/model/display_text.hpp), which
// refuses unsafe names in the document; the plan checks use them from here.
#include "siann/model/display_text.hpp"

namespace siann::command {

using model::isControl;
using model::isDisplaySafeName;
using model::isDisplayUnsafe;
using model::TextFault;
using model::textFault;
using model::withoutUnsafeCharacters;

}  // namespace siann::command
