#pragma once

// Commands are pure document transforms (architecture spec, "siann-command").
// A command is JSON: {"op": "<name>", ...params}. It addresses entities by ID
// only. Preparing a command validates it against a document and returns the
// effects it declares plus the resulting document; the processor then checks
// that the actual diff is a subset of the declared effects.

#include <cstddef>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "siann/hash/json.hpp"
#include "siann/model/document.hpp"

namespace siann::command {

class CommandError : public std::runtime_error {
public:
    CommandError(std::string code, const std::string& message, std::size_t step = 0);

    // Stable codes: unknown_command, invalid_params, not_found,
    // already_exists, media_in_use, undeclared_effect, empty_transaction,
    // nothing_to_undo, nothing_to_redo, or a model validation code such as
    // clip_exceeds_media or invalid_gain.
    const std::string& code() const noexcept { return code_; }
    // Index of the failing command inside a transaction.
    std::size_t step() const noexcept { return step_; }

private:
    std::string code_;
    std::size_t step_;
};

struct Command {
    json::Value json;  // the full command object, including "op"

    static Command fromJson(json::Value value);
    std::string_view op() const;
};

using DeclaredEffects = std::set<model::EntityRef>;

struct Prepared {
    DeclaredEffects effects;
    model::Document result;
};

// Validates and applies one command. Throws CommandError.
Prepared prepare(const model::Document& document, const Command& command);

// Applies commands in order as one transaction. Each step must leave a valid
// document, and the transaction's diff must be covered by the union of the
// declared effects. Throws CommandError with the failing step index.
Prepared prepareTransaction(const model::Document& document, const std::vector<Command>& commands);

// Throws undeclared_effect if the diff from before to after touches an entity
// outside the declared effects.
void checkDeclaredEffects(const model::Document& before, const model::Document& after,
                          const DeclaredEffects& declared);

// Names of all registered commands, sorted.
std::vector<std::string> commandNames();

}  // namespace siann::command
