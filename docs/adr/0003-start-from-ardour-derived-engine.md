# ADR-0003: Start From An Ardour-Derived Engine

Date: 2026-07-06

Status: Superseded by [ADR-0016: Build A Native C++ DAW Engine From Scratch](0016-build-native-cpp-daw-engine.md)

## Context

The audio engine is the credibility layer for audio engineers. Bounce correctness, routing, plugin hosting, automation, timing, and session recall matter more than AI novelty.

OpenStudio has a modern JUCE/React shape and existing AI experiments, but its audio engine is younger. Ardour is a mature open-source DAW with a long-standing audio/session engine and GPL-compatible licensing.

## Decision

Start SIANN from an Ardour-derived engine path.

Use Ardour as the local audio/session foundation and preserve its render, routing, plugin, automation, and session behavior during the early phases.

## Consequences

The first work must prove Ardour commandability rather than immediately replacing the UI.

GPL/open-source constraints are accepted.

Upstream contribution policy needs special care because Ardour's development guidance around AI-generated code may affect whether SIANN changes can be upstreamed.

