# Fails when SIANN code on a hosted plugin's process path names a lock
# (architecture spec, "Realtime rules and enforcement"; m4-plugin-node). Run as
#   cmake -DFILES=<file>|<file>... -P SiannNoLocks.cmake
# Every line of every file is checked, comments included, so a lock cannot hide
# behind a helper defined in the same file.
if(NOT DEFINED FILES OR FILES STREQUAL "")
  message(FATAL_ERROR "SiannNoLocks: pass -DFILES=<file>|<file>...")
endif()

string(REPLACE "|" ";" files "${FILES}")
set(pattern "std::mutex|lock_guard|unique_lock|CriticalSection|ScopedLock|SpinLock|MessageManagerLock")
set(found "")
foreach(file IN LISTS files)
  if(NOT EXISTS "${file}")
    message(FATAL_ERROR "SiannNoLocks: ${file} does not exist")
  endif()
  # Only the matching lines come back.
  file(STRINGS "${file}" hits REGEX "${pattern}")
  if(hits)
    string(APPEND found "${file}:\n")
    foreach(hit IN LISTS hits)
      string(APPEND found "  ${hit}\n")
    endforeach()
  endif()
endforeach()

if(NOT found STREQUAL "")
  message(FATAL_ERROR "SiannNoLocks: a lock is named on the plugin process path:\n${found}")
endif()
message(STATUS "SiannNoLocks: no lock named in ${FILES}")
