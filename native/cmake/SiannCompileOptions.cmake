# Shared warning and conformance flags for SIANN native targets.
function(siann_apply_compile_options target)
  if(WIN32)
    # windows.h, pulled in by some dependencies, must not define min/max macros.
    target_compile_definitions(${target} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
  endif()
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /permissive- /utf-8 /Zc:__cplusplus /Zc:preprocessor
      /wd4324)  # C4324: padding added by alignas, which is the intent
    if(SIANN_WERROR)
      target_compile_options(${target} PRIVATE /WX)
    endif()
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -Wshadow)
    # No fused multiply-add contraction: `t += a * g` must round the product,
    # as MSVC's /fp:precise does, or PDC nulls leave a residual on FMA targets
    # (Apple arm64 clang contracts by default) and offline/realtime parity
    # would depend on the compiler.
    target_compile_options(${target} PRIVATE -ffp-contract=off)
    if(SIANN_WERROR)
      target_compile_options(${target} PRIVATE -Werror)
    endif()
  endif()
endfunction()
